import { appendFileSync } from "node:fs";

const logPath = process.argv[2];
if (logPath === undefined) {
  throw new Error("Fake LSP server requires a log path.");
}

let buffer = Buffer.alloc(0);
const stuckProgress = process.argv.includes("--stuck-progress");
const exitOnInitialize = process.argv.includes("--exit-on-initialize");
const crossDocumentReferences =
  process.argv.includes("--cross-document-references");
const hangReferences = process.argv.includes("--hang-references");
const highlighting = process.argv.includes("--highlighting");
const unicodeTokens = process.argv.includes("--unicode-tokens");
const invalidTokens = process.argv.includes("--invalid-tokens");
const noSemanticTokens = process.argv.includes("--no-semantic-tokens");
const rangeTokens = process.argv.includes("--range-tokens");
const graphTokenScope = process.argv.includes("--graph-token-scope");
const unicodeNewlineTokens = process.argv.includes("--unicode-newline-tokens");
const standardNewlineTokens = process.argv.includes("--standard-newline-tokens");
const encoding = process.argv.includes("--utf-8") ? "utf-8"
  : process.argv.includes("--utf-32") ? "utf-32" : "utf-16";
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

function readMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length:\s*(\d+)\s*$/imu.exec(header);
    const length = Number(match?.[1]);
    const bodyStart = headerEnd + 4;
    if (!Number.isSafeInteger(length) || buffer.length < bodyStart + length) {
      return;
    }
    const message = JSON.parse(
      buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
    );
    buffer = buffer.subarray(bodyStart + length);
    handleMessage(message);
  }
}

function handleMessage(message) {
  if (message.method === undefined) {
    return;
  }
  appendFileSync(logPath, `${message.method}\n`);
  if (message.method === "exit") {
    process.exit(0);
  }
  if (message.id === undefined) {
    return;
  }

  switch (message.method) {
    case "initialize":
      if (exitOnInitialize) {
        console.error("Fake language server startup failed.");
        process.exit(7);
      }
      if (stuckProgress) {
        write({
          jsonrpc: "2.0",
          method: "$/progress",
          params: {
            token: "workspace-load",
            value: { kind: "begin", title: "Loading workspace" }
          }
        });
      }
      respond(message.id, {
        capabilities: {
          positionEncoding: encoding,
          textDocumentSync: 1,
          declarationProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentHighlightProvider: true,
          documentSymbolProvider: true,
          hoverProvider: true,
          ...(noSemanticTokens ? {} : { semanticTokensProvider: {
            legend: {
              tokenTypes: ["variable", "function", "keyword", "number"],
              tokenModifiers: ["declaration"]
            },
            full: !rangeTokens,
            range: rangeTokens
          } })
        },
        serverInfo: { name: "fake-lsp", version: "1.0.0" }
      });
      break;
    case "shutdown":
      respond(message.id, null);
      break;
    case "textDocument/semanticTokens/full":
    case "textDocument/semanticTokens/range":
      if (
        (unicodeNewlineTokens || standardNewlineTokens)
        && message.method.endsWith("/range")
        && (
          message.params.range.end.line !== (unicodeNewlineTokens ? 6 : 3)
          || message.params.range.end.character !== 5
        )
      ) {
        write({
          jsonrpc: "2.0", id: message.id,
          error: { code: -32000, message: "Wrong source-coordinate range end." }
        });
        break;
      }
      if (graphTokenScope && message.params.textDocument.uri.endsWith("/unloaded.toy")) {
        write({
          jsonrpc: "2.0", id: message.id,
          error: { code: -32000, message: "Unloaded document was queried." }
        });
        break;
      }
      respond(message.id, {
        data: unicodeNewlineTokens || standardNewlineTokens
          ? newlineTokenData()
          : graphTokenScope && message.params.textDocument.uri.endsWith("/keywords.toy")
          ? [0, 0, 3, 2, 0]
          : invalidTokens ? [0, 0, 5, 99, 0]
          : unicodeTokens ? [0, encoding === "utf-8" ? 4 : encoding === "utf-32" ? 1 : 2, 5, 0, 1]
          : highlighting
            ? [0, 0, 3, 2, 0, 0, 4, 5, 0, 1, 0, 8, 1, 3, 0, 1, 0, 5, 1, 0, 0, 6, 5, 0, 0]
            : [0, 4, 5, 0, 1, 1, 0, 5, 1, 0, 0, 6, 5, 0, 0]
      });
      break;
    case "textDocument/documentSymbol":
      respond(message.id, []);
      break;
    case "textDocument/references":
      if (hangReferences) {
        break;
      }
      respond(message.id, locationsFor(message.params));
      break;
    case "textDocument/definition":
    case "textDocument/declaration":
      respond(message.id, [locationsFor(message.params)[0]]);
      break;
    case "textDocument/documentHighlight":
      respond(
        message.id,
        locationsFor(message.params).map((location) => ({ range: location.range }))
      );
      break;
    case "textDocument/hover":
      respond(message.id, {
        contents: {
          kind: "markdown",
          value: isValueRequest(message.params) ? "`int value`" : "`void print()`"
        }
      });
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unknown method ${message.method}` }
      });
  }
}

function newlineTokenData() {
  const prefix = encoding === "utf-8" ? 4 : encoding === "utf-32" ? 1 : 2;
  return unicodeNewlineTokens
    ? [0, prefix, 3, 0, 1, 1, 0, 3, 0, 0, 1, 0, 5, 0, 0, 1, 0, 4, 0, 0,
       1, 0, 4, 0, 0, 1, 0, 3, 0, 0, 1, 0, 5, 0, 0]
    : [0, prefix, 3, 0, 1, 0, encoding === "utf-8" ? 5 : 4, 3, 0, 0,
       0, encoding === "utf-8" ? 6 : 4, 5, 0, 0,
       0, encoding === "utf-8" ? 8 : 6, 4, 0, 0,
       1, 0, 4, 0, 0, 1, 0, 3, 0, 0, 1, 0, 5, 0, 0];
}

function locationsFor(params) {
  const uris = crossDocumentReferences
    ? ["sample-a.toy", "sample-b.toy"].map(
      (name) => new URL(name, params.textDocument.uri).href
    )
    : [params.textDocument.uri];
  return uris.flatMap((uri) => (
    isValueRequest(params)
      ? [location(uri, 0, 4, 9), location(uri, 1, 6, 11)]
      : [location(uri, 1, 0, 5)]
  ));
}

function isValueRequest(params) {
  return params.position?.line === 0 || (params.position?.character ?? 0) >= 6;
}

function location(uri, line, start, end) {
  return {
    uri,
    range: {
      start: { line, character: start },
      end: { line, character: end }
    }
  };
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
