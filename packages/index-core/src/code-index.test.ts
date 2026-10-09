import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodeIndex } from "./code-index.js";
import {
  createIndexSchemaSql,
  createSemanticTokensSchemaSql,
  createRuntimeIndexSchemaSql,
  createRuntimeSymbolGraphSchemaSql,
  createSymbolGraphSchemaSql
} from "./schema.js";
import {
  decodeSemanticTokens,
  encodeSemanticTokens,
  normalizeSemanticText,
  parseSemanticTokensLegend
} from "./semantic-tokens.js";
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

  it("prefers inverted symbol graph answers when available", () => {
    const database = createFixtureDatabase();
    database.exec(`
      ${createSymbolGraphSchemaSql}
      INSERT INTO symbols (id, provider, provider_key, display_name)
      VALUES (1, 'test', 'widget', 'Widget');
      INSERT INTO occurrence_symbols (
        occurrence_id, symbol_id, is_definition
      ) VALUES
        (1, 1, 1),
        (2, 1, 0);
      INSERT INTO symbol_definitions (
        symbol_id, ordinal, uri, start_line, start_character,
        end_line, end_character
      ) VALUES (
        1, 0, 'file:///crawler/src/Widget.cs', 0, 13, 0, 19
      );
      DELETE FROM occurrence_answers;
      DELETE FROM answer_locations;
      DELETE FROM answer_sets;
      DELETE FROM hover_results;
    `);
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
    )).toEqual([{
      relativePath: "src/Widget.cs",
      range: {
        start: { line: 3, character: 8 },
        end: { line: 3, character: 14 }
      }
    }]);
    expect(index.references(
      "src/Widget.cs",
      { line: 3, character: 13 },
      true
    )).toHaveLength(2);
    expect(index.hover("src/Widget.cs", { line: 3, character: 13 }))
      .toEqual({
        contents: { kind: "plaintext", value: "Widget" },
        range: {
          start: { line: 3, character: 8 },
          end: { line: 3, character: 14 }
        }
      });
    expect(index.hover("src/Widget.cs", { line: 3, character: 9 })?.contents)
      .toEqual({ kind: "plaintext", value: "Widget" });
    database.prepare(`
      INSERT INTO hover_results (
        occurrence_id, status, contents_json, attempt_count
      ) VALUES (2, 'complete', NULL, 1)
    `).run();
    expect(index.hover("src/Widget.cs", { line: 3, character: 13 })?.contents)
      .toEqual({ kind: "plaintext", value: "Widget" });
    index.close();
  });

  it("accepts schema version one indexes without symbol graph tables", () => {
    const database = createFixtureDatabase();
    const index = new CodeIndex(new TestSqlDatabase(database));
    expect(index.semanticTokensLegend).toBeUndefined();
    expect(index.semanticTokens("src/Widget.cs")).toBeUndefined();
    expect(index.references(
      "src/Widget.cs",
      { line: 3, character: 13 },
      true
    )).toHaveLength(2);
    index.close();
  });

  it("reads portable document semantic tokens with their legend and hash", () => {
    const database = createFixtureDatabase();
    const legend = { tokenTypes: ["class", "keyword"], tokenModifiers: ["declaration"] };
    const data = [0, 0, 6, 1, 0, 0, 13, 6, 0, 1, 3, 8, 6, 0, 0];
    const hash = "a".repeat(64);
    database.exec(createSemanticTokensSchemaSql);
    database.prepare("INSERT INTO metadata (key, value) VALUES ('semantic_tokens_legend', ?)")
      .run(JSON.stringify(legend));
    database.prepare(`
      INSERT INTO document_semantic_tokens (document_id, content_hash, data)
      VALUES (1, ?, ?)
    `).run(hash, encodeSemanticTokens(data, legend));
    const index = new CodeIndex(new TestSqlDatabase(database));
    try {
      expect(index.semanticTokensLegend).toEqual(legend);
      expect(index.semanticTokens("src\\Widget.cs")).toEqual({ contentHash: hash, data });
      expect(index.semanticTokens("missing.cs")).toBeUndefined();
      database.prepare("UPDATE document_semantic_tokens SET data = ?")
        .run(new Uint8Array(20).fill(255));
      expect(() => index.semanticTokens("src/Widget.cs")).toThrow("Invalid semantic token data");
    } finally {
      index.close();
    }
  });

  it("requires the declared semantic token table and a valid legend", () => {
    const database = createFixtureDatabase();
    try {
      database.exec("INSERT INTO metadata (key, value) VALUES ('semantic_tokens_version', '1')");
      expect(() => new CodeIndex(new TestSqlDatabase(database))).toThrow("missing required table");
      database.exec(createSemanticTokensSchemaSql);
      expect(() => new CodeIndex(new TestSqlDatabase(database))).toThrow("missing its semantic token legend");
      database.exec(`
        INSERT INTO metadata (key, value) VALUES ('semantic_tokens_legend', 'invalid');
      `);
      expect(() => new CodeIndex(new TestSqlDatabase(database))).toThrow("legend JSON");
      database.exec("UPDATE metadata SET value = '999' WHERE key = 'semantic_tokens_version'");
      expect(() => new CodeIndex(new TestSqlDatabase(database))).toThrow("Unsupported semantic token format");
    } finally {
      database.close();
    }
  });

  it("encodes token integers little-endian and validates payloads", () => {
    const legend = { tokenTypes: ["variable"], tokenModifiers: ["readonly"] };
    const data = [0, 256, 5, 0, 1];
    const bytes = encodeSemanticTokens(data, legend);
    expect([...bytes.slice(4, 8)]).toEqual([0, 1, 0, 0]);
    const offsetBytes = new Uint8Array(bytes.length + 4);
    offsetBytes.set(bytes, 4);
    expect(decodeSemanticTokens(offsetBytes.subarray(4), legend)).toEqual(data);
    expect(() => decodeSemanticTokens(new Uint8Array(1), legend)).toThrow("payload size");
    for (const invalid of [
      [0], [0, -1, 5, 0, 0], [0, 0, 0, 0, 0],
      [0, 0, 5, 1, 0], [0, 0, 5, 0, 2], [0, 0, 5, 0, 2 ** 32]
    ]) {
      expect(() => encodeSemanticTokens(invalid, legend)).toThrow("Invalid semantic token");
    }
    expect(() => parseSemanticTokensLegend({
      tokenTypes: ["class", "class"], tokenModifiers: []
    })).toThrow("legend");
    expect(normalizeSemanticText("\uFEFFclass Widget\r\n{}\r\n"))
      .toBe("class Widget\n{}\n");
    expect(normalizeSemanticText("one\rtwo\r\nthree\nfour\u0085five\u2028six\u2029seven"))
      .toBe("one\ntwo\nthree\nfour\u0085five\u2028six\u2029seven");
  });

  it.each([undefined, "2"])("rejects a runtime index with an invalid graph flag (%s)", (flag) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(createRuntimeIndexSchemaSql);
      if (flag !== undefined) {
        database.prepare("INSERT INTO metadata (key, value) VALUES ('symbol_graph', ?)")
          .run(flag);
      }
      expect(() => new CodeIndex(new TestSqlDatabase(database)))
        .toThrow("invalid symbol graph flag");
    } finally {
      database.close();
    }
  });

  it("requires graph tables when a runtime index declares a symbol graph", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        ${createRuntimeIndexSchemaSql}
        INSERT INTO metadata (key, value) VALUES ('symbol_graph', '1');
      `);
      expect(() => new CodeIndex(new TestSqlDatabase(database)))
        .toThrow("missing required table");
      database.exec(createRuntimeSymbolGraphSchemaSql);
      const index = new CodeIndex(new TestSqlDatabase(database));
      expect(index.statistics.documentCount).toBe(0);
    } finally {
      database.close();
    }
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
