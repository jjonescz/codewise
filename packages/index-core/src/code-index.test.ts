import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodeIndex } from "./code-index.js";
import { createIndexSchemaSql } from "./schema.js";
import type { SqlDatabase, SqlRow, SqlValue } from "./types.js";

describe("CodeIndex", () => {
  it("queries portable definitions, references, and hovers", () => {
    const database = createFixtureDatabase();
    const index = new CodeIndex(new TestSqlDatabase(database));

    expect(index.definition("src/Widget.cs", { line: 3, character: 13 }))
      .toEqual([{
        relativePath: "src/Widget.cs",
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 19 }
        }
      }]);
    expect(index.references(
      "src/Widget.cs",
      { line: 3, character: 13 },
      false
    )).toHaveLength(1);
    expect(index.references(
      "src/Widget.cs",
      { line: 3, character: 13 },
      true
    )).toHaveLength(2);
    expect(index.hover("src/Widget.cs", { line: 3, character: 13 }))
      .toEqual({
        contents: { kind: "markdown", value: "```csharp\nclass Widget\n```" },
        range: {
          start: { line: 3, character: 8 },
          end: { line: 3, character: 14 }
        }
      });
    index.close();
  });

  it("selects the narrowest containing occurrence", () => {
    const database = createFixtureDatabase();
    const index = new CodeIndex(new TestSqlDatabase(database));
    expect(index.hover("src/Widget.cs", { line: 3, character: 9 })?.contents)
      .toEqual({ kind: "markdown", value: "Nested hover" });
    index.close();
  });
});

function createFixtureDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    ${createIndexSchemaSql}
  `);
  const uri = "file:///crawler/src/Widget.cs";
  database.prepare(`
    INSERT INTO documents (
      id, uri, relative_path, language_id, content_hash, position_encoding
    ) VALUES (1, ?, 'src/Widget.cs', 'csharp', 'hash', 'utf-16')
  `).run(uri);
  database.exec(`
    INSERT INTO occurrences (
      id, document_id, start_line, start_character, end_line, end_character,
      start_key, end_key, discovery_source
    ) VALUES
      (1, 1, 0, 13, 0, 19, 13, 19, 'semantic-token'),
      (2, 1, 3, 8, 3, 14, 12884901896, 12884901902, 'semantic-token'),
      (3, 1, 3, 8, 3, 12, 12884901896, 12884901900, 'semantic-token');
    INSERT INTO answer_sets (id, kind, content_hash) VALUES
      (1, 'definition', 'definition-hash'),
      (2, 'references', 'references-hash');
  `);
  const insertLocation = database.prepare(`
    INSERT INTO answer_locations (
      answer_set_id, ordinal, uri, start_line, start_character,
      end_line, end_character
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLocation.run(1, 0, uri, 0, 13, 0, 19);
  insertLocation.run(2, 0, uri, 0, 13, 0, 19);
  insertLocation.run(2, 1, uri, 3, 8, 3, 14);
  database.exec(`
    INSERT INTO occurrence_answers (
      occurrence_id, kind, answer_set_id, status, attempt_count
    ) VALUES
      (1, 'definition', 1, 'complete', 1),
      (1, 'references', 2, 'complete', 1),
      (2, 'definition', 1, 'complete', 1),
      (2, 'references', 2, 'complete', 1);
  `);
  const insertHover = database.prepare(`
    INSERT INTO hover_results (
      occurrence_id, status, contents_json, start_line, start_character,
      end_line, end_character, attempt_count
    ) VALUES (?, 'complete', ?, ?, ?, ?, ?, 1)
  `);
  insertHover.run(
    2,
    JSON.stringify({ kind: "markdown", value: "```csharp\nclass Widget\n```" }),
    3,
    8,
    3,
    14
  );
  insertHover.run(
    3,
    JSON.stringify({ kind: "markdown", value: "Nested hover" }),
    3,
    8,
    3,
    12
  );
  return database;
}

class TestSqlDatabase implements SqlDatabase {
  public constructor(private readonly database: DatabaseSync) {}

  public all(
    sql: string,
    parameters: readonly SqlValue[] = []
  ): readonly SqlRow[] {
    return this.database.prepare(sql).all(
      ...parameters
    ) as unknown as readonly SqlRow[];
  }

  public close(): void {
    this.database.close();
  }
}
