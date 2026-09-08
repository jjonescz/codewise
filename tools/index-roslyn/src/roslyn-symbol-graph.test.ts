import { describe, expect, it } from "vitest";
import type { SymbolGraphDocument } from "@codewise/lsp-crawler";
import { chunkSymbolGraphDocuments } from "./roslyn-symbol-graph.js";

describe("chunkSymbolGraphDocuments", () => {
  it("splits documents without exceeding the occurrence limit", () => {
    const documents: SymbolGraphDocument[] = [
      createDocument("first", 3, 0),
      createDocument("second", 8, 3),
      createDocument("third", 1, 11)
    ];

    const chunks = chunkSymbolGraphDocuments(documents, 5);

    expect(chunks.map((chunk) => chunk.reduce(
      (count, document) => count + document.occurrences.length,
      0
    ))).toEqual([5, 5, 2]);
    expect(chunks.flatMap((chunk) => chunk).flatMap(
      (document) => document.occurrences.map((occurrence) => occurrence.id)
    )).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });
});

function createDocument(
  name: string,
  count: number,
  firstId: number
): SymbolGraphDocument {
  return {
    uri: `file:///${name}.cs`,
    languageId: "csharp",
    occurrences: Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: 1 }
      }
    }))
  };
}
