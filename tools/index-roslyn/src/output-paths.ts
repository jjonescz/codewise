import { dirname, resolve } from "node:path";

export interface IndexOutputPaths {
  readonly databasePath: string;
  readonly logPath: string;
  readonly manifestPath: string;
}

export function resolveIndexOutputPaths(
  workspaceRoot: string,
  configuredDatabasePath?: string
): IndexOutputPaths {
  const databasePath = configuredDatabasePath
    ?? resolve(workspaceRoot, "artifacts", ".codewise", "index.db");
  const outputDirectory = dirname(databasePath);
  return {
    databasePath,
    logPath: resolve(outputDirectory, "lsp-crawler.log"),
    manifestPath: resolve(outputDirectory, "manifest.json")
  };
}

export function resolveRuntimeOutputPaths(databasePath: string): {
  readonly databasePath: string;
  readonly manifestPath: string;
} {
  const directory = resolve(dirname(databasePath), "runtime");
  return {
    databasePath: resolve(directory, "index.db"),
    manifestPath: resolve(directory, "manifest.json")
  };
}
