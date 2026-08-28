import type {
  IndexLoadContext,
  IndexSource,
  LoadedIndex
} from "@codewise/scip-lsp/index-source";
import { registerScipLanguageServer } from "@codewise/scip-lsp/server";
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

class MemoryIndexSource implements IndexSource {
  readonly #loadedIndex: LoadedIndex;

  public constructor(bytes: Uint8Array, description: string) {
    this.#loadedIndex = { bytes, description };
  }

  public load(_context: IndexLoadContext): Promise<LoadedIndex> {
    return Promise.resolve(this.#loadedIndex);
  }
}

const workerScope = globalThis as unknown as Worker;

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const request = parseBootstrapRequest(event.data);
    const reader = new BrowserMessageReader(workerScope);
    const writer = new BrowserMessageWriter(workerScope);
    const connection = createConnection(ProposedFeatures.all, reader, writer);
    const indexSource = new MemoryIndexSource(
      new Uint8Array(request.index),
      request.description
    );

    registerScipLanguageServer(connection, indexSource);
    connection.listen();
    workerScope.postMessage({ kind: indexBootstrapReadyKind });
  } catch (error) {
    workerScope.postMessage({
      kind: indexBootstrapErrorKind,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};

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
  if (
    kind !== indexBootstrapRequestKind
    || !(index instanceof ArrayBuffer)
    || typeof description !== "string"
  ) {
    throw new Error("The SCIP browser server received an invalid index bootstrap message.");
  }

  if (index.byteLength === 0) {
    throw new Error("The SCIP index is empty.");
  }
  if (description === "") {
    throw new Error("The SCIP index description is empty.");
  }

  return { kind: indexBootstrapRequestKind, index, description };
}
