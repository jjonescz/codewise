import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRoslynSymbolGraphAssets } from "./roslyn-symbol-graph-assets.js";

const relativeAssets = [
  "Codewise.RoslynExtension.dll",
  join("visual-basic", "Microsoft.CodeAnalysis.VisualBasic.dll"),
  join("visual-basic", "Microsoft.CodeAnalysis.VisualBasic.Workspaces.dll")
];

describe("resolveRoslynSymbolGraphAssets", () => {
  it("resolves the walker and colocated VB language services", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-roslyn-assets-"));
    try {
      const paths = await createAssets(directory);

      expect(resolveRoslynSymbolGraphAssets(directory)).toEqual({
        assemblyFilePath: paths[0],
        languageServiceAssemblyPaths: paths.slice(1)
      });
      expect(dirname(paths[1]!)).toBe(dirname(paths[2]!));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(relativeAssets)("rejects missing %s instead of falling back", async (asset) => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-roslyn-assets-"));
    try {
      const paths = await createAssets(directory);
      await rm(paths[relativeAssets.indexOf(asset)]!);

      expect(() => resolveRoslynSymbolGraphAssets(directory))
        .toThrow("Run npm run build:roslyn-extension before indexing.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an empty language-service assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codewise-roslyn-assets-"));
    try {
      const paths = await createAssets(directory);
      await writeFile(paths[1]!, "");

      expect(() => resolveRoslynSymbolGraphAssets(directory))
        .toThrow("Run npm run build:roslyn-extension before indexing.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function createAssets(directory: string): Promise<readonly string[]> {
  const outputDirectory = join(
    directory, "tools", "roslyn-index-extension", "bin", "Release", "net10.0"
  );
  const paths = relativeAssets.map((asset) => join(outputDirectory, asset));
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "test assembly");
  }
  return paths;
}
