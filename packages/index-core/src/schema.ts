import type { SqlDatabase, SqlRow } from "./types.js";

export const indexApplicationId = 0x43574958;
export const indexSchemaVersion = 1;
export const symbolGraphSchemaVersion = 2;
export const runtimeIndexSchemaVersion = 3;

export const createSemanticTokensSchemaSql = `
  CREATE TABLE IF NOT EXISTS document_semantic_tokens (
    document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    data BLOB NOT NULL CHECK (length(data) % 20 = 0)
  ) STRICT;

  INSERT INTO metadata (key, value)
  VALUES ('semantic_tokens_version', '1')
  ON CONFLICT (key) DO NOTHING;
`;

export const createIndexSchemaSql = `
  PRAGMA application_id = ${indexApplicationId};

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    uri TEXT NOT NULL UNIQUE,
    relative_path TEXT NOT NULL UNIQUE,
    language_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    position_encoding TEXT NOT NULL
      CHECK (position_encoding IN ('utf-8', 'utf-16', 'utf-32'))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS occurrences (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_character INTEGER NOT NULL CHECK (start_character >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= 0),
    end_character INTEGER NOT NULL CHECK (end_character >= 0),
    start_key INTEGER NOT NULL,
    end_key INTEGER NOT NULL CHECK (end_key > start_key),
    discovery_source TEXT NOT NULL CHECK (
      discovery_source IN ('document-symbol', 'lexical', 'semantic-token')
    ),
    semantic_token_type TEXT,
    semantic_modifiers INTEGER,
    UNIQUE (
      document_id, start_line, start_character, end_line, end_character
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS occurrences_by_position
    ON occurrences (document_id, start_key, end_key);

  CREATE TABLE IF NOT EXISTS answer_sets (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (
      kind IN ('declaration', 'definition', 'highlights', 'references')
    ),
    content_hash TEXT NOT NULL,
    UNIQUE (kind, content_hash)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS answer_locations (
    answer_set_id INTEGER NOT NULL
      REFERENCES answer_sets(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    uri TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_character INTEGER NOT NULL CHECK (start_character >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= 0),
    end_character INTEGER NOT NULL CHECK (end_character >= 0),
    PRIMARY KEY (answer_set_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS occurrence_answers (
    occurrence_id INTEGER NOT NULL
      REFERENCES occurrences(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (
      kind IN ('declaration', 'definition', 'highlights', 'references')
    ),
    answer_set_id INTEGER REFERENCES answer_sets(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'error')),
    error_code INTEGER,
    error_message TEXT,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
    PRIMARY KEY (occurrence_id, kind)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS hover_results (
    occurrence_id INTEGER PRIMARY KEY
      REFERENCES occurrences(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('complete', 'error')),
    contents_json TEXT,
    start_line INTEGER,
    start_character INTEGER,
    end_line INTEGER,
    end_character INTEGER,
    error_message TEXT,
    attempt_count INTEGER NOT NULL CHECK (attempt_count > 0)
  ) STRICT;

  INSERT INTO metadata (key, value)
  VALUES ('schema_version', '${indexSchemaVersion}')
  ON CONFLICT (key) DO NOTHING;
`;

export const createSymbolGraphSchemaSql = `
  UPDATE metadata
  SET value = '${symbolGraphSchemaVersion}'
  WHERE key = 'schema_version';

  CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    display_name TEXT,
    UNIQUE (provider, provider_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS occurrence_symbols (
    occurrence_id INTEGER PRIMARY KEY
      REFERENCES occurrences(id) ON DELETE CASCADE,
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    is_definition INTEGER NOT NULL CHECK (is_definition IN (0, 1))
  ) STRICT;

  CREATE INDEX IF NOT EXISTS occurrence_symbols_by_symbol
    ON occurrence_symbols (symbol_id, occurrence_id);

  CREATE TABLE IF NOT EXISTS symbol_definitions (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    uri TEXT NOT NULL,
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_character INTEGER NOT NULL CHECK (start_character >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= 0),
    end_character INTEGER NOT NULL CHECK (end_character >= 0),
    PRIMARY KEY (symbol_id, ordinal)
  ) STRICT;
`;

const baseTables = new Set([
  "answer_locations",
  "answer_sets",
  "documents",
  "hover_results",
  "metadata",
  "occurrence_answers",
  "occurrences"
]);
const symbolGraphTables = new Set([
  "occurrence_symbols",
  "symbol_definitions",
  "symbols"
]);

export const createRuntimeIndexSchemaSql = `
  PRAGMA application_id = ${indexApplicationId};

  CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    uri TEXT NOT NULL,
    relative_path TEXT UNIQUE
  ) STRICT;

  CREATE TABLE occurrences (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    start_key INTEGER NOT NULL CHECK (start_key >= 0),
    span_length INTEGER NOT NULL CHECK (span_length > 0),
    end_key INTEGER GENERATED ALWAYS AS (start_key + span_length) VIRTUAL,
    start_line INTEGER GENERATED ALWAYS AS (start_key >> 32) VIRTUAL,
    start_character INTEGER GENERATED ALWAYS AS (start_key & 4294967295) VIRTUAL,
    end_line INTEGER GENERATED ALWAYS AS (end_key >> 32) VIRTUAL,
    end_character INTEGER GENERATED ALWAYS AS (end_key & 4294967295) VIRTUAL
  ) STRICT;

  CREATE TABLE answer_locations (
    answer_set_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    document_id INTEGER NOT NULL REFERENCES documents(id),
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_character INTEGER NOT NULL CHECK (start_character >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= 0),
    end_character INTEGER NOT NULL CHECK (end_character >= 0),
    PRIMARY KEY (answer_set_id, ordinal)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE occurrence_answers (
    occurrence_id INTEGER NOT NULL REFERENCES occurrences(id),
    kind TEXT NOT NULL CHECK (
      kind IN ('declaration', 'definition', 'highlights', 'references')
    ),
    answer_set_id INTEGER,
    status TEXT GENERATED ALWAYS AS ('complete') VIRTUAL,
    PRIMARY KEY (occurrence_id, kind)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE hover_results (
    occurrence_id INTEGER PRIMARY KEY REFERENCES occurrences(id),
    contents_json TEXT,
    start_line INTEGER,
    start_character INTEGER,
    end_line INTEGER,
    end_character INTEGER,
    status TEXT GENERATED ALWAYS AS ('complete') VIRTUAL
  ) STRICT;

  INSERT INTO metadata (key, value)
  VALUES ('schema_version', '${runtimeIndexSchemaVersion}');
`;

export const createRuntimeSymbolGraphSchemaSql = `
  CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    display_name TEXT
  ) STRICT;

  CREATE TABLE occurrence_symbols (
    occurrence_id INTEGER PRIMARY KEY REFERENCES occurrences(id),
    symbol_id INTEGER NOT NULL REFERENCES symbols(id),
    is_definition INTEGER NOT NULL CHECK (is_definition IN (0, 1))
  ) STRICT;

  CREATE TABLE symbol_definitions (
    symbol_id INTEGER NOT NULL REFERENCES symbols(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    document_id INTEGER NOT NULL REFERENCES documents(id),
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    start_character INTEGER NOT NULL CHECK (start_character >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= 0),
    end_character INTEGER NOT NULL CHECK (end_character >= 0),
    PRIMARY KEY (symbol_id, ordinal)
  ) STRICT, WITHOUT ROWID;
`;

export class CodeIndexValidationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeIndexValidationError";
  }
}

export function validateIndexDatabase(
  database: SqlDatabase
): typeof indexSchemaVersion | typeof symbolGraphSchemaVersion | typeof runtimeIndexSchemaVersion {
  const applicationId = firstNumber(
    database.all("PRAGMA application_id"),
    "application_id"
  );
  if (applicationId !== indexApplicationId) {
    throw new CodeIndexValidationError(
      "The file is not a Codewise LSP crawl database."
    );
  }

  const version = database.all(
    "SELECT value FROM metadata WHERE key = 'schema_version'"
  )[0]?.["value"];
  if (
    version !== String(indexSchemaVersion)
    && version !== String(symbolGraphSchemaVersion)
    && version !== String(runtimeIndexSchemaVersion)
  ) {
    throw new CodeIndexValidationError(
      `Unsupported Codewise index schema version ${String(version ?? "missing")}.`
    );
  }
  const isRuntimeIndex = version === String(runtimeIndexSchemaVersion);
  const graphFlag = isRuntimeIndex
    ? database.all("SELECT value FROM metadata WHERE key = 'symbol_graph'")[0]?.["value"]
    : undefined;
  if (isRuntimeIndex && graphFlag !== "0" && graphFlag !== "1") {
    throw new CodeIndexValidationError("The runtime index has an invalid symbol graph flag.");
  }
  const hasSymbolGraph = version === String(symbolGraphSchemaVersion) || graphFlag === "1";
  const expectedTables = hasSymbolGraph
    ? new Set([...baseTables, ...symbolGraphTables])
    : new Set(baseTables);
  if (isRuntimeIndex) {
    expectedTables.delete("answer_sets");
  }
  const semanticVersion = database.all(
    "SELECT value FROM metadata WHERE key = 'semantic_tokens_version'"
  )[0]?.["value"];
  if (semanticVersion !== undefined) {
    if (semanticVersion !== "1") {
      throw new CodeIndexValidationError("Unsupported semantic token format version.");
    }
    expectedTables.add("document_semantic_tokens");
  }
  const expectedIndexes = hasSymbolGraph
    ? new Set(["occurrences_by_position", "occurrence_symbols_by_symbol"])
    : new Set(["occurrences_by_position"]);

  const schemaObjects = database.all(`
    SELECT name, type, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_autoindex_%'
    ORDER BY type, name
  `);
  const actualTables = new Set<string>();
  for (const row of schemaObjects) {
    const name = requiredString(row, "name");
    const type = requiredString(row, "type");
    if (type === "table") {
      if (!expectedTables.has(name)) {
        throw new CodeIndexValidationError(
          `The index contains unexpected table ${name}.`
        );
      }
      const sql = requiredString(row, "sql");
      if (/^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(sql)) {
        throw new CodeIndexValidationError(
          `The index contains unexpected virtual table ${name}.`
        );
      }
      actualTables.add(name);
    } else if (type === "index") {
      if (!expectedIndexes.has(name)) {
        throw new CodeIndexValidationError(
          `The index contains unexpected index ${name}.`
        );
      }
    } else {
      throw new CodeIndexValidationError(
        `The index contains unexpected ${type} ${name}.`
      );
    }
  }

  const missingTables = [...expectedTables].filter(
    (table) => !actualTables.has(table)
  );
  if (missingTables.length > 0) {
    throw new CodeIndexValidationError(
      `The index is missing required table(s): ${missingTables.join(", ")}.`
    );
  }
  return isRuntimeIndex
    ? runtimeIndexSchemaVersion
    : hasSymbolGraph ? symbolGraphSchemaVersion : indexSchemaVersion;
}

function firstNumber(rows: readonly SqlRow[], name: string): number | undefined {
  const value = rows[0]?.[name];
  return typeof value === "number" ? value : undefined;
}

function requiredString(row: SqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new CodeIndexValidationError(
      `The index schema has an invalid ${name} value.`
    );
  }
  return value;
}
