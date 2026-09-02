import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CodeIndex, type SqlDatabase, type SqlRow, type SqlValue } from "@codewise/index-core";
import { LspProcessClient } from "./client.js";
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
      const first = await crawlWorkspace(config, databasePath, {
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
