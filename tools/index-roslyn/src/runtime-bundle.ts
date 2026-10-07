import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { exportRuntimeIndex } from "@codewise/lsp-crawler";
import { hashFile } from "./file-hash.js";
import { resolveRuntimeOutputPaths } from "./output-paths.js";

export async function exportRuntimeBundle<T extends {
  readonly byteSize: number;
  readonly sha256: string;
}>(databasePath: string, manifest: T) {
  const paths = resolveRuntimeOutputPaths(databasePath);
  const startedAt = performance.now();
  const exported = exportRuntimeIndex(databasePath, paths.databasePath);
  const runtimeManifest = {
    ...manifest,
    byteSize: exported.byteSize,
    sha256: await hashFile(paths.databasePath),
    runtimeExport: {
      schemaVersion: exported.schemaVersion,
      sourceByteSize: exported.sourceByteSize,
      generationDurationMilliseconds: Math.round(performance.now() - startedAt)
    }
  };
  writeFileSync(
    paths.manifestPath,
    `${JSON.stringify(runtimeManifest, undefined, 2)}\n`,
    "utf8"
  );
  return { ...exported, ...paths };
}
