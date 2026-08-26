import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { IndexLoadContext, IndexSource, LoadedIndex } from "./index-source.js";
import { URI } from "vscode-uri";

export class NodeFileIndexSource implements IndexSource {
  readonly #commandLineIndexPath: string | undefined;

  public constructor(commandLineIndexPath?: string) {
    this.#commandLineIndexPath = commandLineIndexPath;
  }

  public async load(context: IndexLoadContext): Promise<LoadedIndex> {
    const indexPath = this.#resolveIndexPath(context);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(indexPath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read SCIP index '${indexPath}': ${detail}`, { cause: error });
    }

    if (bytes.byteLength === 0) {
      throw new Error(`SCIP index is empty: ${indexPath}`);
    }

    return {
      bytes,
      description: indexPath
    };
  }

  #resolveIndexPath(context: IndexLoadContext): string {
    const configured = this.#commandLineIndexPath ?? context.configuredIndexPath;
    if (configured !== undefined && configured.trim() !== "") {
      return isAbsolute(configured) ? configured : resolve(configured);
    }

    const workspace = URI.parse(context.workspaceUri);
    if (workspace.scheme !== "file") {
      throw new Error(
        "An explicit index path is required when the workspace does not use the file URI scheme."
      );
    }

    return resolve(workspace.fsPath, ".scip", "index.scip");
  }
}

