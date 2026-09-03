import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIndexOutputPaths } from "./output-paths.js";

describe("resolveIndexOutputPaths", () => {
  it("uses the workspace artifact directory by default", () => {
    const workspaceRoot = resolve("workspace", "repository");

    expect(resolveIndexOutputPaths(workspaceRoot)).toEqual({
      databasePath: join(workspaceRoot, "artifacts", ".codewise", "index.db"),
      logPath: join(workspaceRoot, "artifacts", ".codewise", "lsp-crawler.log"),
      manifestPath: join(
        workspaceRoot,
        "artifacts",
        ".codewise",
        "manifest.json"
      )
    });
  });

  it("places sidecars beside a configured database", () => {
    const workspaceRoot = resolve("workspace", "repository");
    const databasePath = resolve("output", "custom.db");

    expect(resolveIndexOutputPaths(workspaceRoot, databasePath)).toEqual({
      databasePath,
      logPath: resolve("output", "lsp-crawler.log"),
      manifestPath: resolve("output", "manifest.json")
    });
  });
});
