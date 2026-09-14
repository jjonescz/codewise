import { describe, expect, it } from "vitest";
import type { SymbolGraphDocument } from "@codewise/lsp-crawler";
import {
  chunkSymbolGraphDocuments,
  createRoslynSymbolGraphProvider
} from "./roslyn-symbol-graph.js";

describe("createRoslynSymbolGraphProvider", () => {
  it("handles both C# and Visual Basic without claiming Razor documents", () => {
    const provider = createRoslynSymbolGraphProvider("Codewise.RoslynExtension.dll");

    expect([...provider.languageIds]).toEqual(["csharp", "vb"]);
    expect(provider.languageIds.has("aspnetcorerazor")).toBe(false);
  });
});

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

  it("preserves language IDs in mixed-language batches", () => {
    const documents: SymbolGraphDocument[] = [
      createDocument("csharp", 1),
      { uri: "file:///visual-basic.vb", languageId: "vb", contentLength: 1 }
    ];

    expect(chunkSymbolGraphDocuments(documents)).toEqual([documents]);
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
