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
});
