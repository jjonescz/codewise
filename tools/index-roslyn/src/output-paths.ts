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
