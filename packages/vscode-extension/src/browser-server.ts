import {
  CodeIndex,
  type SqlDatabase,
  type SqlRow,
  type SqlValue
} from "@codewise/index-core";
import type {
  IndexLoadContext,
  IndexSource,
  LoadedIndex
} from "@codewise/index-lsp/index-source";
import { registerIndexLanguageServer } from "@codewise/index-lsp/server";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
  ProposedFeatures
} from "vscode-languageserver/browser";
import {
  indexBootstrapErrorKind,
  indexBootstrapReadyKind,
  indexBootstrapRequestKind,
  type IndexBootstrapRequest
} from "./browser-protocol.js";

interface WasmStatement {
  bind(values: readonly SqlValue[]): WasmStatement;
  step(): boolean;
  get(target: Record<string, SqlValue>): Record<string, SqlValue>;
  finalize(): void;
}

interface WasmDatabase {
  pointer?: number;
  prepare(sql: string): WasmStatement;
  close(): void;
}

interface SqliteModule {
  readonly capi: {
    readonly SQLITE_OK: number;
    readonly SQLITE_DESERIALIZE_FREEONCLOSE: number;
    readonly SQLITE_DESERIALIZE_READONLY: number;
    sqlite3_deserialize(
      database: WasmDatabase,
      schema: string,
      pointer: number,
      databaseSize: number,
      bufferSize: number,
      flags: number
    ): number;
  };
  readonly wasm: {
    allocFromTypedArray(bytes: Uint8Array): number;
    dealloc(pointer: number): void;
  };
  readonly oo1: {
    readonly DB: new (filename: string) => WasmDatabase;
  };
}

class MemoryIndexSource implements IndexSource {
  public constructor(private readonly loadedIndex: LoadedIndex) {}

  public load(_context: IndexLoadContext): Promise<LoadedIndex> {
    return Promise.resolve(this.loadedIndex);
  }
}

class WasmSqlDatabase implements SqlDatabase {
  public constructor(private readonly database: WasmDatabase) {}

  public all(
    sql: string,
    parameters: readonly SqlValue[] = []
  ): readonly SqlRow[] {
    const statement = this.database.prepare(sql);
    try {
      if (parameters.length > 0) {
        statement.bind(parameters);
      }
      const rows: Record<string, SqlValue>[] = [];
      while (statement.step()) {
        rows.push(statement.get({}));
      }
      return rows;
    } finally {
      statement.finalize();
    }
  }

  public close(): void {
    this.database.close();
  }
}

const workerScope = globalThis as unknown as Worker;

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  void bootstrap(event.data).catch((error) => {
    workerScope.postMessage({
      kind: indexBootstrapErrorKind,
      message: error instanceof Error ? error.message : String(error)
    });
  });
};

async function bootstrap(value: unknown): Promise<void> {
  const request = parseBootstrapRequest(value);
  const index = await loadWasmIndex(
    new Uint8Array(request.index),
    request.sqliteModuleUri
  );
  const reader = new BrowserMessageReader(workerScope);
  const writer = new BrowserMessageWriter(workerScope);
  const connection = createConnection(ProposedFeatures.all, reader, writer);
  registerIndexLanguageServer(
    connection,
    new MemoryIndexSource({ index, description: request.description })
  );
  connection.listen();
  workerScope.postMessage({ kind: indexBootstrapReadyKind });
}

async function loadWasmIndex(
  bytes: Uint8Array,
  moduleUri: string
): Promise<CodeIndex> {
  const imported = await import(moduleUri) as {
    readonly default?: () => Promise<SqliteModule>;
  };
  if (typeof imported.default !== "function") {
    throw new Error("The SQLite WASM module has no initializer.");
  }
  const sqlite = await imported.default();
  const database = new sqlite.oo1.DB(":memory:");
  const pointer = sqlite.wasm.allocFromTypedArray(bytes);
  let ownsPointer = false;
  try {
    const result = sqlite.capi.sqlite3_deserialize(
      database,
      "main",
      pointer,
      bytes.byteLength,
      bytes.byteLength,
      sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE
        | sqlite.capi.SQLITE_DESERIALIZE_READONLY
    );
    if (result !== sqlite.capi.SQLITE_OK) {
      throw new Error(`SQLite could not deserialize the index (result ${result}).`);
    }
    ownsPointer = true;
    const adapter = new WasmSqlDatabase(database);
    adapter.all("PRAGMA trusted_schema = OFF");
    adapter.all("PRAGMA query_only = ON");
    return new CodeIndex(adapter);
  } catch (error) {
    database.close();
    if (!ownsPointer) {
      sqlite.wasm.dealloc(pointer);
    }
    throw error;
  }
}

function parseBootstrapRequest(value: unknown): IndexBootstrapRequest {
  const kind = typeof value === "object" && value !== null
    ? Reflect.get(value, "kind")
    : undefined;
  const index = typeof value === "object" && value !== null
    ? Reflect.get(value, "index")
    : undefined;
  const description = typeof value === "object" && value !== null
    ? Reflect.get(value, "description")
    : undefined;
  const sqliteModuleUri = typeof value === "object" && value !== null
    ? Reflect.get(value, "sqliteModuleUri")
    : undefined;
  if (
    kind !== indexBootstrapRequestKind
    || !(index instanceof ArrayBuffer)
    || typeof description !== "string"
    || typeof sqliteModuleUri !== "string"
  ) {
    throw new Error("The browser server received an invalid index bootstrap message.");
  }
  if (index.byteLength === 0) {
    throw new Error("The Codewise index is empty.");
  }
  if (description === "" || sqliteModuleUri === "") {
    throw new Error("The index description and SQLite module URI are required.");
  }
  return { kind, index, description, sqliteModuleUri };
}
