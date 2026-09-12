import {
  CodeIndexValidationError,
  validateIndexDatabase
} from "./schema.js";
import type {
  IndexHover,
  IndexLocation,
  IndexPosition,
  IndexRange,
  IndexStatistics,
  SqlDatabase,
  SqlRow
} from "./types.js";

export class CodeIndex {
  readonly #database: SqlDatabase;
  readonly #hasSymbolGraph: boolean;

  public constructor(database: SqlDatabase) {
    this.#database = database;
    validateIndexDatabase(database);
    this.#hasSymbolGraph = database.all(`
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'occurrence_symbols'
    `).length > 0;
  }

  public get statistics(): IndexStatistics {
    return {
      documentCount: this.#count("documents"),
      occurrenceCount: this.#count("occurrences"),
      completedAnswerCount: this.#count(
        "occurrence_answers",
        "status = 'complete'"
      ),
      answerLocationCount: this.#count("answer_locations"),
      completedHoverCount: this.#completedHoverCount()
    };
  }

  public definition(
    relativePath: string,
    position: IndexPosition
  ): readonly IndexLocation[] {
    const occurrenceId = this.#findOccurrenceId(relativePath, position);
    if (occurrenceId === undefined) {
      return [];
    }
    const graphLocations = this.#symbolDefinitions(occurrenceId);
    return graphLocations === undefined || graphLocations.length === 0
      ? this.#answerLocations(occurrenceId, "definition")
      : graphLocations;
  }

  public references(
    relativePath: string,
    position: IndexPosition,
    includeDeclaration: boolean
  ): readonly IndexLocation[] {
    const occurrenceId = this.#findOccurrenceId(relativePath, position);
    if (occurrenceId === undefined) {
      return [];
    }
    const graphLocations = this.#symbolReferences(
      occurrenceId,
      includeDeclaration
    );
    if (graphLocations !== undefined) {
      return graphLocations;
    }
    const locations = this.#answerLocations(occurrenceId, "references");
    if (includeDeclaration) {
      return locations;
    }

    const declarationKeys = new Set(
      [
        ...this.#answerLocations(occurrenceId, "definition"),
        ...this.#answerLocations(occurrenceId, "declaration")
      ].map(locationKey)
    );
    return locations.filter((location) => !declarationKeys.has(locationKey(location)));
  }

  public hover(
    relativePath: string,
    position: IndexPosition
  ): IndexHover | undefined {
    const key = positionKey(position);
    const row = this.#database.all(`
      SELECT
        hover.contents_json,
        hover.start_line,
        hover.start_character,
        hover.end_line,
        hover.end_character
      FROM occurrences AS occurrence
      JOIN documents AS document ON document.id = occurrence.document_id
      JOIN hover_results AS hover ON hover.occurrence_id = occurrence.id
      WHERE document.relative_path = ?
        AND occurrence.start_key <= ?
        AND occurrence.end_key > ?
        AND hover.status = 'complete'
      ORDER BY occurrence.end_key - occurrence.start_key, occurrence.id
      LIMIT 1
    `, [normalizeRelativePath(relativePath), key, key])[0];
    if (row === undefined) {
      return this.#symbolHover(relativePath, position);
    }
    if (row["contents_json"] === null) {
      return this.#symbolHover(relativePath, position);
    }

    const contentsJson = requiredString(row, "contents_json");
    let contents: unknown;
    try {
      contents = JSON.parse(contentsJson);
    } catch (error) {
      throw new CodeIndexValidationError(
        "The index contains invalid hover JSON.",
        { cause: error }
      );
    }

    const startLine = optionalNumber(row, "start_line");
    if (startLine === undefined) {
      return { contents };
    }
    return {
      contents,
      range: {
        start: {
          line: startLine,
          character: requiredNumber(row, "start_character")
        },
        end: {
          line: requiredNumber(row, "end_line"),
          character: requiredNumber(row, "end_character")
        }
      }
    };
  }

  public close(): void {
    this.#database.close();
  }

  #symbolDefinitions(
    occurrenceId: number
  ): readonly IndexLocation[] | undefined {
    if (!this.#hasSymbolGraph || !this.#hasSymbol(occurrenceId)) {
      return undefined;
    }
    return this.#database.all(`
      SELECT
        target.relative_path,
        definition.uri,
        definition.start_line,
        definition.start_character,
        definition.end_line,
        definition.end_character
      FROM occurrence_symbols AS edge
      JOIN symbol_definitions AS definition
        ON definition.symbol_id = edge.symbol_id
      LEFT JOIN documents AS target ON target.uri = definition.uri
      WHERE edge.occurrence_id = ?
      ORDER BY definition.ordinal
    `, [occurrenceId]).map(locationFromRow);
  }

  #symbolReferences(
    occurrenceId: number,
    includeDeclaration: boolean
  ): readonly IndexLocation[] | undefined {
    if (!this.#hasSymbolGraph || !this.#hasSymbol(occurrenceId)) {
      return undefined;
    }
    return this.#database.all(`
      WITH source_symbol AS (
        SELECT symbol_id
        FROM occurrence_symbols
        WHERE occurrence_id = ?
      )
      SELECT * FROM (
        SELECT
          document.relative_path,
          document.uri,
          occurrence.start_line,
          occurrence.start_character,
          occurrence.end_line,
          occurrence.end_character
        FROM source_symbol
        JOIN occurrence_symbols AS edge
          ON edge.symbol_id = source_symbol.symbol_id
        JOIN occurrences AS occurrence ON occurrence.id = edge.occurrence_id
        JOIN documents AS document ON document.id = occurrence.document_id
        WHERE ? = 1 OR edge.is_definition = 0
        UNION
        SELECT
          document.relative_path,
          definition.uri,
          definition.start_line,
          definition.start_character,
          definition.end_line,
          definition.end_character
        FROM source_symbol
        JOIN symbol_definitions AS definition
          ON definition.symbol_id = source_symbol.symbol_id
        LEFT JOIN documents AS document ON document.uri = definition.uri
        WHERE ? = 1
      )
      ORDER BY
        relative_path,
        uri,
        start_line,
        start_character,
        end_line,
        end_character
    `, [
      occurrenceId,
      includeDeclaration ? 1 : 0,
      includeDeclaration ? 1 : 0
    ]).map(locationFromRow);
  }

  #hasSymbol(occurrenceId: number): boolean {
    return this.#database.all(`
      SELECT 1 FROM occurrence_symbols WHERE occurrence_id = ?
    `, [occurrenceId]).length > 0;
  }

  #symbolHover(
    relativePath: string,
    position: IndexPosition
  ): IndexHover | undefined {
    if (!this.#hasSymbolGraph) {
      return undefined;
    }
    const key = positionKey(position);
    const row = this.#database.all(`
      SELECT
        symbol.display_name,
        occurrence.start_line,
        occurrence.start_character,
        occurrence.end_line,
        occurrence.end_character
      FROM occurrence_symbols AS edge
      JOIN symbols AS symbol ON symbol.id = edge.symbol_id
      JOIN occurrences AS occurrence ON occurrence.id = edge.occurrence_id
      JOIN documents AS document ON document.id = occurrence.document_id
      WHERE document.relative_path = ?
        AND occurrence.start_key <= ?
        AND occurrence.end_key > ?
        AND symbol.display_name IS NOT NULL
        AND symbol.display_name <> ''
      ORDER BY occurrence.end_key - occurrence.start_key, occurrence.id
      LIMIT 1
    `, [normalizeRelativePath(relativePath), key, key])[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      contents: {
        kind: "plaintext",
        value: requiredString(row, "display_name")
      },
      range: {
        start: {
          line: requiredNumber(row, "start_line"),
          character: requiredNumber(row, "start_character")
        },
        end: {
          line: requiredNumber(row, "end_line"),
          character: requiredNumber(row, "end_character")
        }
      }
    };
  }

  #completedHoverCount(): number {
    if (!this.#hasSymbolGraph) {
      return this.#count("hover_results", "status = 'complete'");
    }
    const value = this.#database.all(`
      SELECT COUNT(*) AS count
      FROM occurrences AS occurrence
      WHERE EXISTS (
        SELECT 1
        FROM hover_results AS hover
        WHERE hover.occurrence_id = occurrence.id
          AND hover.status = 'complete'
      )
      OR EXISTS (
        SELECT 1
        FROM occurrence_symbols AS edge
        JOIN symbols AS symbol ON symbol.id = edge.symbol_id
        WHERE edge.occurrence_id = occurrence.id
          AND symbol.display_name IS NOT NULL
          AND symbol.display_name <> ''
      )
    `)[0]?.["count"];
    if (typeof value !== "number") {
      throw new CodeIndexValidationError(
        "The index returned an invalid completed hover count."
      );
    }
    return value;
  }

  #findOccurrenceId(
    relativePath: string,
    position: IndexPosition
  ): number | undefined {
    const key = positionKey(position);
    const value = this.#database.all(`
      SELECT occurrence.id
      FROM occurrences AS occurrence
      JOIN documents AS document ON document.id = occurrence.document_id
      WHERE document.relative_path = ?
        AND occurrence.start_key <= ?
        AND occurrence.end_key > ?
      ORDER BY occurrence.end_key - occurrence.start_key, occurrence.id
      LIMIT 1
    `, [normalizeRelativePath(relativePath), key, key])[0]?.["id"];
    return typeof value === "number" ? value : undefined;
  }

  #answerLocations(
    occurrenceId: number,
    kind: "declaration" | "definition" | "references"
  ): readonly IndexLocation[] {
    return this.#database.all(`
      SELECT
        target.relative_path,
        location.uri,
        location.start_line,
        location.start_character,
        location.end_line,
        location.end_character
      FROM occurrence_answers AS answer
      JOIN answer_locations AS location
        ON location.answer_set_id = answer.answer_set_id
      LEFT JOIN documents AS target ON target.uri = location.uri
      WHERE answer.occurrence_id = ?
        AND answer.kind = ?
        AND answer.status = 'complete'
      ORDER BY location.ordinal
    `, [occurrenceId, kind]).map(locationFromRow);
  }

  #count(table: string, condition?: string): number {
    const value = this.#database.all(
      `SELECT COUNT(*) AS count FROM ${table}${
        condition === undefined ? "" : ` WHERE ${condition}`
      }`
    )[0]?.["count"];
    if (typeof value !== "number") {
      throw new CodeIndexValidationError(
        `The index returned an invalid ${table} count.`
      );
    }
    return value;
  }
}

function locationFromRow(row: SqlRow): IndexLocation {
  const relativePath = optionalString(row, "relative_path");
  const uri = requiredString(row, "uri");
  const range: IndexRange = {
    start: {
      line: requiredNumber(row, "start_line"),
      character: requiredNumber(row, "start_character")
    },
    end: {
      line: requiredNumber(row, "end_line"),
      character: requiredNumber(row, "end_character")
    }
  };
  return relativePath === undefined
    ? { uri, range }
    : { relativePath, range };
}

function locationKey(location: IndexLocation): string {
  return [
    location.relativePath ?? location.uri ?? "",
    location.range.start.line,
    location.range.start.character,
    location.range.end.line,
    location.range.end.character
  ].join("\0");
}

function requiredString(row: SqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new CodeIndexValidationError(`Invalid ${name} value in index.`);
  }
  return value;
}

function optionalString(row: SqlRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CodeIndexValidationError(`Invalid ${name} value in index.`);
  }
  return value;
}

function requiredNumber(row: SqlRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CodeIndexValidationError(`Invalid ${name} value in index.`);
  }
  return value;
}

function optionalNumber(row: SqlRow, name: string): number | undefined {
  const value = row[name];
  return value === null || value === undefined
    ? undefined
    : requiredNumber(row, name);
}

function positionKey(position: IndexPosition): number {
  return position.line * 0x1_0000_0000 + position.character;
}

export function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//u.test(normalized)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
    || normalized.split("/").some(
      (component) => component === "" || component === "." || component === ".."
    )
  ) {
    throw new CodeIndexValidationError(
      `Index document path must be canonical and relative: ${path}`
    );
  }
  return normalized;
}
