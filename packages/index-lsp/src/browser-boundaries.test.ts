import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const browserSafeFiles = [
  "packages/index-core/src/code-index.ts",
  "packages/index-core/src/index.ts",
  "packages/index-core/src/schema.ts",
  "packages/index-core/src/types.ts",
  "packages/index-lsp/src/index-source.ts",
  "packages/index-lsp/src/server.ts",
  "packages/index-lsp/src/workspace-uri-mapper.ts"
];

describe("browser boundaries", () => {
  it("keeps shared index and LSP modules free of Node and VS Code imports", async () => {
    for (const relativePath of browserSafeFiles) {
      const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/from\s+["']node:/u);
      expect(source, relativePath).not.toMatch(/from\s+["']vscode["']/u);
      expect(source, relativePath).not.toMatch(/vscode-languageserver\/node/u);
    }
  });
});
