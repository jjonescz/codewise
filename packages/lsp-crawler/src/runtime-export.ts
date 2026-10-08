import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  createRuntimeIndexSchemaSql,
  createRuntimeSymbolGraphSchemaSql,
  createSemanticTokensSchemaSql,
  readSemanticTokensLegend,
  runtimeIndexSchemaVersion,
  symbolGraphSchemaVersion,
  validateIndexDatabase
} from "@codewise/index-core";
import { NodeSqlDatabase } from "./node-sql-database.js";

export interface RuntimeIndexExport {
  readonly sourceByteSize: number;
  readonly byteSize: number;
  readonly schemaVersion: typeof runtimeIndexSchemaVersion;
}

export function exportRuntimeIndex(
  sourcePath: string,
  outputPath: string
): RuntimeIndexExport {
  const source = realpathSync(sourcePath);
  const output = resolve(outputPath);
  const sourceStat = statSync(source);
  if (existsSync(output)) {
    const outputStat = statSync(output);
    if (
      realpathSync(output) === source
      || (sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino)
    ) {
      throw new Error("The runtime export must not overwrite its source database.");
    }
  }

  const reader = new DatabaseSync(source, { readOnly: true });
  let hasSymbolGraph: boolean;
  let hasSemanticTokens: boolean;
  try {
    reader.exec("PRAGMA trusted_schema = OFF");
    const version = validateIndexDatabase(new NodeSqlDatabase(reader, false));
    if (version === runtimeIndexSchemaVersion) {
      throw new Error("The source is already a compact runtime index.");
    }
    hasSymbolGraph = version === symbolGraphSchemaVersion;
    hasSemanticTokens = readSemanticTokensLegend(new NodeSqlDatabase(reader, false)) !== undefined;
  } finally {
    reader.close();
  }

  mkdirSync(dirname(output), { recursive: true });
  const temporaryPath = `${output}.${randomUUID()}.tmp`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(temporaryPath, {
      enableForeignKeyConstraints: true,
      allowExtension: false
    });
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA temp_store = FILE;");
    const sourceUri = pathToFileURL(source);
    sourceUri.searchParams.set("mode", "ro");
    database.prepare("ATTACH DATABASE ? AS crawl").run(sourceUri.href);
    database.exec("BEGIN");
    const sourcePageSize = database.prepare("PRAGMA crawl.page_size").get()?.["page_size"];
    const sourcePageCount = database.prepare("PRAGMA crawl.page_count").get()?.["page_count"];
    if (typeof sourcePageSize !== "number" || typeof sourcePageCount !== "number") {
      throw new Error("The source database returned invalid page sizes.");
    }
    const sourceByteSize = sourcePageSize * sourcePageCount;
    const invalidOccurrence = database.prepare(`
      SELECT id
      FROM crawl.occurrences
      WHERE start_line <> (start_key >> 32)
        OR start_character <> (start_key & 4294967295)
        OR end_line <> (end_key >> 32)
        OR end_character <> (end_key & 4294967295)
      LIMIT 1
    `).get();
    if (invalidOccurrence !== undefined) {
      throw new Error(
        `Occurrence ${String(invalidOccurrence["id"])} has coordinates inconsistent with its position keys.`
      );
    }
    database.exec(`
      ${createRuntimeIndexSchemaSql}
      ${hasSymbolGraph ? createRuntimeSymbolGraphSchemaSql : ""}
      ${hasSemanticTokens ? createSemanticTokensSchemaSql : ""}

      INSERT INTO metadata (key, value)
      VALUES ('symbol_graph', '${hasSymbolGraph ? "1" : "0"}');

      INSERT INTO documents (id, uri, relative_path)
      SELECT id, uri, relative_path FROM crawl.documents ORDER BY id;

      INSERT INTO documents (uri, relative_path)
      SELECT paths.uri, NULL
      FROM (
        SELECT DISTINCT uri FROM crawl.answer_locations
        ${hasSymbolGraph ? "UNION SELECT uri FROM crawl.symbol_definitions" : ""}
      ) AS paths
      WHERE NOT EXISTS (
        SELECT 1 FROM crawl.documents AS document WHERE document.uri = paths.uri
      )
      ORDER BY paths.uri;

      CREATE TEMP TABLE path_ids (
        uri TEXT PRIMARY KEY,
        id INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      INSERT INTO path_ids SELECT uri, id FROM documents;

      INSERT INTO occurrences (id, document_id, start_key, span_length)
      SELECT id, document_id, start_key, end_key - start_key
      FROM crawl.occurrences ORDER BY id;

      INSERT INTO answer_locations (
        answer_set_id, ordinal, document_id,
        start_line, start_character, end_line, end_character
      )
      SELECT location.answer_set_id, location.ordinal, path.id,
             location.start_line, location.start_character,
             location.end_line, location.end_character
      FROM crawl.answer_locations AS location
      JOIN path_ids AS path ON path.uri = location.uri
      ORDER BY location.answer_set_id, location.ordinal;

      INSERT INTO occurrence_answers (occurrence_id, kind, answer_set_id)
      SELECT occurrence_id, kind, answer_set_id
      FROM crawl.occurrence_answers WHERE status = 'complete'
      ORDER BY occurrence_id, kind;

      INSERT INTO hover_results (
        occurrence_id, contents_json,
        start_line, start_character, end_line, end_character
      )
      SELECT occurrence_id, contents_json,
             start_line, start_character, end_line, end_character
      FROM crawl.hover_results WHERE status = 'complete'
      ORDER BY occurrence_id;
    `);
    if (hasSemanticTokens) {
      database.exec(`
        INSERT INTO metadata (key, value)
        SELECT key, value FROM crawl.metadata WHERE key = 'semantic_tokens_legend';
        INSERT INTO document_semantic_tokens (document_id, content_hash, data)
        SELECT document_id, content_hash, data FROM crawl.document_semantic_tokens
        ORDER BY document_id;
      `);
    }
    if (hasSymbolGraph) {
      database.exec(`
        INSERT INTO symbols (id, display_name)
        SELECT id, display_name FROM crawl.symbols ORDER BY id;

        INSERT INTO occurrence_symbols (occurrence_id, symbol_id, is_definition)
        SELECT occurrence_id, symbol_id, is_definition
        FROM crawl.occurrence_symbols ORDER BY occurrence_id;

        INSERT INTO symbol_definitions (
          symbol_id, ordinal, document_id,
          start_line, start_character, end_line, end_character
        )
        SELECT definition.symbol_id, definition.ordinal, path.id,
               definition.start_line, definition.start_character,
               definition.end_line, definition.end_character
        FROM crawl.symbol_definitions AS definition
        JOIN path_ids AS path ON path.uri = definition.uri
        ORDER BY definition.symbol_id, definition.ordinal;

        CREATE INDEX occurrence_symbols_by_symbol
          ON occurrence_symbols (symbol_id);
      `);
    }
    database.exec(`
      CREATE INDEX occurrences_by_position
        ON occurrences (document_id, start_key, span_length);
      DROP TABLE path_ids;
      COMMIT;
      DETACH DATABASE crawl;
    `);
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("The runtime export contains invalid foreign key references.");
    }
    validateIndexDatabase(new NodeSqlDatabase(database, false));
    database.close();
    database = undefined;
    const byteSize = statSync(temporaryPath).size;
    renameSync(temporaryPath, output);
    return {
      sourceByteSize,
      byteSize,
      schemaVersion: runtimeIndexSchemaVersion
    };
  } finally {
    database?.close();
    rmSync(temporaryPath, { force: true });
    rmSync(`${temporaryPath}-journal`, { force: true });
  }
}
