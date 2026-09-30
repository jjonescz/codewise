import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  LspProcessClient,
  type SymbolGraphDocument,
  type SymbolGraphResult
} from "@codewise/lsp-crawler";
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

  it("reports chunk progress and separates request timing from server timing", async () => {
    const client = new LspProcessClient({
      workspaceRoot: process.cwd(),
      server: {
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
        environment: {},
        requestResponses: {}
      },
      documents: [],
      concurrency: 8,
      requestTimeoutMilliseconds: 5_000,
      workspaceLoadTimeoutMilliseconds: 5_000,
      settleMilliseconds: 0,
      lexicalFallback: false
    });
    const documents = Array.from({ length: 65 }, (_, i) => createDocument(`${i}`, 1));
    const chunks = chunkSymbolGraphDocuments(documents);
    const results: SymbolGraphResult[] = [];
    const logs: string[] = [];
    try {
      vi.spyOn(client, "waitForNotification").mockResolvedValue(true);
      const request = vi.spyOn(client, "request").mockResolvedValueOnce({
        workspaceMessageHandlers: ["Codewise.RoslynExtension.SymbolGraphHandler"]
      });
      for (const chunk of chunks) {
        request.mockResolvedValueOnce({
          response: JSON.stringify({
            ProtocolVersion: 3,
            Symbols: [],
            ProcessedDocumentUris: chunk.map((document) => document.uri),
            MissingDocumentUris: [],
            Failures: [],
            SolutionProjectCount: 1,
            SolutionDocumentCount: 65,
            TokenCount: 100,
            OccurrenceCount: 0,
            SymbolResolutionMilliseconds: 10
          })
        });
      }
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(125)
        .mockReturnValueOnce(200)
        .mockReturnValueOnce(250);

      await createRoslynSymbolGraphProvider("extension.dll").populateSymbolGraph(
        client,
        documents,
        (chunk) => results.push(chunk),
        (message) => logs.push(message)
      );

      expect(results.map((result) => result.metrics)).toEqual([
        expect.objectContaining({
          requestMilliseconds: 25,
          symbolResolutionMilliseconds: 10
        }),
        expect.objectContaining({
          requestMilliseconds: 50,
          symbolResolutionMilliseconds: 10
        })
      ]);
      expect(logs).toEqual([
        expect.stringContaining("chunk 1/2, attempt 1/15 (64 document(s))"),
        expect.stringContaining("chunk 2/2, attempt 1/1 (1 document(s))")
      ]);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.restoreAllMocks();
    }
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
