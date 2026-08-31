import type { SqlDatabase, SqlRow } from "./types.js";

export const indexApplicationId = 0x43574958;
export const indexSchemaVersion = 1;

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

const expectedTables = new Set([
  "answer_locations",
  "answer_sets",
  "documents",
  "hover_results",
  "metadata",
  "occurrence_answers",
  "occurrences"
]);

export class CodeIndexValidationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeIndexValidationError";
  }
}

export function validateIndexDatabase(database: SqlDatabase): void {
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
  if (version !== String(indexSchemaVersion)) {
    throw new CodeIndexValidationError(
      `Unsupported Codewise index schema version ${String(version ?? "missing")}.`
    );
  }

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
      if (name !== "occurrences_by_position") {
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
