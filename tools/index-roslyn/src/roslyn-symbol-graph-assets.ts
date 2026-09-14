import { statSync } from "node:fs";
import { join } from "node:path";

export interface RoslynSymbolGraphAssets {
  readonly assemblyFilePath: string;
  readonly languageServiceAssemblyPaths: readonly string[];
}

export function resolveRoslynSymbolGraphAssets(
  repositoryRoot: string
): RoslynSymbolGraphAssets {
  const outputDirectory = join(
    repositoryRoot,
    "tools",
    "roslyn-index-extension",
    "bin",
    "Release",
    "net10.0"
  );
  const assemblyFilePath = join(outputDirectory, "Codewise.RoslynExtension.dll");
  const languageServiceAssemblyPaths = [
    "Microsoft.CodeAnalysis.VisualBasic.dll",
    "Microsoft.CodeAnalysis.VisualBasic.Workspaces.dll"
  ].map((name) => join(outputDirectory, "visual-basic", name));
  for (const path of [assemblyFilePath, ...languageServiceAssemblyPaths]) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size === 0) {
      throw new Error(
        `Roslyn symbol graph requires ${path}. `
        + "Run npm run build:roslyn-extension before indexing."
      );
    }
  }
  return { assemblyFilePath, languageServiceAssemblyPaths };
}
