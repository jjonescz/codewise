import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CodeIndex,
  type SqlDatabase,
  type SqlRow,
  type SqlValue
} from "@codewise/index-core";
import { URI } from "vscode-uri";
import type {
  IndexLoadContext,
  IndexSource,
  LoadedIndex
} from "./index-source.js";

export class NodeFileIndexSource implements IndexSource {
  readonly #commandLineIndexPath: string | undefined;

  public constructor(commandLineIndexPath?: string) {
    this.#commandLineIndexPath = commandLineIndexPath;
  }

  public async load(context: IndexLoadContext): Promise<LoadedIndex> {
    const indexPath = this.#resolveIndexPath(context);
    try {
      const bytes = await readFile(indexPath);
      if (bytes.byteLength === 0) {
        throw new Error("The file is empty.");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read Codewise index '${indexPath}': ${detail}`, {
        cause: error
      });
    }

    let database: DatabaseSync;
    try {
      database = new DatabaseSync(indexPath, {
        readOnly: true,
        allowExtension: false,
        enableForeignKeyConstraints: true,
        timeout: 5_000
      });
      database.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
    } catch (error) {
      throw new Error(`Unable to open Codewise index '${indexPath}'.`, {
        cause: error
      });
    }

    try {
      return {
        index: new CodeIndex(new NodeSqlDatabase(database)),
        description: indexPath
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  #resolveIndexPath(context: IndexLoadContext): string {
    const configured = this.#commandLineIndexPath ?? context.configuredIndexPath;
    if (configured !== undefined && configured.trim() !== "") {
      return isAbsolute(configured) ? configured : resolve(configured);
    }

    const workspace = URI.parse(context.workspaceUri);
    if (workspace.scheme !== "file") {
      throw new Error(
        "An explicit index path is required when the workspace is not a file URI."
      );
    }
    return resolve(workspace.fsPath, ".codewise", "index.db");
  }
}

class NodeSqlDatabase implements SqlDatabase {
  public constructor(private readonly database: DatabaseSync) {}

  public all(
    sql: string,
    parameters: readonly SqlValue[] = []
  ): readonly SqlRow[] {
    return this.database.prepare(sql).all(
      ...parameters
    ) as unknown as readonly SqlRow[];
  }

  public close(): void {
    this.database.close();
  }
}
