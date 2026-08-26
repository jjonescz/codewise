import { fromBinary } from "@bufbuild/protobuf";
import {
  IndexSchema,
  SymbolRole,
  type Index,
  type Occurrence,
  type SymbolInformation
} from "@scip-code/scip";
import { ScipIndexError } from "./errors.js";
import { normalizeRelativePath } from "./paths.js";
import {
  compareContainingRanges,
  comparePositions,
  compareRanges,
  containsPosition,
  decodeOccurrenceRange
} from "./ranges.js";
import type {
  ScipHover,
  ScipLocation,
  ScipPosition,
  ScipRange,
  ScipValidationReport
} from "./types.js";

interface IndexedOccurrence {
  readonly relativePath: string;
  readonly range: ScipRange;
  readonly symbol: string;
  readonly symbolRoles: number;
  readonly overrideDocumentation: readonly string[];
}

function isDefinition(occurrence: IndexedOccurrence): boolean {
  return (occurrence.symbolRoles & SymbolRole.Definition) !== 0;
}

function locationKey(occurrence: IndexedOccurrence): string {
  const { start, end } = occurrence.range;
  return `${occurrence.relativePath}\0${start.line}:${start.character}-${end.line}:${end.character}`;
}

function compareIndexedOccurrences(left: IndexedOccurrence, right: IndexedOccurrence): number {
  return (
    left.relativePath.localeCompare(right.relativePath)
    || compareRanges(left.range, right.range)
    || left.symbol.localeCompare(right.symbol)
  );
}

function uniqueLocations(occurrences: readonly IndexedOccurrence[]): ScipLocation[] {
  const seen = new Set<string>();
  const locations: ScipLocation[] = [];

  for (const occurrence of [...occurrences].sort(compareIndexedOccurrences)) {
    const key = locationKey(occurrence);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    locations.push({
      relativePath: occurrence.relativePath,
      range: occurrence.range
    });
  }

  return locations;
}

export class ScipIndex {
  readonly #documents = new Map<string, readonly IndexedOccurrence[]>();
  readonly #definitions = new Map<string, readonly IndexedOccurrence[]>();
  readonly #occurrences = new Map<string, readonly IndexedOccurrence[]>();
  readonly #symbolInformation = new Map<string, SymbolInformation>();
  readonly #report: ScipValidationReport;

  public static fromBytes(bytes: Uint8Array): ScipIndex {
    let decoded: Index;
    try {
      decoded = fromBinary(IndexSchema, bytes);
    } catch (error) {
      throw new ScipIndexError("Failed to decode the SCIP protobuf.", { cause: error });
    }

    return new ScipIndex(decoded);
  }

  public constructor(index: Index) {
    const definitions = new Map<string, IndexedOccurrence[]>();
    const occurrences = new Map<string, IndexedOccurrence[]>();
    const seenPaths = new Set<string>();
    let occurrenceCount = 0;
    let definitionCount = 0;
    let backslashPathCount = 0;

    for (const externalSymbol of index.externalSymbols) {
      if (externalSymbol.symbol !== "" && !this.#symbolInformation.has(externalSymbol.symbol)) {
        this.#symbolInformation.set(externalSymbol.symbol, externalSymbol);
      }
    }

    for (const document of index.documents) {
      if (document.relativePath.includes("\\")) {
        backslashPathCount++;
      }

      const relativePath = normalizeRelativePath(document.relativePath);
      if (seenPaths.has(relativePath)) {
        throw new ScipIndexError(`Duplicate SCIP document path: ${relativePath}`);
      }
      seenPaths.add(relativePath);

      for (const symbol of document.symbols) {
        if (symbol.symbol !== "") {
          this.#symbolInformation.set(symbol.symbol, symbol);
        }
      }

      const documentOccurrences: IndexedOccurrence[] = [];
      for (const occurrence of document.occurrences) {
        let range: ScipRange;
        try {
          range = decodeOccurrenceRange(occurrence);
        } catch (error) {
          throw new ScipIndexError(
            `Invalid occurrence range in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }

        occurrenceCount++;
        const indexedOccurrence: IndexedOccurrence = {
          relativePath,
          range,
          symbol: occurrence.symbol,
          symbolRoles: occurrence.symbolRoles,
          overrideDocumentation: occurrence.overrideDocumentation
        };
        documentOccurrences.push(indexedOccurrence);

        if (occurrence.symbol === "") {
          continue;
        }

        const symbolOccurrences = occurrences.get(occurrence.symbol) ?? [];
        symbolOccurrences.push(indexedOccurrence);
        occurrences.set(occurrence.symbol, symbolOccurrences);

        if (isDefinition(indexedOccurrence)) {
          definitionCount++;
          const symbolDefinitions = definitions.get(occurrence.symbol) ?? [];
          symbolDefinitions.push(indexedOccurrence);
          definitions.set(occurrence.symbol, symbolDefinitions);
        }
      }

      documentOccurrences.sort((left, right) => (
        comparePositions(left.range.start, right.range.start)
        || compareContainingRanges(left.range, right.range)
      ));
      this.#documents.set(relativePath, documentOccurrences);
    }

    if (this.#documents.size === 0) {
      throw new ScipIndexError("SCIP index contains no documents.");
    }

    for (const [symbol, values] of definitions) {
      this.#definitions.set(symbol, values);
    }
    for (const [symbol, values] of occurrences) {
      this.#occurrences.set(symbol, values);
    }

    let unresolvedOccurrenceCount = 0;
    for (const [symbol, values] of occurrences) {
      if (!definitions.has(symbol)) {
        unresolvedOccurrenceCount += values.length;
      }
    }

    let ambiguousSymbolCount = 0;
    for (const values of definitions.values()) {
      if (uniqueLocations(values).length > 1) {
        ambiguousSymbolCount++;
      }
    }

    const warnings: string[] = [];
    if (backslashPathCount > 0) {
      warnings.push(
        `${backslashPathCount} document path(s) used backslashes and were normalized.`
      );
    }
    if (ambiguousSymbolCount > 0) {
      warnings.push(`${ambiguousSymbolCount} symbol(s) have multiple definition locations.`);
    }
    if (unresolvedOccurrenceCount > 0) {
      warnings.push(
        `${unresolvedOccurrenceCount} occurrence(s) reference symbols without indexed definitions.`
      );
    }
    if (index.externalSymbols.length === 0) {
      warnings.push("The index contains no external symbol information.");
    }

    this.#report = {
      statistics: {
        documentCount: this.#documents.size,
        occurrenceCount,
        definitionCount,
        externalSymbolCount: index.externalSymbols.length,
        unresolvedOccurrenceCount,
        ambiguousSymbolCount
      },
      warnings
    };
  }

  public get validationReport(): ScipValidationReport {
    return this.#report;
  }

  public definition(relativePath: string, position: ScipPosition): readonly ScipLocation[] {
    const occurrence = this.#findOccurrence(relativePath, position);
    if (occurrence === undefined || occurrence.symbol === "") {
      return [];
    }

    return uniqueLocations(this.#definitions.get(occurrence.symbol) ?? []);
  }

  public references(
    relativePath: string,
    position: ScipPosition,
    includeDeclaration: boolean
  ): readonly ScipLocation[] {
    const occurrence = this.#findOccurrence(relativePath, position);
    if (occurrence === undefined || occurrence.symbol === "") {
      return [];
    }

    const values = this.#occurrences.get(occurrence.symbol) ?? [];
    return uniqueLocations(
      includeDeclaration ? values : values.filter((value) => !isDefinition(value))
    );
  }

  public hover(relativePath: string, position: ScipPosition): ScipHover | undefined {
    const occurrence = this.#findOccurrence(relativePath, position);
    if (occurrence === undefined || occurrence.symbol === "") {
      return undefined;
    }

    const symbolInformation = this.#symbolInformation.get(occurrence.symbol);
    const documentation = occurrence.overrideDocumentation.length > 0
      ? occurrence.overrideDocumentation
      : (symbolInformation?.documentation ?? []);
    const signature = symbolInformation?.signatureDocumentation?.text;

    if ((signature === undefined || signature === "") && documentation.length === 0) {
      return undefined;
    }

    const hover: {
      range: ScipRange;
      signature?: string;
      signatureLanguage?: string;
      documentation: readonly string[];
    } = {
      range: occurrence.range,
      documentation
    };

    if (signature !== undefined && signature !== "") {
      hover.signature = signature;
      const signatureLanguage = symbolInformation?.signatureDocumentation?.language;
      if (signatureLanguage !== undefined && signatureLanguage !== "") {
        hover.signatureLanguage = signatureLanguage;
      }
    }

    return hover;
  }

  #findOccurrence(
    relativePath: string,
    position: ScipPosition
  ): IndexedOccurrence | undefined {
    const normalizedPath = normalizeRelativePath(relativePath);
    const occurrences = this.#documents.get(normalizedPath);
    if (occurrences === undefined) {
      return undefined;
    }

    let best: IndexedOccurrence | undefined;
    for (const occurrence of occurrences) {
      if (comparePositions(occurrence.range.start, position) > 0) {
        break;
      }
      if (!containsPosition(occurrence.range, position)) {
        continue;
      }
      if (
        best === undefined
        || compareContainingRanges(occurrence.range, best.range) < 0
      ) {
        best = occurrence;
      }
    }

    return best;
  }
}

export function occurrenceHasDefinitionRole(occurrence: Occurrence): boolean {
  return (occurrence.symbolRoles & SymbolRole.Definition) !== 0;
}

