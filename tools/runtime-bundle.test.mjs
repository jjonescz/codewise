import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrawlerDatabase } from "@codewise/lsp-crawler";
import { describe, expect, it } from "vitest";
import { verifyRoslynIndex } from "../packages/vscode-extension/src/roslyn-index-artifact.ts";
import { hashFile } from "./index-roslyn/src/file-hash.ts";
import { exportRuntimeBundle } from "./index-roslyn/src/runtime-bundle.ts";

describe("exportRuntimeBundle", () => {
  it("writes a matching runtime manifest and preserves the crawl database and manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-runtime-bundle-"));
    const sourcePath = join(directory, "crawl.db");
    const sourceManifestPath = join(directory, "manifest.json");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    try {
      const crawl = new CrawlerDatabase(sourcePath);
      const document = crawl.upsertDocument({
        uri: "file:///crawler/Widget.cs",
        relativePath: "Widget.cs",
        languageId: "csharp",
        contentHash: "hash",
        positionEncoding: "utf-16"
      });
      const range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 6 }
      };
      crawl.appendSymbolGraph("roslyn-symbol-graph", [{
        providerKey: "widget",
        displayName: "Widget",
        occurrences: [{
          documentId: document.id,
          range,
          discoverySource: "semantic-token",
          isDefinition: true
        }],
        definitions: [{ uri: document.uri, range }]
      }]);
      const statistics = crawl.statistics();
      crawl.close();
      const sourceBytes = await readFile(sourcePath);
      const manifest = {
        schemaVersion: 3,
        repositoryCommit: commit,
        byteSize: sourceBytes.byteLength,
        sha256: await hashFile(sourcePath),
        statistics,
        requestStatistics: {}
      };
      const sourceManifest = JSON.stringify(manifest);
      await writeFile(sourceManifestPath, sourceManifest);

      const exported = await exportRuntimeBundle(sourcePath, manifest);
      const runtimeBytes = await readFile(exported.databasePath);
      const manifestBytes = await readFile(exported.manifestPath);
      const runtimeManifest = JSON.parse(manifestBytes.toString());

      expect(exported.databasePath).toBe(join(directory, "runtime", "index.db"));
      expect(exported.manifestPath).toBe(join(directory, "runtime", "manifest.json"));
      expect(runtimeManifest).toMatchObject({
        schemaVersion: 3,
        repositoryCommit: commit,
        byteSize: runtimeBytes.byteLength,
        sha256: await hashFile(exported.databasePath),
        statistics,
        runtimeExport: {
          schemaVersion: 3,
          sourceByteSize: sourceBytes.byteLength,
          generationDurationMilliseconds: expect.any(Number)
        }
      });
      expect(runtimeManifest.sha256).not.toBe(manifest.sha256);
      await expect(verifyRoslynIndex(runtimeBytes, manifestBytes, commit)).resolves.toBeUndefined();
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
      expect(await readFile(sourceManifestPath, "utf8")).toBe(sourceManifest);
      expect(manifest.byteSize).toBe(sourceBytes.byteLength);
      expect(manifest).not.toHaveProperty("runtimeExport");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
