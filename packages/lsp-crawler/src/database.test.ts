import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { CrawlerDatabase, type SymbolGraphAppendInput } from "./database.js";

describe("CrawlerDatabase", () => {
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
