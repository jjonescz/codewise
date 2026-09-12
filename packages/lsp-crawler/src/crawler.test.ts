import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodeIndex, type SqlDatabase, type SqlRow, type SqlValue } from "@codewise/index-core";
import {
  LspProcessClient,
  LspRequestTimeoutError
} from "./client.js";
import type { CrawlerConfig } from "./config.js";
import { crawlWorkspace } from "./crawler.js";

describe("crawlWorkspace", () => {
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

  it("uses a symbol graph provider and falls back when it fails", async () => {
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
      const graphSummary = await crawlWorkspace(config, graphDatabasePath, {
        symbolGraphProvider: {
          name: "test-provider",
          languageIds: new Set(["toy"]),
          fallbackToLsp: false,
          async populateSymbolGraph(_client, documents, onChunk) {
            const occurrences = documents.flatMap(
              (document) => document.occurrences
            );
            onChunk({
              symbols: [{
                providerKey: "value",
                displayName: "value",
                occurrences: occurrences.map((occurrence, index) => ({
                  occurrenceId: occurrence.id,
                  isDefinition: index === 0
                })),
                definitions: [{
                  uri: documents[0]!.uri,
                  range: occurrences[0]!.range
                }]
              }],
              unresolvedOccurrenceIds: []
            });
          }
        }
      });
      expect(graphSummary.symbolGraph).toMatchObject({
        provider: "test-provider",
        status: "used",
        populatedOccurrenceCount: 3,
        symbolCount: 1
      });
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/references") ?? 0).toBe(0);
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/definition") ?? 0).toBe(0);
      expect((await methodCounts(join(directory, "server.log")))
        .get("textDocument/hover") ?? 0).toBe(0);
      const index = openIndex(graphDatabasePath);
      expect(index.references(
        "sample.toy",
        { line: 1, character: 7 },
        true
      )).toHaveLength(3);
      index.close();

      const fallbackLogPath = join(directory, "fallback.log");
      const fallbackSummary = await crawlWorkspace(
        {
          ...config,
          server: {
            ...config.server,
            args: [serverPath, fallbackLogPath]
          }
        },
        graphDatabasePath,
        {
          symbolGraphProvider: {
            name: "failing-provider",
            languageIds: new Set(["toy"]),
            fallbackToLsp: true,
            populateSymbolGraph() {
              throw new LspRequestTimeoutError("test/symbolGraph", 10);
            }
          }
        }
      );
      expect(fallbackSummary.symbolGraph).toMatchObject({
        provider: "failing-provider",
        status: "fallback",
        populatedOccurrenceCount: 0
      });
      expect((await methodCounts(fallbackLogPath))
        .get("textDocument/references")).toBeGreaterThan(0);
      const fallbackDatabase = new DatabaseSync(graphDatabasePath, {
        readOnly: true
      });
      expect(fallbackDatabase.prepare(
        "SELECT COUNT(*) AS count FROM occurrence_symbols"
      ).get()).toMatchObject({ count: 0 });
      fallbackDatabase.close();

      const requiredLogPath = join(directory, "required.log");
      await expect(crawlWorkspace(
        {
          ...config,
          server: {
            ...config.server,
            args: [serverPath, requiredLogPath]
          }
        },
        join(directory, "required.db"),
        {
          symbolGraphProvider: {
            name: "required-provider",
            languageIds: new Set(["toy"]),
            fallbackToLsp: false,
            populateSymbolGraph() {
              throw new Error("Expected required provider failure.");
            }
          }
        }
      )).rejects.toThrow("Required symbol graph provider");
      expect((await methodCounts(requiredLogPath))
        .get("textDocument/references") ?? 0).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
