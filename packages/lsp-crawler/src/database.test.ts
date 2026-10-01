import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CrawlerDatabase, type SymbolGraphAppendInput } from "./database.js";
import type { Location } from "./lsp-types.js";

describe("CrawlerDatabase", () => {
  it.each(["append", "replace"])(
    "merges large repeated definition sets with only new-location writes (%s)",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "codewise-many-definitions-"));
      const path = join(directory, "index.db");
      let database = new CrawlerDatabase(path);
      const reader = new DatabaseSync(path, { readOnly: true });
      const prepare = DatabaseSync.prototype.prepare;
      let definitionWrites = 0;
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.includes("INSERT INTO symbol_definitions")) {
          const run = statement.run.bind(statement);
          vi.spyOn(statement, "run").mockImplementation((...parameters) => {
            definitionWrites++;
            return run(...parameters);
          });
        }
        return statement;
      });
      try {
        const document = database.upsertDocument({
          uri: "file:///workspace/source.cs",
          relativePath: "source.cs",
          languageId: "csharp",
          contentHash: "content",
          positionEncoding: "utf-16"
        });
        const definitions: Location[] = Array.from({ length: 512 }, (_, i) => ({
          uri: `file:///workspace/source-${String(i).padStart(4, "0")}.cs`,
          range: {
            start: { line: 1, character: 2 },
            end: { line: 3, character: 4 }
          }
        }));
        let line = 0;
        const save = (key: string, locations: readonly Location[]): void => {
          const currentLine = line++;
          const occurrence = {
            documentId: document.id,
            range: {
              start: { line: currentLine, character: 0 },
              end: { line: currentLine, character: 5 }
            },
            discoverySource: "semantic-token" as const
          };
          if (mode === "append") {
            database.appendSymbolGraph("test", [{
              providerKey: key,
              occurrences: [{ ...occurrence, isDefinition: false }],
              definitions: locations
            }]);
          } else {
            const saved = database.upsertOccurrence(occurrence);
            database.saveSymbolGraph("test", [saved.id], [{
              providerKey: key,
              occurrences: [{ occurrenceId: saved.id, isDefinition: false }],
              definitions: locations
            }]);
          }
        };
        save("namespace", definitions);
        expect(definitionWrites).toBe(512);
        database.close();
        database = new CrawlerDatabase(path);
        save("namespace", [...definitions].reverse());
        save("namespace", []);
        expect(definitionWrites).toBe(512);

        const added = [
          { ...definitions[0]!, uri: "file:///workspace/new.cs" },
          {
            ...definitions[0]!,
            range: { start: { line: 0, character: 2 }, end: { line: 3, character: 4 } }
          },
          {
            ...definitions[0]!,
            range: { start: { line: 1, character: 1 }, end: { line: 3, character: 4 } }
          },
          {
            ...definitions[0]!,
            range: { start: { line: 1, character: 2 }, end: { line: 4, character: 4 } }
          },
          {
            ...definitions[0]!,
            range: { start: { line: 1, character: 2 }, end: { line: 3, character: 5 } }
          }
        ];
        save("namespace", [...definitions, ...added, ...added]);
        save("other-namespace", [definitions[0]!]);
        expect(definitionWrites).toBe(518);
        const rows = reader.prepare(`
          SELECT ordinal, uri, start_line, start_character, end_line, end_character
          FROM symbol_definitions
          JOIN symbols ON symbols.id = symbol_definitions.symbol_id
          WHERE provider_key = 'namespace'
          ORDER BY ordinal
        `).all();
        const sortedAdded = [...added].sort((left, right) => (
          left.uri.localeCompare(right.uri)
          || left.range.start.line - right.range.start.line
          || left.range.start.character - right.range.start.character
          || left.range.end.line - right.range.end.line
          || left.range.end.character - right.range.end.character
        ));
        expect(rows).toEqual([...definitions, ...sortedAdded].map((location, ordinal) => ({
          ordinal,
          uri: location.uri,
          start_line: location.range.start.line,
          start_character: location.range.start.character,
          end_line: location.range.end.line,
          end_character: location.range.end.character
        })));
        expect(reader.prepare(`
          SELECT COUNT(*) AS count FROM symbol_definitions
          JOIN symbols ON symbols.id = symbol_definitions.symbol_id
          WHERE provider_key = 'other-namespace'
        `).get()?.["count"]).toBe(1);
        expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        reader.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("rolls back merged definitions and retries without stale deduplication state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-definition-rollback-"));
    const path = join(directory, "index.db");
    const database = new CrawlerDatabase(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const document = database.upsertDocument({
        uri: "file:///workspace/source.cs",
        relativePath: "source.cs",
        languageId: "csharp",
        contentHash: "content",
        positionEncoding: "utf-16"
      });
      const range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      };
      const original: SymbolGraphAppendInput = {
        providerKey: "namespace",
        definitions: [{ uri: document.uri, range }],
        occurrences: [{
          documentId: document.id,
          range,
          discoverySource: "semantic-token",
          isDefinition: true
        }]
      };
      database.appendSymbolGraph("test", [original]);
      const next: SymbolGraphAppendInput = {
        ...original,
        definitions: [
          ...original.definitions,
          { uri: "file:///workspace/second.cs", range }
        ],
        occurrences: [{
          ...original.occurrences[0]!,
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 5 }
          }
        }]
      };
      const definitions = reader.prepare(
        "SELECT ordinal, uri FROM symbol_definitions ORDER BY ordinal"
      );
      expect(() => database.appendSymbolGraph("test", [
        next,
        { providerKey: "invalid", occurrences: [], definitions: [] }
      ])).toThrow("at least one occurrence");
      expect(definitions.all()).toEqual([{ ordinal: 0, uri: document.uri }]);
      expect(database.appendSymbolGraph("test", [next])).toBe(1);
      expect(definitions.all()).toEqual([
        { ordinal: 0, uri: document.uri },
        { ordinal: 1, uri: "file:///workspace/second.cs" }
      ]);
    } finally {
      reader.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("commits graph occurrences and edges atomically and reuses occurrence statements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-graph-append-"));
    const path = join(directory, "index.db");
    const database = new CrawlerDatabase(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const document = database.upsertDocument({
        uri: "file:///workspace/source.cs",
        relativePath: "source.cs",
        languageId: "csharp",
        contentHash: "content",
        positionEncoding: "utf-16"
      });
      const count = reader.prepare("SELECT COUNT(*) AS count FROM occurrences");
      const visibleCounts: unknown[] = [];
      const upsert = database.upsertOccurrence.bind(database);
      vi.spyOn(database, "upsertOccurrence").mockImplementation((input) => {
        const occurrence = upsert(input);
        visibleCounts.push(count.get()?.["count"]);
        return occurrence;
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const symbols: SymbolGraphAppendInput[] = [{
        providerKey: "shared",
        displayName: "shared",
        occurrences: [0, 1, 2].map((line) => ({
          documentId: document.id,
          range: {
            start: { line, character: 0 },
            end: { line, character: 5 }
          },
          discoverySource: "semantic-token",
          isDefinition: line === 0
        })),
        definitions: [{
          uri: document.uri,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 }
          }
        }]
      }];
      expect(database.appendSymbolGraph("test", symbols)).toBe(3);
      expect(visibleCounts).toEqual([0, 0, 0]);
      expect(count.get()?.["count"]).toBe(3);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM occurrence_symbols")
        .get()?.["count"]).toBe(3);

      expect(database.appendSymbolGraph("test", [{
        ...symbols[0]!,
        occurrences: [{
          ...symbols[0]!.occurrences[0]!,
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 5 }
          },
          isDefinition: false
        }],
        definitions: []
      }])).toBe(1);
      expect(visibleCounts).toEqual([0, 0, 0, 3]);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM symbols").get()?.["count"])
        .toBe(1);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM symbol_definitions")
        .get()?.["count"]).toBe(1);
      expect(database.hasCompleteAnswer(
        database.listOccurrences(document.id)[3]!.id,
        "definition"
      )).toBe(true);
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("INSERT INTO occurrences")))
        .toHaveLength(1);
      expect(prepare.mock.calls.filter(
        ([sql]) => sql.includes("SELECT id") && sql.includes("FROM occurrences")
      )).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      reader.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["foreign-key", "duplicate-in-chunk", "duplicate-across-chunks", "empty-symbol"])(
    "rolls back an entire graph chunk on %s failure",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "codewise-graph-rollback-"));
      const path = join(directory, "index.db");
      const database = new CrawlerDatabase(path);
      try {
        const document = database.upsertDocument({
          uri: "file:///workspace/source.cs",
          relativePath: "source.cs",
          languageId: "csharp",
          contentHash: "content",
          positionEncoding: "utf-16"
        });
        const original: SymbolGraphAppendInput = {
          providerKey: "original",
          displayName: "original",
          occurrences: [{
            documentId: document.id,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 }
            },
            discoverySource: "semantic-token",
            isDefinition: true
          }],
          definitions: []
        };
        database.appendSymbolGraph("test", [original]);
        const next: SymbolGraphAppendInput = {
          ...original,
          providerKey: "next",
          occurrences: [{
            ...original.occurrences[0]!,
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 5 }
            }
          }]
        };
        const invalid: SymbolGraphAppendInput = {
          ...original,
          providerKey: "invalid",
          occurrences: failure === "empty-symbol"
            ? []
            : failure === "duplicate-across-chunks"
              ? original.occurrences
              : failure === "duplicate-in-chunk"
                ? next.occurrences
                : [{
                    ...original.occurrences[0]!,
                    documentId: Number.MAX_SAFE_INTEGER
                  }]
        };
        const before = database.statistics();
        expect(() => database.appendSymbolGraph("test", [next, invalid]))
          .toThrow(failure === "foreign-key"
            ? /FOREIGN KEY/
            : failure === "empty-symbol"
              ? /at least one occurrence/
              : /UNIQUE constraint failed: occurrence_symbols/);
        expect(database.statistics()).toEqual(before);
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          expect(reader.prepare("SELECT provider_key FROM symbols").all())
            .toEqual([{ provider_key: "original" }]);
          expect(reader.prepare("SELECT COUNT(*) AS count FROM occurrence_symbols")
            .get()?.["count"]).toBe(1);
        } finally {
          reader.close();
        }
        expect(database.appendSymbolGraph("test", [next])).toBe(1);
        expect(database.statistics().occurrenceCount).toBe(2);
      } finally {
        database.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("invalidates workspace answers when a document changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-index-change-"));
    try {
      const database = new CrawlerDatabase(join(directory, "index.db"));
      const document = {
        uri: "file:///workspace/source.toy",
        relativePath: "source.toy",
        languageId: "toy",
        contentHash: "first",
        positionEncoding: "utf-16" as const
      };
      database.synchronizeDocuments([document]);
      const saved = database.upsertDocument(document);
      const occurrence = database.upsertOccurrence({
        documentId: saved.id,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 }
        },
        discoverySource: "semantic-token"
      });
      database.saveLocationAnswer(occurrence.id, "references", []);
      database.saveHover(occurrence.id, { contents: "stale" });

      database.synchronizeDocuments([{
        ...document,
        contentHash: "second"
      }]);
      expect(database.statistics()).toEqual({
        documentCount: 1,
        occurrenceCount: 0,
        completedAnswerCount: 0,
        answerLocationCount: 0,
        completedHoverCount: 0
      });
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a failed batch of shared location answers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-index-batch-"));
    try {
      const database = new CrawlerDatabase(join(directory, "index.db"));
      const document = database.upsertDocument({
        uri: "file:///workspace/source.toy",
        relativePath: "source.toy",
        languageId: "toy",
        contentHash: "content",
        positionEncoding: "utf-16"
      });
      const occurrence = database.upsertOccurrence({
        documentId: document.id,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 }
        },
        discoverySource: "semantic-token"
      });

      expect(() => database.saveSharedLocationAnswers([
        {
          occurrenceIds: [occurrence.id],
          kind: "references",
          locations: []
        },
        {
          occurrenceIds: [Number.MAX_SAFE_INTEGER],
          kind: "references",
          locations: []
        }
      ])).toThrow();
      expect(database.statistics().completedAnswerCount).toBe(0);
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates materialized definitions across a graph symbol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-index-symbol-"));
    try {
      const database = new CrawlerDatabase(join(directory, "index.db"));
      const document = database.upsertDocument({
        uri: "file:///workspace/source.toy",
        relativePath: "source.toy",
        languageId: "toy",
        contentHash: "content",
        positionEncoding: "utf-16"
      });
      const occurrences = [0, 10].map((start) => database.upsertOccurrence({
        documentId: document.id,
        range: {
          start: { line: 0, character: start },
          end: { line: 0, character: start + 5 }
        },
        discoverySource: "semantic-token"
      }));
      database.saveSymbolGraph(
        "test",
        occurrences.map((occurrence) => occurrence.id),
        [{
          providerKey: "external",
          occurrences: occurrences.map((occurrence) => ({
            occurrenceId: occurrence.id,
            isDefinition: false
          })),
          definitions: []
        }]
      );
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "definition"
      )).toBe(false);

      database.saveLocationAnswer(
        occurrences[0]!.id,
        "definition",
        [{
          uri: "metadata:///External",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 8 }
          }
        }]
      );
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "definition"
      )).toBe(true);
      database.saveSymbolGraph(
        "replacement",
        occurrences.map((occurrence) => occurrence.id),
        [{
          providerKey: "partial",
          occurrences: [{
            occurrenceId: occurrences[0]!.id,
            isDefinition: false
          }],
          definitions: []
        }]
      );
      expect(database.hasCompleteAnswer(
        occurrences[0]!.id,
        "references"
      )).toBe(true);
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "references"
      )).toBe(false);
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "definition"
      )).toBe(false);
      database.saveSymbolGraph(
        "replacement",
        [occurrences[1]!.id],
        [{
          providerKey: "partial",
          occurrences: [{
            occurrenceId: occurrences[1]!.id,
            isDefinition: false
          }],
          definitions: []
        }]
      );
      database.saveLocationAnswer(
        occurrences[0]!.id,
        "definition",
        [{
          uri: "metadata:///Replacement",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 11 }
          }
        }]
      );
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "definition"
      )).toBe(true);
      database.clearSymbolGraphForDocuments([document.id]);
      expect(database.hasCompleteAnswer(
        occurrences[0]!.id,
        "references"
      )).toBe(false);
      expect(database.hasCompleteAnswer(
        occurrences[1]!.id,
        "references"
      )).toBe(false);
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves source definitions when a later language sees a metadata symbol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-index-cross-language-"));
    const database = new CrawlerDatabase(join(directory, "index.db"));
    try {
      const range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
      };
      const occurrences = [
        { relativePath: "source.cs", languageId: "csharp" },
        { relativePath: "consumer.vb", languageId: "vb" }
      ].map((input) => {
        const uri = `file:///workspace/${input.relativePath}`;
        const document = database.upsertDocument({
          ...input,
          uri,
          contentHash: "content",
          positionEncoding: "utf-16"
        });
        const occurrence = database.upsertOccurrence({
          documentId: document.id,
          range,
          discoverySource: "semantic-token"
        });
        return { uri, occurrence };
      });
      const definition = occurrences[0]!;
      const reference = occurrences[1]!;
      database.saveSymbolGraph("test", [definition.occurrence.id], [{
        providerKey: "shared-symbol",
        occurrences: [{
          occurrenceId: definition.occurrence.id,
          isDefinition: true
        }],
        definitions: [{ uri: definition.uri, range }]
      }]);
      database.saveSymbolGraph("test", [reference.occurrence.id], [{
        providerKey: "shared-symbol",
        occurrences: [{
          occurrenceId: reference.occurrence.id,
          isDefinition: false
        }],
        definitions: []
      }]);

      expect(database.hasCompleteAnswer(definition.occurrence.id, "definition"))
        .toBe(true);
      expect(database.hasCompleteAnswer(reference.occurrence.id, "definition"))
        .toBe(true);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
