import { createHash } from "node:crypto";
import { linkSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import {
  CodeIndex,
  createIndexSchemaSql,
  createSymbolGraphSchemaSql,
  runtimeIndexSchemaVersion
} from "@codewise/index-core";
import { describe, expect, it } from "vitest";
import { CrawlerDatabase } from "./database.js";
import { NodeSqlDatabase } from "./node-sql-database.js";
import { exportRuntimeIndex } from "./runtime-export.js";

const uri = "file:///crawler/src/Widget.cs";
const vbUri = "file:///crawler/src/Helper.vb";
const externalUri = "metadata:///External.Library/Widget";

describe("exportRuntimeIndex", () => {
  it.each([false, true])("preserves document token payloads, hashes and legends (graph=%s)", async (graph) => {
    await withFixture(graph, ({ source, output }) => {
      const writer = new CrawlerDatabase(source);
      try {
        writer.saveSemanticTokens(1, "a".repeat(64), [0, 13, 6, 0, 1, 3, 8, 6, 0, 0], {
          tokenTypes: ["class"], tokenModifiers: ["declaration"]
        });
      } finally {
        writer.close();
      }
      exportRuntimeIndex(source, output);
      const original = openIndex(source);
      const compact = openIndex(output);
      try {
        expect(compact.semanticTokensLegend).toEqual(original.semanticTokensLegend);
        expect(compact.semanticTokens("src/Widget.cs"))
          .toEqual(original.semanticTokens("src/Widget.cs"));
        expect(compact.semanticTokens("src/Widget.cs")?.data)
          .toEqual([0, 13, 6, 0, 1, 3, 8, 6, 0, 0]);
        expect(compact.semanticTokens("src/Helper.vb")).toBeUndefined();
      } finally {
        original.close();
        compact.close();
      }
    });
  });

  it.each([false, true])(
    "preserves definitions, references, hovers and statistics (graph=%s)",
    async (graph) => {
      await withFixture(graph, ({ source, output }) => {
        const originalBytes = readFileSync(source);
        exportRuntimeIndex(source, output);
        const original = openIndex(source);
        const compact = openIndex(output);
        try {
          expect(compact.statistics).toEqual(original.statistics);
          for (const path of ["src/Widget.cs", "src\\Widget.cs", "src/Helper.vb", "Pages/Index.razor"]) {
            for (let line = 0; line <= 11; line++) {
              for (let character = 0; character <= 20; character++) {
                const position = { line, character };
                expect(compact.definition(path, position)).toEqual(original.definition(path, position));
                expect(compact.references(path, position, false))
                  .toEqual(original.references(path, position, false));
                expect(compact.references(path, position, true))
                  .toEqual(original.references(path, position, true));
                expect(compact.hover(path, position)).toEqual(original.hover(path, position));
              }
            }
          }
          expect(compact.definition("missing.cs", { line: 0, character: 0 })).toEqual([]);
          expect(compact.hover("src/Widget.cs", { line: 8, character: 5 })?.contents)
            .toEqual("first equal-width occurrence");
          expect(compact.definition("Pages/Index.razor", { line: 3, character: 3 }))
            .toContainEqual({
              uri: externalUri,
              range: {
                start: { line: 2, character: 1 },
                end: { line: 2, character: 5 }
              }
            });
          expect(readFileSync(source)).toEqual(originalBytes);
        } finally {
          original.close();
          compact.close();
        }
      });
    }
  );

  it("normalizes paths and omits ingestion-only columns, rows and indexes", async () => {
    await withFixture(true, ({ source, output }) => {
      const exported = exportRuntimeIndex(source, output);
      const database = new DatabaseSync(output, { readOnly: true });
      try {
        expect(exported.schemaVersion).toBe(runtimeIndexSchemaVersion);
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get()?.["value"]).toBe("3");
        expect(database.prepare("SELECT uri FROM documents WHERE relative_path IS NULL").all())
          .toEqual([{ uri: externalUri }]);
        expect(database.prepare("SELECT count(*) AS count FROM documents").get()?.["count"]).toBe(4);
        expect(database.prepare("PRAGMA table_info(symbols)").all()
          .map((column) => column["name"])).toEqual(["id", "display_name"]);
        expect(database.prepare("PRAGMA table_info(occurrences)").all()
          .map((column) => column["name"])).toEqual(["id", "document_id", "start_key", "span_length"]);
        expect(database.prepare("PRAGMA table_info(symbol_definitions)").all()
          .map((column) => column["name"])).not.toContain("uri");
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'sqlite_autoindex_%'")
          .all()).toEqual([{ name: "sqlite_autoindex_documents_1" }]);
        expect(database.prepare("PRAGMA index_info(occurrence_symbols_by_symbol)").all()
          .map((column) => column["name"])).toEqual(["symbol_id"]);
        expect(database.prepare("SELECT count(*) AS count FROM occurrence_answers WHERE status <> 'complete'")
          .get()?.["count"]).toBe(0);
        expect(database.prepare("SELECT count(*) AS count FROM hover_results WHERE status <> 'complete'")
          .get()?.["count"]).toBe(0);
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'answer_sets'").all())
          .toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
      } finally {
        database.close();
      }
    });
  });

  it("reads committed source data from an active WAL without modifying the source", async () => {
    await withFixture(true, ({ source, output }) => {
      const writer = new DatabaseSync(source);
      try {
        writer.exec(`
          PRAGMA journal_mode = WAL;
          INSERT INTO documents (
            uri, relative_path, language_id, content_hash, position_encoding
          ) VALUES ('file:///crawler/new.cs', 'new.cs', 'csharp', 'hash', 'utf-16');
        `);
        exportRuntimeIndex(source, output);
        const compact = openIndex(output);
        try {
          expect(compact.statistics.documentCount).toBe(4);
          expect(writer.prepare("SELECT count(*) AS count FROM documents").get()?.["count"]).toBe(4);
        } finally {
          compact.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  it.each(["same path", "hard link"])("refuses to overwrite the source through %s", async (alias) => {
    await withFixture(false, ({ source, output }) => {
      const originalBytes = readFileSync(source);
      if (alias === "hard link") {
        linkSync(source, output);
      }
      expect(() => exportRuntimeIndex(source, alias === "same path" ? source : output))
        .toThrow("must not overwrite its source database");
      expect(readFileSync(source)).toEqual(originalBytes);
    });
  });

  it("rejects inconsistent coordinates and leaves an existing output untouched", async () => {
    await withFixture(false, ({ source, output, directory }) => {
      const writer = new DatabaseSync(source);
      writer.exec("UPDATE occurrences SET start_character = 1 WHERE id = 2");
      writer.close();
      writeFileSync(output, "previous output");

      expect(() => exportRuntimeIndex(source, output)).toThrow("coordinates inconsistent");
      expect(readFileSync(output, "utf8")).toBe("previous output");
      expect(readdirSync(directory).sort()).toEqual(["crawl.db", "runtime.db"]);
    });
  });

  it("rejects broken foreign keys without publishing a partial export", async () => {
    await withFixture(false, ({ source, output, directory }) => {
      const writer = new DatabaseSync(source, { enableForeignKeyConstraints: false });
      writer.exec("UPDATE occurrences SET document_id = 999 WHERE id = 2");
      writer.close();
      writeFileSync(output, "previous output");

      expect(() => exportRuntimeIndex(source, output)).toThrow("FOREIGN KEY constraint failed");
      expect(readFileSync(output, "utf8")).toBe("previous output");
      expect(readdirSync(directory).sort()).toEqual(["crawl.db", "runtime.db"]);
    });
  });

  it("rejects unsupported source versions before creating an output", async () => {
    await withFixture(false, ({ source, output, directory }) => {
      const writer = new DatabaseSync(source);
      writer.exec("UPDATE metadata SET value = '999' WHERE key = 'schema_version'");
      writer.close();

      expect(() => exportRuntimeIndex(source, output)).toThrow("Unsupported Codewise index schema version 999");
      expect(readdirSync(directory)).toEqual(["crawl.db"]);
    });
  });

  it("prevents runtime databases from being exported again or resumed as crawl databases", async () => {
    await withFixture(true, ({ source, output, directory }) => {
      exportRuntimeIndex(source, output);
      const originalBytes = readFileSync(output);

      expect(() => exportRuntimeIndex(output, join(directory, "second.db")))
        .toThrow("already a compact runtime index");
      expect(() => new CrawlerDatabase(output)).toThrow("cannot be resumed");
      expect(readFileSync(output)).toEqual(originalBytes);
      expect(readdirSync(directory).sort()).toEqual(["crawl.db", "runtime.db"]);
    });
  });

  it("substantially reduces both raw and gzip size for a graph with repeated paths", async () => {
    await withFixture(true, ({ source, output }) => {
      addLargeGraph(source);
      const exported = exportRuntimeIndex(source, output);
      const originalCompressed = gzipSync(readFileSync(source)).byteLength;
      const compactCompressed = gzipSync(readFileSync(output)).byteLength;

      expect(exported.byteSize).toBeLessThan(exported.sourceByteSize * 0.55);
      expect(compactCompressed).toBeLessThan(originalCompressed * 0.75);
      const original = openIndex(source);
      const compact = openIndex(output);
      try {
        expect(compact.statistics).toEqual(original.statistics);
        const position = { line: 100, character: 2 };
        expect(compact.references("src/Widget.cs", position, true))
          .toEqual(original.references("src/Widget.cs", position, true));
        expect(compact.definition("src/Widget.cs", position))
          .toEqual(original.definition("src/Widget.cs", position));
        expect(compact.hover("src/Widget.cs", position))
          .toEqual(original.hover("src/Widget.cs", position));
      } finally {
        original.close();
        compact.close();
      }
    });
  });
});

function openIndex(path: string): CodeIndex {
  return new CodeIndex(new NodeSqlDatabase(new DatabaseSync(path, { readOnly: true }), true));
}

async function withFixture(
  graph: boolean,
  run: (paths: { source: string; output: string; directory: string }) => void
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codewise-runtime-export-"));
  const source = join(directory, "crawl.db");
  const output = join(directory, "runtime.db");
  try {
    createFixture(source, graph);
    run({ source, output, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createFixture(path: string, graph: boolean): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(createIndexSchemaSql);
    const document = database.prepare(`
      INSERT INTO documents (id, uri, relative_path, language_id, content_hash, position_encoding)
      VALUES (?, ?, ?, ?, 'hash', 'utf-16')
    `);
    document.run(1, uri, "src/Widget.cs", "csharp");
    document.run(2, vbUri, "src/Helper.vb", "vb");
    document.run(3, "file:///crawler/Pages/Index.razor", "Pages/Index.razor", "aspnetcorerazor");
    const occurrence = database.prepare(`
      INSERT INTO occurrences (
        id, document_id, start_line, start_character, end_line, end_character,
        start_key, end_key, discovery_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'semantic-token')
    `);
    for (const [id, doc, line, start, endLine, end] of [
      [1, 1, 0, 13, 0, 19], [2, 1, 3, 8, 3, 14], [3, 1, 3, 8, 3, 12],
      [4, 2, 1, 4, 1, 10], [5, 3, 2, 2, 3, 4], [6, 1, 5, 0, 5, 8],
      [7, 1, 6, 2, 6, 8], [8, 1, 7, 1, 7, 9], [9, 1, 8, 0, 8, 10],
      [10, 1, 8, 2, 8, 12], [11, 1, 9, 1, 9, 6], [12, 1, 10, 1, 10, 6]
    ] as const) {
      occurrence.run(id, doc, line, start, endLine, end, line * 0x1_0000_0000 + start,
        endLine * 0x1_0000_0000 + end);
    }
    database.exec(`
      INSERT INTO answer_sets (id, kind, content_hash) VALUES
        (1, 'definition', 'definitions'), (2, 'references', 'references'),
        (3, 'declaration', 'declarations'), (4, 'definition', 'empty');
      INSERT INTO occurrence_answers (
        occurrence_id, kind, answer_set_id, status, attempt_count
      ) VALUES
        (1, 'definition', 1, 'complete', 1), (1, 'references', 2, 'complete', 1),
        (2, 'definition', 1, 'complete', 1), (2, 'references', 2, 'complete', 1),
        (3, 'definition', 1, 'complete', 1), (3, 'references', 2, 'complete', 1),
        (3, 'declaration', 3, 'complete', 1),
        (5, 'definition', 1, 'complete', 1), (5, 'references', 2, 'complete', 1),
        (5, 'declaration', 3, 'complete', 1),
        (6, 'definition', 1, 'complete', 1), (7, 'definition', 4, 'complete', 1),
        (8, 'definition', NULL, 'error', 2), (9, 'definition', 1, 'complete', 1),
        (10, 'references', 2, 'complete', 1),
        (11, 'definition', NULL, 'complete', 1), (12, 'highlights', 4, 'complete', 1);
    `);
    const location = database.prepare(`
      INSERT INTO answer_locations (
        answer_set_id, ordinal, uri, start_line, start_character, end_line, end_character
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    location.run(1, 0, uri, 0, 13, 0, 19);
    location.run(1, 1, externalUri, 2, 1, 2, 5);
    location.run(1, 2, vbUri, 1, 4, 1, 10);
    location.run(2, 0, uri, 0, 13, 0, 19);
    location.run(2, 1, uri, 3, 8, 3, 14);
    location.run(2, 2, vbUri, 1, 4, 1, 10);
    location.run(2, 3, externalUri, 2, 1, 2, 5);
    location.run(3, 0, uri, 0, 13, 0, 19);
    const hover = database.prepare(`
      INSERT INTO hover_results (
        occurrence_id, status, contents_json, start_line, start_character,
        end_line, end_character, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    hover.run(2, "complete", JSON.stringify({ kind: "markdown", value: "**Widget**" }), 3, 8, 3, 14);
    hover.run(3, "complete", JSON.stringify("Nested hover"), 3, 8, 3, 12);
    hover.run(5, "complete", JSON.stringify(["multiline", { language: "razor", value: "Widget" }]),
      null, null, null, null);
    hover.run(6, "error", null, null, null, null, null);
    hover.run(7, "complete", null, null, null, null, null);
    hover.run(8, "error", null, null, null, null, null);
    hover.run(9, "complete", JSON.stringify("first equal-width occurrence"), null, null, null, null);
    hover.run(10, "complete", JSON.stringify("second equal-width occurrence"), null, null, null, null);
    hover.run(11, "complete", null, null, null, null, null);
    if (graph) {
      database.exec(`
        ${createSymbolGraphSchemaSql}
        INSERT INTO symbols (id, provider, provider_key, display_name) VALUES
          (1, 'roslyn-symbol-graph', 'widget', 'Widget'),
          (2, 'roslyn-symbol-graph', 'no-definition', 'NoDefinition'),
          (3, 'roslyn-symbol-graph', 'no-display', NULL),
          (4, 'roslyn-symbol-graph', 'empty-display', '');
        INSERT INTO occurrence_symbols (occurrence_id, symbol_id, is_definition) VALUES
          (1, 1, 1), (2, 1, 0), (4, 1, 0), (6, 2, 0), (7, 3, 0), (12, 4, 0);
      `);
      const definition = database.prepare(`
        INSERT INTO symbol_definitions (
          symbol_id, ordinal, uri, start_line, start_character, end_line, end_character
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `);
      definition.run(0, uri, 0, 13, 0, 19);
      definition.run(1, vbUri, 1, 4, 1, 10);
      definition.run(2, externalUri, 2, 1, 2, 5);
    }
  } finally {
    database.close();
  }
}

function addLargeGraph(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("BEGIN");
    const symbol = database.prepare(`
      INSERT INTO symbols (id, provider, provider_key, display_name)
      VALUES (?, 'roslyn-symbol-graph', ?, ?)
    `);
    const occurrence = database.prepare(`
      INSERT INTO occurrences (
        id, document_id, start_line, start_character, end_line, end_character,
        start_key, end_key, discovery_source
      ) VALUES (?, 1, ?, 2, ?, 8, ?, ?, 'semantic-token')
    `);
    const edge = database.prepare(`
      INSERT INTO occurrence_symbols (occurrence_id, symbol_id, is_definition)
      VALUES (?, ?, ?)
    `);
    const definition = database.prepare(`
      INSERT INTO symbol_definitions (
        symbol_id, ordinal, uri, start_line, start_character, end_line, end_character
      ) VALUES (?, ?, ?, ?, 2, ?, 8)
    `);
    for (let id = 100; id < 2100; id++) {
      symbol.run(id, createHash("sha256").update(`symbol-${id}`).digest("hex"), `Namespace.Type.Member${id}`);
      definition.run(id, 0, uri, id, id);
      definition.run(id, 1, externalUri, id, id);
      for (let use = 0; use < 6; use++) {
        const line = id + use * 10000;
        const key = line * 0x1_0000_0000;
        const occurrenceId = id * 6 + use;
        occurrence.run(occurrenceId, line, line, key + 2, key + 8);
        edge.run(occurrenceId, id, use === 0 ? 1 : 0);
      }
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
