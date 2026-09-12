import { describe, expect, it } from "vitest";
import type { SymbolGraphDocument } from "@codewise/lsp-crawler";
import { chunkSymbolGraphDocuments } from "./roslyn-symbol-graph.js";

describe("chunkSymbolGraphDocuments", () => {
  it("splits documents by source size without dropping order", () => {
    const documents = [
      createDocument("first", 1024 * 1024),
      createDocument("second", 1536 * 1024),
      createDocument("third", 512 * 1024)
    ];

    const chunks = chunkSymbolGraphDocuments(documents);

    expect(chunks.map((chunk) => chunk.map((document) => document.uri)))
      .toEqual([
        ["file:///first.cs"],
        ["file:///second.cs", "file:///third.cs"]
      ]);
  });

  it("caps the number of documents in one request", () => {
    const documents = Array.from(
      { length: 65 },
      (_, index) => createDocument(String(index), 1)
    );

    expect(chunkSymbolGraphDocuments(documents).map((chunk) => chunk.length))
      .toEqual([64, 1]);
  });
});

function createDocument(
  name: string,
  contentLength: number
): SymbolGraphDocument {
  return {
    uri: `file:///${name}.cs`,
    languageId: "csharp",
    contentLength
  };
}
