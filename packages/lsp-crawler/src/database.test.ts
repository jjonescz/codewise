import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrawlerDatabase } from "./database.js";

describe("CrawlerDatabase", () => {
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
      database.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
