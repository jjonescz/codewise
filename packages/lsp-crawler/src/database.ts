import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  createIndexSchemaSql,
  createSymbolGraphSchemaSql,
  validateIndexDatabase,
  type IndexStatistics,
  type SqlDatabase,
  type SqlRow,
  type SqlValue
} from "@codewise/index-core";
import type { Hover, Location, PositionEncoding, Range } from "./lsp-types.js";

export type LocationAnswerKind =
  | "declaration"
  | "definition"
  | "highlights"
  | "references";

export interface DocumentInput {
  readonly uri: string;
  readonly relativePath: string;
  readonly languageId: string;
  readonly contentHash: string;
  readonly positionEncoding: PositionEncoding;
}

export interface DocumentRecord extends DocumentInput {
  readonly id: number;
}

export interface OccurrenceInput {
  readonly documentId: number;
  readonly range: Range;
  readonly discoverySource:
    | "document-symbol"
    | "lexical"
    | "semantic-token";
  readonly semanticTokenType?: string;
  readonly semanticModifiers?: number;
}

export interface OccurrenceRecord {
  readonly id: number;
  readonly documentId: number;
  readonly range: Range;
}

export interface SharedLocationAnswerInput {
  readonly occurrenceIds: readonly number[];
  readonly kind: LocationAnswerKind;
  readonly locations: readonly Location[];
}

export interface SymbolGraphInput {
  readonly providerKey: string;
  readonly displayName?: string;
  readonly occurrences: readonly SymbolGraphOccurrenceInput[];
  readonly definitions: readonly Location[];
}

export interface SymbolGraphOccurrenceInput {
  readonly occurrenceId: number;
  readonly isDefinition: boolean;
}

interface RowWithId {
  readonly id: number;
}

interface OccurrenceRow {
  readonly id: number;
  readonly document_id: number;
  readonly start_line: number;
  readonly start_character: number;
  readonly end_line: number;
  readonly end_character: number;
}

interface AnswerSetRow {
  readonly answer_set_id: number | null;
}

interface LocationRow {
  readonly uri: string;
  readonly start_line: number;
  readonly start_character: number;
  readonly end_line: number;
  readonly end_character: number;
}

interface CurrentDocumentRow {
  readonly id: number;
  readonly uri: string;
  readonly relative_path: string;
  readonly language_id: string;
  readonly content_hash: string;
  readonly position_encoding: PositionEncoding;
}

export class CrawlerDatabase {
  readonly #database: DatabaseSync;

  public constructor(path: string) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.#database = new DatabaseSync(absolutePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000
    });
    this.#database.exec(`
      PRAGMA trusted_schema = OFF;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      ${createIndexSchemaSql}
    `);
    validateIndexDatabase(new NodeSqlDatabase(this.#database, false));
  }

  public close(): void {
    this.#database.close();
  }

  public setMetadata(key: string, value: string): void {
    this.#database.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  public synchronizeDocuments(inputs: readonly DocumentInput[]): void {
    const currentRows = this.#database.prepare(`
      SELECT id, uri, relative_path, language_id, content_hash, position_encoding
      FROM documents
    `).all() as unknown as CurrentDocumentRow[];
    const currentByUri = new Map(currentRows.map((row) => [row.uri, row]));
    const inputUris = new Set(inputs.map((input) => input.uri));
    const changedDocumentIds = new Set<number>();
    let invalidateAnswers = currentRows.some((row) => !inputUris.has(row.uri));

    for (const input of inputs) {
      const current = currentByUri.get(input.uri);
      if (current === undefined) {
        invalidateAnswers = currentRows.length > 0;
      } else if (
        current.relative_path !== normalizeRelativePath(input.relativePath)
        || current.language_id !== input.languageId
        || current.content_hash !== input.contentHash
        || current.position_encoding !== input.positionEncoding
      ) {
        changedDocumentIds.add(current.id);
        invalidateAnswers = true;
      }
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (invalidateAnswers) {
        this.#database.exec(`
          DELETE FROM occurrence_answers;
          DELETE FROM hover_results;
          DELETE FROM answer_sets;
        `);
        if (this.#hasSymbolGraphSchema()) {
          this.#database.exec(`
            DELETE FROM occurrence_symbols;
            DELETE FROM symbols;
          `);
        }
      }
      const deleteOccurrences = this.#database.prepare(
        "DELETE FROM occurrences WHERE document_id = ?"
      );
      for (const id of changedDocumentIds) {
        deleteOccurrences.run(id);
      }
      const deleteDocument = this.#database.prepare(
        "DELETE FROM documents WHERE id = ?"
      );
      for (const current of currentRows) {
        if (!inputUris.has(current.uri)) {
          deleteDocument.run(current.id);
        }
      }
      for (const input of inputs) {
        this.#upsertDocument(input);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public upsertDocument(input: DocumentInput): DocumentRecord {
    this.#upsertDocument(input);
    const row = requiredRow<RowWithId>(
      this.#database.prepare("SELECT id FROM documents WHERE uri = ?"),
      input.uri
    );
    return {
      ...input,
      id: row.id,
      relativePath: normalizeRelativePath(input.relativePath)
    };
  }

  public upsertOccurrence(input: OccurrenceInput): OccurrenceRecord {
    const startKey = positionKey(
      input.range.start.line,
      input.range.start.character
    );
    const endKey = positionKey(input.range.end.line, input.range.end.character);
    this.#database.prepare(`
      INSERT INTO occurrences (
        document_id,
        start_line,
        start_character,
        end_line,
        end_character,
        start_key,
        end_key,
        discovery_source,
        semantic_token_type,
        semantic_modifiers
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        document_id, start_line, start_character, end_line, end_character
      ) DO UPDATE SET
        discovery_source = CASE
          WHEN excluded.discovery_source = 'semantic-token'
            THEN excluded.discovery_source
          WHEN occurrences.discovery_source = 'lexical'
            THEN excluded.discovery_source
          ELSE occurrences.discovery_source
        END,
        semantic_token_type = COALESCE(
          excluded.semantic_token_type,
          occurrences.semantic_token_type
        ),
        semantic_modifiers = COALESCE(
          excluded.semantic_modifiers,
          occurrences.semantic_modifiers
        )
    `).run(
      input.documentId,
      input.range.start.line,
      input.range.start.character,
      input.range.end.line,
      input.range.end.character,
      startKey,
      endKey,
      input.discoverySource,
      input.semanticTokenType ?? null,
      input.semanticModifiers ?? null
    );
    const row = requiredRow<RowWithId>(
      this.#database.prepare(`
        SELECT id
        FROM occurrences
        WHERE document_id = ?
          AND start_line = ?
          AND start_character = ?
          AND end_line = ?
          AND end_character = ?
      `),
      input.documentId,
      input.range.start.line,
      input.range.start.character,
      input.range.end.line,
      input.range.end.character
    );
    return { id: row.id, documentId: input.documentId, range: input.range };
  }

  public listOccurrences(documentId: number): readonly OccurrenceRecord[] {
    return this.#database.prepare(`
      SELECT
        id,
        document_id,
        start_line,
        start_character,
        end_line,
        end_character
      FROM occurrences
      WHERE document_id = ?
      ORDER BY start_key, end_key - start_key
    `).all(documentId).map((row) => occurrenceFromRow(
      row as unknown as OccurrenceRow
    ));
  }

  public resetDocumentOccurrences(documentIds: readonly number[]): void {
    if (documentIds.length === 0) {
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const deleteOccurrences = this.#database.prepare(
        "DELETE FROM occurrences WHERE document_id = ?"
      );
      for (const documentId of documentIds) {
        deleteOccurrences.run(documentId);
      }
      if (this.#hasSymbolGraphSchema()) {
        this.#deleteOrphanedSymbols();
      }
      this.#deleteOrphanedAnswerSets();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public hasCompleteAnswer(
    occurrenceId: number,
    kind: LocationAnswerKind
  ): boolean {
    if (this.#database.prepare(`
      SELECT 1
      FROM occurrence_answers
      WHERE occurrence_id = ? AND kind = ? AND status = 'complete'
    `).get(occurrenceId, kind) !== undefined) {
      return true;
    }
    if (
      this.#hasSymbolGraphSchema()
      && (kind === "references" || kind === "highlights")
    ) {
      return this.#database.prepare(`
        SELECT 1 FROM occurrence_symbols WHERE occurrence_id = ?
      `).get(occurrenceId) !== undefined;
    }
    if (this.#hasSymbolGraphSchema() && kind === "definition") {
      return this.#database.prepare(`
        SELECT 1
        FROM occurrence_symbols AS edge
        JOIN symbol_definitions AS definition
          ON definition.symbol_id = edge.symbol_id
        WHERE edge.occurrence_id = ?
        LIMIT 1
      `).get(occurrenceId) !== undefined;
    }
    return false;
  }

  public saveSymbolGraph(
    provider: string,
    occurrenceIds: readonly number[],
    symbols: readonly SymbolGraphInput[]
  ): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(createSymbolGraphSchemaSql);
      const deleteEdge = this.#database.prepare(
        "DELETE FROM occurrence_symbols WHERE occurrence_id = ?"
      );
      for (const occurrenceId of occurrenceIds) {
        deleteEdge.run(occurrenceId);
      }
      this.#deleteGraphDerivedAnswers(occurrenceIds);
      this.#deleteOrphanedSymbols();
      const insertSymbol = this.#database.prepare(`
        INSERT INTO symbols (provider, provider_key, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT (provider, provider_key) DO UPDATE SET
          display_name = excluded.display_name
      `);
      const selectSymbol = this.#database.prepare(`
        SELECT id FROM symbols WHERE provider = ? AND provider_key = ?
      `);
      const insertEdge = this.#database.prepare(`
        INSERT INTO occurrence_symbols (
          occurrence_id, symbol_id, is_definition
        )
        VALUES (?, ?, ?)
        ON CONFLICT (occurrence_id) DO UPDATE SET
          symbol_id = excluded.symbol_id,
          is_definition = excluded.is_definition
      `);
      const insertDefinition = this.#database.prepare(`
        INSERT INTO symbol_definitions (
          symbol_id,
          ordinal,
          uri,
          start_line,
          start_character,
          end_line,
          end_character
        )
        SELECT
          ?,
          COALESCE((
            SELECT MAX(ordinal) + 1 FROM symbol_definitions WHERE symbol_id = ?
          ), 0),
          ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM symbol_definitions
          WHERE symbol_id = ?
            AND uri = ?
            AND start_line = ?
            AND start_character = ?
            AND end_line = ?
            AND end_character = ?
        )
      `);
      for (const symbol of symbols) {
        if (symbol.occurrences.length === 0) {
          throw new Error("Symbol graph entries require at least one occurrence.");
        }
        insertSymbol.run(
          provider,
          symbol.providerKey,
          symbol.displayName ?? null
        );
        const symbolId = requiredRow<RowWithId>(
          selectSymbol,
          provider,
          symbol.providerKey
        ).id;
        for (const occurrence of symbol.occurrences) {
          insertEdge.run(
            occurrence.occurrenceId,
            symbolId,
            occurrence.isDefinition ? 1 : 0
          );
        }
        // Another language may see only metadata for a symbol defined in source.
        for (const definition of normalizeLocations(symbol.definitions)) {
          const locationValues = [
            definition.uri,
            definition.range.start.line,
            definition.range.start.character,
            definition.range.end.line,
            definition.range.end.character
          ];
          insertDefinition.run(
            symbolId,
            symbolId,
            ...locationValues,
            symbolId,
            ...locationValues
          );
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public clearSymbolGraph(occurrenceIds: readonly number[]): void {
    if (!this.#hasSymbolGraphSchema()) {
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const deleteEdge = this.#database.prepare(
        "DELETE FROM occurrence_symbols WHERE occurrence_id = ?"
      );
      for (const occurrenceId of occurrenceIds) {
        deleteEdge.run(occurrenceId);
      }
      this.#deleteGraphDerivedAnswers(occurrenceIds);
      this.#deleteOrphanedSymbols();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public clearSymbolGraphForDocuments(
    documentIds: readonly number[]
  ): void {
    if (!this.#hasSymbolGraphSchema() || documentIds.length === 0) {
      return;
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const deleteEdges = this.#database.prepare(`
        DELETE FROM occurrence_symbols
        WHERE occurrence_id IN (
          SELECT id FROM occurrences WHERE document_id = ?
        )
      `);
      const deleteAnswers = this.#database.prepare(`
        DELETE FROM occurrence_answers
        WHERE kind IN ('definition', 'declaration')
          AND occurrence_id IN (
            SELECT id FROM occurrences WHERE document_id = ?
          )
      `);
      for (const documentId of documentIds) {
        deleteEdges.run(documentId);
        deleteAnswers.run(documentId);
      }
      this.#deleteOrphanedSymbols();
      this.#deleteOrphanedAnswerSets();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public saveLocationAnswer(
    occurrenceId: number,
    kind: LocationAnswerKind,
    locations: readonly Location[]
  ): void {
    this.saveSharedLocationAnswer([occurrenceId], kind, locations);
  }

  public saveSharedLocationAnswer(
    occurrenceIds: readonly number[],
    kind: LocationAnswerKind,
    locations: readonly Location[]
  ): void {
    this.saveSharedLocationAnswers([{ occurrenceIds, kind, locations }]);
  }

  public saveSharedLocationAnswers(
    answers: readonly SharedLocationAnswerInput[]
  ): void {
    if (answers.some((answer) => answer.occurrenceIds.length === 0)) {
      throw new Error("Shared location answers require at least one occurrence.");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const answer of answers) {
        this.#saveSharedLocationAnswer(
          answer.occurrenceIds,
          answer.kind,
          answer.locations
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #saveSharedLocationAnswer(
    occurrenceIds: readonly number[],
    kind: LocationAnswerKind,
    locations: readonly Location[]
  ): void {
    const normalized = normalizeLocations(locations);
    const hash = createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");

    this.#database.prepare(`
      INSERT INTO answer_sets (kind, content_hash)
      VALUES (?, ?)
      ON CONFLICT (kind, content_hash) DO NOTHING
    `).run(kind, hash);
    const answerSet = requiredRow<RowWithId>(
      this.#database.prepare(`
        SELECT id FROM answer_sets WHERE kind = ? AND content_hash = ?
      `),
      kind,
      hash
    );
    const insertLocation = this.#database.prepare(`
      INSERT INTO answer_locations (
        answer_set_id,
        ordinal,
        uri,
        start_line,
        start_character,
        end_line,
        end_character
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (answer_set_id, ordinal) DO NOTHING
    `);
    normalized.forEach((location, ordinal) => {
      insertLocation.run(
        answerSet.id,
        ordinal,
        location.uri,
        location.range.start.line,
        location.range.start.character,
        location.range.end.line,
        location.range.end.character
      );
    });
    const saveOccurrenceAnswer = this.#database.prepare(`
      INSERT INTO occurrence_answers (
        occurrence_id, kind, answer_set_id, status, attempt_count
      )
      VALUES (?, ?, ?, 'complete', 1)
      ON CONFLICT (occurrence_id, kind) DO UPDATE SET
        answer_set_id = excluded.answer_set_id,
        status = 'complete',
        error_code = NULL,
        error_message = NULL,
        attempt_count = occurrence_answers.attempt_count + 1
    `);
    for (const occurrenceId of occurrenceIds) {
      saveOccurrenceAnswer.run(occurrenceId, kind, answerSet.id);
    }

    if (kind === "references") {
      this.#database.prepare(`
        INSERT INTO occurrence_answers (
          occurrence_id, kind, answer_set_id, status, attempt_count
        )
        SELECT occurrence.id, 'references', ?, 'complete', 1
        FROM answer_locations AS location
        JOIN documents AS document ON document.uri = location.uri
        JOIN occurrences AS occurrence
          ON occurrence.document_id = document.id
         AND occurrence.start_line = location.start_line
         AND occurrence.start_character = location.start_character
         AND occurrence.end_line = location.end_line
         AND occurrence.end_character = location.end_character
        WHERE location.answer_set_id = ?
        ON CONFLICT (occurrence_id, kind) DO NOTHING
      `).run(answerSet.id, answerSet.id);
    } else if (kind === "definition" || kind === "declaration") {
      for (const occurrenceId of occurrenceIds) {
        this.#propagateAcrossSymbol(occurrenceId, kind, answerSet.id);
        this.#propagateAcrossReferenceSet(occurrenceId, kind, answerSet.id);
      }
    } else if (kind === "highlights") {
      for (const occurrenceId of occurrenceIds) {
        this.#propagateHighlightsWithinDocument(
          occurrenceId,
          answerSet.id
        );
      }
    }
  }

  public saveHighlightsFromReferences(
    occurrenceId: number,
    documentUri: string
  ): boolean {
    const referenceAnswer = this.#database.prepare(`
      SELECT answer_set_id
      FROM occurrence_answers
      WHERE occurrence_id = ?
        AND kind = 'references'
        AND status = 'complete'
    `).get(occurrenceId) as unknown as AnswerSetRow | undefined;
    if (referenceAnswer?.answer_set_id === null || referenceAnswer === undefined) {
      return false;
    }
    const locations = this.#database.prepare(`
      SELECT
        uri,
        start_line,
        start_character,
        end_line,
        end_character
      FROM answer_locations
      WHERE answer_set_id = ? AND uri = ?
      ORDER BY ordinal
    `).all(
      referenceAnswer.answer_set_id,
      documentUri
    ) as unknown as readonly LocationRow[];
    this.saveLocationAnswer(
      occurrenceId,
      "highlights",
      locations.map(locationFromRow)
    );
    return true;
  }

  public saveAnswerError(
    occurrenceId: number,
    kind: LocationAnswerKind,
    error: unknown
  ): void {
    const code = typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "number"
      ? error.code
      : null;
    const message = error instanceof Error ? error.message : String(error);
    this.#database.prepare(`
      INSERT INTO occurrence_answers (
        occurrence_id,
        kind,
        answer_set_id,
        status,
        error_code,
        error_message,
        attempt_count
      )
      VALUES (?, ?, NULL, 'error', ?, ?, 1)
      ON CONFLICT (occurrence_id, kind) DO UPDATE SET
        answer_set_id = NULL,
        status = 'error',
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        attempt_count = occurrence_answers.attempt_count + 1
    `).run(occurrenceId, kind, code, message);
  }

  public hasCompleteHover(occurrenceId: number): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM hover_results
      WHERE occurrence_id = ? AND status = 'complete'
    `).get(occurrenceId) !== undefined;
  }

  public saveHover(occurrenceId: number, hover: Hover | null): void {
    this.#database.prepare(`
      INSERT INTO hover_results (
        occurrence_id,
        status,
        contents_json,
        start_line,
        start_character,
        end_line,
        end_character,
        attempt_count
      )
      VALUES (?, 'complete', ?, ?, ?, ?, ?, 1)
      ON CONFLICT (occurrence_id) DO UPDATE SET
        status = 'complete',
        contents_json = excluded.contents_json,
        start_line = excluded.start_line,
        start_character = excluded.start_character,
        end_line = excluded.end_line,
        end_character = excluded.end_character,
        error_message = NULL,
        attempt_count = hover_results.attempt_count + 1
    `).run(
      occurrenceId,
      hover === null ? null : JSON.stringify(hover.contents),
      hover?.range?.start.line ?? null,
      hover?.range?.start.character ?? null,
      hover?.range?.end.line ?? null,
      hover?.range?.end.character ?? null
    );
  }

  public saveHoverError(occurrenceId: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#database.prepare(`
      INSERT INTO hover_results (
        occurrence_id, status, contents_json, attempt_count, error_message
      )
      VALUES (?, 'error', NULL, 1, ?)
      ON CONFLICT (occurrence_id) DO UPDATE SET
        status = 'error',
        contents_json = NULL,
        error_message = excluded.error_message,
        attempt_count = hover_results.attempt_count + 1
    `).run(occurrenceId, message);
  }

  public statistics(): IndexStatistics {
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

  #upsertDocument(input: DocumentInput): void {
    this.#database.prepare(`
      INSERT INTO documents (
        uri, relative_path, language_id, content_hash, position_encoding
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (uri) DO UPDATE SET
        relative_path = excluded.relative_path,
        language_id = excluded.language_id,
        content_hash = excluded.content_hash,
        position_encoding = excluded.position_encoding
    `).run(
      input.uri,
      normalizeRelativePath(input.relativePath),
      input.languageId,
      input.contentHash,
      input.positionEncoding
    );
  }

  #propagateAcrossReferenceSet(
    occurrenceId: number,
    kind: LocationAnswerKind,
    answerSetId: number
  ): void {
    this.#database.prepare(`
      INSERT INTO occurrence_answers (
        occurrence_id, kind, answer_set_id, status, attempt_count
      )
      SELECT sibling.occurrence_id, ?, ?, 'complete', 1
      FROM occurrence_answers AS source
      JOIN occurrence_answers AS sibling
        ON sibling.kind = 'references'
       AND sibling.answer_set_id = source.answer_set_id
      WHERE source.occurrence_id = ?
        AND source.kind = 'references'
        AND EXISTS (
          SELECT 1
          FROM answer_locations
          WHERE answer_set_id = source.answer_set_id
        )
      ON CONFLICT (occurrence_id, kind) DO NOTHING
    `).run(kind, answerSetId, occurrenceId);
  }

  #propagateAcrossSymbol(
    occurrenceId: number,
    kind: LocationAnswerKind,
    answerSetId: number
  ): void {
    if (!this.#hasSymbolGraphSchema()) {
      return;
    }
    this.#database.prepare(`
      INSERT INTO occurrence_answers (
        occurrence_id, kind, answer_set_id, status, attempt_count
      )
      SELECT sibling.occurrence_id, ?, ?, 'complete', 1
      FROM occurrence_symbols AS source
      JOIN occurrence_symbols AS sibling
        ON sibling.symbol_id = source.symbol_id
      WHERE source.occurrence_id = ?
      ON CONFLICT (occurrence_id, kind) DO NOTHING
    `).run(kind, answerSetId, occurrenceId);
  }

  #hasSymbolGraphSchema(): boolean {
    return this.#database.prepare(`
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'occurrence_symbols'
    `).get() !== undefined;
  }

  #deleteOrphanedSymbols(): void {
    this.#database.exec(`
      DELETE FROM symbols
      WHERE NOT EXISTS (
        SELECT 1
        FROM occurrence_symbols
        WHERE occurrence_symbols.symbol_id = symbols.id
      )
    `);
  }

  #deleteGraphDerivedAnswers(occurrenceIds: readonly number[]): void {
    const deleteAnswer = this.#database.prepare(`
      DELETE FROM occurrence_answers
      WHERE occurrence_id = ?
        AND kind IN ('definition', 'declaration')
    `);
    for (const occurrenceId of occurrenceIds) {
      deleteAnswer.run(occurrenceId);
    }
    this.#deleteOrphanedAnswerSets();
  }

  #deleteOrphanedAnswerSets(): void {
    this.#database.exec(`
      DELETE FROM answer_sets
      WHERE NOT EXISTS (
        SELECT 1
        FROM occurrence_answers
        WHERE occurrence_answers.answer_set_id = answer_sets.id
      )
    `);
  }

  #propagateHighlightsWithinDocument(
    occurrenceId: number,
    answerSetId: number
  ): void {
    this.#database.prepare(`
      INSERT INTO occurrence_answers (
        occurrence_id, kind, answer_set_id, status, attempt_count
      )
      SELECT sibling.occurrence_id, 'highlights', ?, 'complete', 1
      FROM occurrence_answers AS source
      JOIN occurrences AS source_occurrence
        ON source_occurrence.id = source.occurrence_id
      JOIN occurrence_answers AS sibling
        ON sibling.kind = 'references'
       AND sibling.answer_set_id = source.answer_set_id
      JOIN occurrences AS sibling_occurrence
        ON sibling_occurrence.id = sibling.occurrence_id
       AND sibling_occurrence.document_id = source_occurrence.document_id
      WHERE source.occurrence_id = ?
        AND source.kind = 'references'
        AND EXISTS (
          SELECT 1
          FROM answer_locations
          WHERE answer_set_id = source.answer_set_id
        )
      ON CONFLICT (occurrence_id, kind) DO NOTHING
    `).run(answerSetId, occurrenceId);
  }

  #count(table: string, condition?: string): number {
    const row = this.#database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}${
        condition === undefined ? "" : ` WHERE ${condition}`
      }`
    ).get() as unknown as { readonly count: number } | undefined;
    return row?.count ?? 0;
  }

  #completedHoverCount(): number {
    if (!this.#hasSymbolGraphSchema()) {
      return this.#count("hover_results", "status = 'complete'");
    }
    const row = this.#database.prepare(`
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
    `).get() as unknown as { readonly count: number } | undefined;
    return row?.count ?? 0;
  }
}

class NodeSqlDatabase implements SqlDatabase {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly ownsDatabase: boolean
  ) {}

  public all(
    sql: string,
    parameters: readonly SqlValue[] = []
  ): readonly SqlRow[] {
    return this.database.prepare(sql).all(
      ...parameters
    ) as unknown as readonly SqlRow[];
  }

  public close(): void {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }
}

function requiredRow<T>(
  statement: StatementSync,
  ...parameters: readonly (string | number | null)[]
): T {
  const row = statement.get(...parameters);
  if (row === undefined) {
    throw new Error("Expected SQLite query to return a row.");
  }
  return row as unknown as T;
}

function occurrenceFromRow(row: OccurrenceRow): OccurrenceRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    range: {
      start: { line: row.start_line, character: row.start_character },
      end: { line: row.end_line, character: row.end_character }
    }
  };
}

function locationFromRow(row: LocationRow): Location {
  return {
    uri: row.uri,
    range: {
      start: { line: row.start_line, character: row.start_character },
      end: { line: row.end_line, character: row.end_character }
    }
  };
}

function normalizeLocations(locations: readonly Location[]): Location[] {
  const unique = new Map<string, Location>();
  for (const location of locations) {
    unique.set(locationKey(location), location);
  }
  return [...unique.values()].sort((left, right) => (
    left.uri.localeCompare(right.uri)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.line - right.range.end.line
    || left.range.end.character - right.range.end.character
  ));
}

function locationKey(location: Location): string {
  return [
    location.uri,
    location.range.start.line,
    location.range.start.character,
    location.range.end.line,
    location.range.end.character
  ].join("\0");
}

function positionKey(line: number, character: number): number {
  return line * 0x1_0000_0000 + character;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/gu, "/");
}
