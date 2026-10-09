import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCrawlerConfig } from "./config.js";

describe("loadCrawlerConfig", () => {
  it("resolves paths and applies defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-config-"));
    try {
      const path = join(directory, "crawler.json");
      await writeFile(path, JSON.stringify({
        workspaceRoot: "workspace",
        server: {
          command: "language-server",
          args: ["--stdio"],
          requestResponses: { "custom/synchronize": null }
        },
        documents: [{ languageId: "csharp", extensions: [".CS", ".cs"] }]
      }));
      const config = await loadCrawlerConfig(path);
      expect(config.workspaceRoot).toBe(join(directory, "workspace"));
      expect(config.documents[0]?.extensions).toEqual([".cs"]);
      expect(config.server.requestResponses).toEqual({
        "custom/synchronize": null
      });
      expect(config.concurrency).toBe(4);
      expect(config.workspaceLoadTimeoutMilliseconds).toBe(300_000);
      expect(config.lexicalFallback).toBe(false);
      expect(config.unicodeLineBreaks).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([true, false, "unicode"])("validates upstream Unicode line-break configuration (%s)", async (value) => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-lsp-config-"));
    try {
      const path = join(directory, "crawler.json");
      await writeFile(path, JSON.stringify({
        workspaceRoot: "workspace", server: { command: "language-server" },
        documents: [{ languageId: "csharp", extensions: [".cs"] }],
        unicodeLineBreaks: value
      }));
      if (typeof value === "boolean") {
        expect((await loadCrawlerConfig(path)).unicodeLineBreaks).toBe(value);
      } else {
        await expect(loadCrawlerConfig(path)).rejects.toThrow("unicodeLineBreaks must be a boolean");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
