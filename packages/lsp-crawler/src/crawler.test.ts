import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodeIndex, type SqlDatabase, type SqlRow, type SqlValue } from "@codewise/index-core";
import { createHash } from "node:crypto";
import {
  LspProcessClient,
  LspRequestTimeoutError
} from "./client.js";
import type { CrawlerConfig } from "./config.js";
import { CrawlError, crawlWorkspace } from "./crawler.js";

describe("crawlWorkspace", () => {
  it.each(["--utf-8", "--utf-32", "--range-tokens"])(
    "captures UTF-16 highlighting from upstream %s tokens",
    async (flag) => {
      const directory = await mkdtemp(join(tmpdir(), "codewise-token-encoding-"));
      const path = join(directory, "index.db");
      const content = "\uFEFF\uD83D\uDE00value\r\n";
      try {
        await writeFile(join(directory, "sample.toy"), content);
        const summary = await crawlWorkspace({
          workspaceRoot: directory,
          server: {
            command: process.execPath,
            args: [
              resolve(import.meta.dirname, "../test/fake-lsp-server.mjs"),
              join(directory, "server.log"), "--unicode-tokens", flag
            ],
            cwd: directory, environment: {}, requestResponses: {}
          },
          documents: [{ languageId: "toy", extensions: [".toy"] }],
          concurrency: 1, requestTimeoutMilliseconds: 5_000,
          workspaceLoadTimeoutMilliseconds: 5_000, settleMilliseconds: 0,
          lexicalFallback: false
        }, path);
        expect(summary.requestFailures).toBe(0);
        const index = openIndex(path);
        try {
          expect(index.semanticTokens("sample.toy")).toEqual({
            contentHash: createHash("sha256").update("\uD83D\uDE00value\n").digest("hex"),
            data: [0, 2, 5, 0, 1]
          });
        } finally {
          index.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["--no-semantic-tokens", "--invalid-tokens"])(
    "handles missing or invalid token providers explicitly (%s)",
    async (flag) => {
      const directory = await mkdtemp(join(tmpdir(), "codewise-token-failure-"));
      const path = join(directory, "index.db");
      try {
        await writeFile(join(directory, "sample.toy"), "let value = 1;\nprint(value);\n");
        const crawl = crawlWorkspace({
          workspaceRoot: directory,
          server: {
            command: process.execPath,
            args: [
              resolve(import.meta.dirname, "../test/fake-lsp-server.mjs"),
              join(directory, "server.log"), flag
            ],
            cwd: directory, environment: {}, requestResponses: {}
          },
          documents: [{ languageId: "toy", extensions: [".toy"] }],
          concurrency: 1, requestTimeoutMilliseconds: 5_000,
          workspaceLoadTimeoutMilliseconds: 5_000, settleMilliseconds: 0,
          lexicalFallback: false
        }, path);
        if (flag === "--invalid-tokens") {
          await expect(crawl).rejects.toBeInstanceOf(CrawlError);
          await expect(crawl).rejects.toMatchObject({
            summary: { requestFailures: 1 }
          });
        } else {
          expect((await crawl).requestFailures).toBe(0);
        }
        const index = openIndex(path);
        try {
          expect(index.semanticTokensLegend).toBeUndefined();
        } finally {
          index.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("indexes local references and resumes completed probes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-crawler-"));
    try {
      const databasePath = join(directory, "index.db");
      const logPath = join(directory, "server.log");
      await writeFile(
        join(directory, "sample.toy"),
        "let value = 1;\nprint(value);\n"
      );
      const config: CrawlerConfig = {
        workspaceRoot: directory,
        server: {
          command: process.execPath,
          args: [
            resolve(
              import.meta.dirname,
              "../test/fake-lsp-server.mjs"
            ),
            logPath,
            "--highlighting"
          ],
          cwd: directory,
          environment: {},
          requestResponses: {}
        },
        documents: [{ languageId: "toy", extensions: [".toy"] }],
        concurrency: 1,
        requestTimeoutMilliseconds: 5_000,
        workspaceLoadTimeoutMilliseconds: 5_000,
        settleMilliseconds: 0,
        lexicalFallback: false
      };

      const progress: Array<{
        readonly elapsedMilliseconds: number;
        readonly documentsPerSecond: number;
        readonly estimatedRemainingMilliseconds: number;
      }> = [];
      const messages: string[] = [];
      const first = await crawlWorkspace(config, databasePath, {
        onLog: (message) => messages.push(message),
        onProgress: (value) => progress.push(value)
      });
      expect(first).toMatchObject({
        documentCount: 1,
        requestFailures: 0,
        database: { documentCount: 1, occurrenceCount: 3 }
      });
      expect(progress.at(-1)).toMatchObject({
        estimatedRemainingMilliseconds: 0
      });
      expect(progress.at(-1)?.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
      expect(progress.at(-1)?.documentsPerSecond).toBeGreaterThan(0);
      for (const duration of Object.values(first.timings)) {
        expect(duration).toBeGreaterThanOrEqual(0);
      }
      expect(first.timings.totalMilliseconds)
        .toBeGreaterThanOrEqual(first.timings.documentCrawlMilliseconds);
      expect(messages[0]).toBe("[crawler] [info] Crawl started.");
      expect(messages.at(-1))
        .toBe("[crawler] [info] Crawl completed successfully.");
      const index = openIndex(databasePath);
      expect(index.semanticTokensLegend).toEqual({
        tokenTypes: ["variable", "function", "keyword", "number"],
        tokenModifiers: ["declaration"]
      });
      expect(index.semanticTokens("sample.toy")).toEqual({
        contentHash: createHash("sha256").update("let value = 1;\nprint(value);\n").digest("hex"),
        data: [0, 0, 3, 2, 0, 0, 4, 5, 0, 1, 0, 8, 1, 3, 0, 1, 0, 5, 1, 0, 0, 6, 5, 0, 0]
      });
      expect(index.references(
        "sample.toy",
        { line: 1, character: 7 },
        true
      )).toHaveLength(2);
      expect(index.references(
        "sample.toy",
        { line: 1, character: 7 },
        false
      )).toHaveLength(1);
      expect(index.hover("sample.toy", { line: 1, character: 7 })?.contents)
        .toEqual({ kind: "markdown", value: "`int value`" });
      index.close();

      const firstCounts = await methodCounts(logPath);
      expect(firstCounts.get("textDocument/semanticTokens/full")).toBe(1);
      expect(firstCounts.get("textDocument/documentHighlight") ?? 0).toBe(0);
      await crawlWorkspace(config, databasePath);
      const secondCounts = await methodCounts(logPath);
      expect(secondCounts.get("textDocument/references"))
        .toBe(firstCounts.get("textDocument/references"));
      expect(secondCounts.get("textDocument/hover"))
        .toBe(firstCounts.get("textDocument/hover"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses cross-document answers before probing occurrences", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-reuse-"));
    try {
      const databasePath = join(directory, "index.db");
      const logPath = join(directory, "server.log");
      const content = "let value = 1;\nprint(value);\n";
      await Promise.all([
        writeFile(join(directory, "sample-a.toy"), content),
        writeFile(join(directory, "sample-b.toy"), content)
      ]);
      const config: CrawlerConfig = {
        workspaceRoot: directory,
        server: {
          command: process.execPath,
          args: [
            resolve(import.meta.dirname, "../test/fake-lsp-server.mjs"),
            logPath,
            "--cross-document-references"
          ],
          cwd: directory,
          environment: {},
          requestResponses: {}
        },
        documents: [{ languageId: "toy", extensions: [".toy"] }],
        concurrency: 1,
        requestTimeoutMilliseconds: 5_000,
        workspaceLoadTimeoutMilliseconds: 5_000,
        settleMilliseconds: 0,
        lexicalFallback: false
      };

      const summary = await crawlWorkspace(config, databasePath);
      expect(summary.database).toMatchObject({
        documentCount: 2,
        occurrenceCount: 6,
        completedAnswerCount: 24,
        completedHoverCount: 6
      });
      const counts = await methodCounts(logPath);
      expect(counts.get("textDocument/references")).toBe(2);
      expect(counts.get("textDocument/definition")).toBe(2);
      expect(counts.get("textDocument/declaration")).toBe(2);
      expect(counts.get("textDocument/documentHighlight") ?? 0).toBe(0);
      expect(summary.requestStatistics.find(
        (request) => request.method === "textDocument/references"
      )).toMatchObject({
        requestCount: 2,
        succeeded: 2,
        failed: 0
      });

      const index = openIndex(databasePath);
      expect(index.references(
        "sample-b.toy",
        { line: 1, character: 7 },
        true
      )).toHaveLength(4);
      index.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a symbol graph provider and preserves diagnostics without falling back on failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-symbols-"));
    try {
      const content = "let value = 1;\nprint(value);\n";
      await writeFile(join(directory, "sample.toy"), content);
      const serverPath = resolve(
        import.meta.dirname,
        "../test/fake-lsp-server.mjs"
      );
      const config: CrawlerConfig = {
        workspaceRoot: directory,
        server: {
          command: process.execPath,
          args: [serverPath, join(directory, "server.log")],
          cwd: directory,
          environment: {},
          requestResponses: {}
        },
        documents: [{ languageId: "toy", extensions: [".toy"] }],
        concurrency: 1,
        requestTimeoutMilliseconds: 5_000,
        workspaceLoadTimeoutMilliseconds: 5_000,
        settleMilliseconds: 0,
        lexicalFallback: false
      };
      const graphDatabasePath = join(directory, "graph.db");
      const messages: string[] = [];
      const graphSummary = await crawlWorkspace(config, graphDatabasePath, {
        onLog: (message) => messages.push(message),
        symbolGraphProvider: {
          name: "test-provider",
          languageIds: new Set(["toy"]),
          async populateSymbolGraph(_client, documents, onChunk) {
            const uri = documents[0]!.uri;
            onChunk({
              symbols: [{
                providerKey: "value",
                displayName: "value",
                occurrences: [
                  {
                    uri,
                    range: {
                      start: { line: 0, character: 4 },
                      end: { line: 0, character: 9 }
                    },
                    isDefinition: true
                  },
                  {
                    uri,
                    range: {
                      start: { line: 1, character: 0 },
                      end: { line: 1, character: 5 }
                    },
                    isDefinition: false
                  },
                  {
                    uri,
                    range: {
                      start: { line: 1, character: 6 },
                      end: { line: 1, character: 11 }
                    },
                    isDefinition: false
                  }
                ],
                definitions: [{
                  uri,
                  range: {
                    start: { line: 0, character: 4 },
                    end: { line: 0, character: 9 }
                  }
                }]
              }],
              processedDocumentUris: [uri],
              missingDocumentUris: [],
              failures: [],
              metrics: {
                requestMilliseconds: 12,
                symbolResolutionMilliseconds: 10
              }
            });
          }
        }
      });
      expect(graphSummary.symbolGraph).toMatchObject({
        provider: "test-provider",
        status: "used",
        populatedOccurrenceCount: 3,
        symbolCount: 1,
        metrics: {
          chunkCount: 1,
          processedDocumentCount: 1,
          requestMilliseconds: 12,
          symbolResolutionMilliseconds: 10
        }
      });
      expect(graphSummary.symbolGraph?.metrics?.["ingestionMilliseconds"])
        .toBeGreaterThanOrEqual(0);
      expect(messages.some((message) => (
        message.includes("Symbol graph chunk 1:")
        && message.includes("3 occurrence(s) committed")
        && message.includes("request 12ms, server 10ms, ingestion")
      ))).toBe(true);
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/references") ?? 0).toBe(0);
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/definition") ?? 0).toBe(0);
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/hover") ?? 0).toBe(0);
      const index = openIndex(graphDatabasePath);
      expect(index.semanticTokens("sample.toy")?.data)
        .toEqual([0, 4, 5, 0, 1, 1, 0, 5, 1, 0, 0, 6, 5, 0, 0]);
      expect(graphSummary.requestStatistics.find(
        (request) => request.method === "textDocument/semanticTokens/full"
      )?.requestCount).toBe(1);
      expect(index.references(
        "sample.toy",
        { line: 1, character: 7 },
        true
      )).toHaveLength(3);
      index.close();

      const requiredLogPath = join(directory, "required.log");
      const failure = crawlWorkspace(
        {
          ...config,
          server: {
            ...config.server,
            args: [serverPath, requiredLogPath]
          }
        },
        join(directory, "required.db"),
        {
          onLog: (message) => messages.push(message),
          symbolGraphProvider: {
            name: "required-provider",
            languageIds: new Set(["toy"]),
            async populateSymbolGraph(_client, documents, onChunk) {
              onChunk({
                symbols: [],
                processedDocumentUris: [],
                missingDocumentUris: [],
                failures: [{
                  uri: documents[0]!.uri,
                  message: "Expected document failure."
                }],
                metrics: {
                  requestMilliseconds: 6,
                  symbolResolutionMilliseconds: 5
                }
              });
            }
          }
        }
      );
      await expect(failure).rejects.toBeInstanceOf(CrawlError);
      await expect(failure).rejects.toMatchObject({
        message: expect.stringContaining("Required symbol graph provider"),
        summary: {
          documentsCompleted: 0,
          requestFailures: 1,
          symbolGraph: {
            provider: "required-provider",
            status: "failed",
            metrics: {
              chunkCount: 1,
              failedDocumentCount: 1,
              requestMilliseconds: 6,
              symbolResolutionMilliseconds: 5,
              ingestionMilliseconds: expect.any(Number),
              cleanupMilliseconds: expect.any(Number)
            }
          },
          timings: {
            symbolGraphMilliseconds: expect.any(Number),
            totalMilliseconds: expect.any(Number)
          },
          requestStatistics: expect.arrayContaining([
            expect.objectContaining({ method: "initialize", succeeded: 1 })
          ])
        }
      });
      expect(messages).toContainEqual(
        expect.stringContaining("Expected document failure.")
      );
      expect(messages).toContainEqual(
        expect.stringContaining("failed after 1 chunk(s)")
      );
      expect((await methodCounts(requiredLogPath))
        .get("textDocument/references") ?? 0).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["request", "ingestion", "activation"])(
    "preserves partial symbol graph diagnostics on %s errors",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "codewise-graph-error-"));
      const databasePath = join(directory, "index.db");
      const logPath = join(directory, "server.log");
      const messages: string[] = [];
      try {
        await writeFile(join(directory, "sample.toy"), "let value = 1;\n");
        const config: CrawlerConfig = {
          workspaceRoot: directory,
          server: {
            command: process.execPath,
            args: [
              resolve(import.meta.dirname, "../test/fake-lsp-server.mjs"),
              logPath
            ],
            cwd: directory,
            environment: {},
            requestResponses: {}
          },
          documents: [{ languageId: "toy", extensions: [".toy"] }],
          concurrency: 1,
          requestTimeoutMilliseconds: 5_000,
          workspaceLoadTimeoutMilliseconds: 5_000,
          settleMilliseconds: 0,
          lexicalFallback: false
        };
        const result = crawlWorkspace(config, databasePath, {
          onLog: (message) => messages.push(message),
          symbolGraphProvider: {
            name: "failing-provider",
            languageIds: new Set(["toy"]),
            async populateSymbolGraph(_client, documents, onChunk) {
              if (failure === "activation") {
                throw new Error("Extension activation failed.");
              }
              const chunk = {
                symbols: [{
                  providerKey: "value",
                  occurrences: [{
                    uri: documents[0]!.uri,
                    range: {
                      start: { line: 0, character: 4 },
                      end: { line: 0, character: 9 }
                    },
                    isDefinition: true
                  }],
                  definitions: []
                }],
                processedDocumentUris: [documents[0]!.uri],
                missingDocumentUris: [],
                failures: [],
                metrics: { symbolResolutionMilliseconds: 7 }
              };
              onChunk(chunk);
              if (failure === "request") {
                throw new LspRequestTimeoutError("workspace/test", 5_000);
              }
              onChunk(chunk);
            }
          }
        });
        await expect(result).rejects.toBeInstanceOf(CrawlError);
        await expect(result).rejects.toMatchObject({
          message: expect.stringContaining(
            failure === "activation" ? "Extension activation failed."
              : failure === "request" ? "workspace/test timed out"
                : "UNIQUE constraint failed: occurrence_symbols"
          ),
          summary: {
            requestFailures: 1,
            symbolGraph: {
              status: "failed",
              populatedOccurrenceCount: failure === "activation" ? 0 : 1,
              metrics: {
                chunkCount: failure === "activation" ? 0
                  : failure === "ingestion" ? 2 : 1,
                ingestionMilliseconds: expect.any(Number),
                cleanupMilliseconds: expect.any(Number)
              }
            }
          }
        });
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          if (failure !== "activation") {
            expect(database.prepare("SELECT COUNT(*) AS count FROM occurrence_symbols")
              .get()?.["count"]).toBe(0);
            expect(database.prepare("SELECT COUNT(*) AS count FROM symbols")
              .get()?.["count"]).toBe(0);
          }
        } finally {
          database.close();
        }
        expect(messages.at(-1)).toBe("[crawler] [error] Crawl failed.");
        if (failure === "ingestion") {
          expect(messages).toContainEqual(expect.stringContaining(
            "[error] Symbol graph chunk 2:"
          ));
        }
        expect((await methodCounts(logPath)).get("textDocument/references") ?? 0)
          .toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("treats an unfinished workspace progress token as advisory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-progress-"));
    const serverPath = resolve(
      import.meta.dirname,
      "../test/fake-lsp-server.mjs"
    );
    const config: CrawlerConfig = {
      workspaceRoot: directory,
      server: {
        command: process.execPath,
        args: [serverPath, join(directory, "server.log"), "--stuck-progress"],
        cwd: directory,
        environment: {},
        requestResponses: {}
      },
      documents: [{ languageId: "toy", extensions: [".toy"] }],
      concurrency: 1,
      requestTimeoutMilliseconds: 5_000,
      workspaceLoadTimeoutMilliseconds: 10,
      settleMilliseconds: 0,
      lexicalFallback: false
    };
    const client = new LspProcessClient(config);
    try {
      await client.start();
      await expect(client.waitForIdle()).resolves.toBe(false);
    } finally {
      await client.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("includes recent server stderr when startup exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-exit-"));
    const serverPath = resolve(
      import.meta.dirname,
      "../test/fake-lsp-server.mjs"
    );
    const config: CrawlerConfig = {
      workspaceRoot: directory,
      server: {
        command: process.execPath,
        args: [serverPath, join(directory, "server.log"), "--exit-on-initialize"],
        cwd: directory,
        environment: {},
        requestResponses: {}
      },
      documents: [{ languageId: "toy", extensions: [".toy"] }],
      concurrency: 1,
      requestTimeoutMilliseconds: 5_000,
      workspaceLoadTimeoutMilliseconds: 5_000,
      settleMilliseconds: 0,
      lexicalFallback: false
    };
    const client = new LspProcessClient(config);
    try {
      await expect(client.start()).rejects.toThrow(
        /Recent server stderr:\nFake language server startup failed\./u
      );
    } finally {
      await client.stop().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels timed-out language server requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-timeout-"));
    const logPath = join(directory, "server.log");
    const config: CrawlerConfig = {
      workspaceRoot: directory,
      server: {
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, "../test/fake-lsp-server.mjs"),
          logPath,
          "--hang-references"
        ],
        cwd: directory,
        environment: {},
        requestResponses: {}
      },
      documents: [{ languageId: "toy", extensions: [".toy"] }],
      concurrency: 1,
      requestTimeoutMilliseconds: 1_000,
      workspaceLoadTimeoutMilliseconds: 5_000,
      settleMilliseconds: 0,
      lexicalFallback: false
    };
    const client = new LspProcessClient(config);
    try {
      await client.start();
      await expect(client.request(
        "textDocument/references",
        {
          textDocument: { uri: "file:///sample.toy" },
          position: { line: 0, character: 0 },
          context: { includeDeclaration: true }
        },
        10
      )).rejects.toBeInstanceOf(LspRequestTimeoutError);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      expect((await methodCounts(logPath)).get("$/cancelRequest")).toBe(1);
    } finally {
      await client.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs a terminal failure after language-server startup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-failure-log-"));
    try {
      await writeFile(join(directory, "sample.toy"), "let value = 1;\n");
      const messages: string[] = [];
      await expect(crawlWorkspace(
        {
          workspaceRoot: directory,
          server: {
            command: process.execPath,
            args: [
              resolve(
                import.meta.dirname,
                "../test/fake-lsp-server.mjs"
              ),
              join(directory, "server.log"),
              "--exit-on-initialize"
            ],
            cwd: directory,
            environment: {},
            requestResponses: {}
          },
          documents: [{ languageId: "toy", extensions: [".toy"] }],
          concurrency: 1,
          requestTimeoutMilliseconds: 5_000,
          workspaceLoadTimeoutMilliseconds: 5_000,
          settleMilliseconds: 0,
          lexicalFallback: false
        },
        join(directory, "index.db"),
        { onLog: (message) => messages.push(message) }
      )).rejects.toThrow("Fake language server startup failed.");
      expect(messages[0]).toBe("[crawler] [info] Crawl started.");
      expect(messages.at(-1)).toBe("[crawler] [error] Crawl failed.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function openIndex(path: string): CodeIndex {
  return new CodeIndex(new TestSqlDatabase(new DatabaseSync(path, {
    readOnly: true
  })));
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

async function methodCounts(path: string): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  for (const method of (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean)) {
    counts.set(method, (counts.get(method) ?? 0) + 1);
  }
  return counts;
}
