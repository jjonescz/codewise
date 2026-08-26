import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const browserSafeFiles = [
  "packages/scip-core/src/errors.ts",
  "packages/scip-core/src/index.ts",
  "packages/scip-core/src/paths.ts",
  "packages/scip-core/src/ranges.ts",
  "packages/scip-core/src/scip-index.ts",
  "packages/scip-core/src/types.ts",
  "packages/scip-lsp/src/index-source.ts",
  "packages/scip-lsp/src/server.ts",
  "packages/scip-lsp/src/workspace-uri-mapper.ts"
];

describe("future browser boundaries", () => {
  it("keeps shared SCIP and LSP modules free of Node and VS Code imports", async () => {
    for (const relativePath of browserSafeFiles) {
      const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/from\s+["']node:/u);
      expect(source, relativePath).not.toMatch(/from\s+["']vscode["']/u);
      expect(source, relativePath).not.toMatch(/vscode-languageserver\/node/u);
    }
  });
});

