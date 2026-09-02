import { appendFileSync } from "node:fs";

const logPath = process.argv[2];
if (logPath === undefined) {
  throw new Error("Fake LSP server requires a log path.");
}

let buffer = Buffer.alloc(0);
let documentUri = "";
const stuckProgress = process.argv.includes("--stuck-progress");
const exitOnInitialize = process.argv.includes("--exit-on-initialize");
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
    if (message.method === "textDocument/didOpen") {
      documentUri = message.params.textDocument.uri;
    }
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
          positionEncoding: "utf-16",
          textDocumentSync: 1,
          declarationProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentHighlightProvider: true,
          documentSymbolProvider: true,
          hoverProvider: true,
          semanticTokensProvider: {
            legend: {
              tokenTypes: ["variable", "function"],
              tokenModifiers: ["declaration"]
            },
            full: true,
            range: false
          }
        },
        serverInfo: { name: "fake-lsp", version: "1.0.0" }
      });
      break;
    case "shutdown":
      respond(message.id, null);
      break;
    case "textDocument/semanticTokens/full":
      respond(message.id, {
        data: [0, 4, 5, 0, 1, 1, 0, 5, 1, 0, 0, 6, 5, 0, 0]
      });
      break;
    case "textDocument/documentSymbol":
      respond(message.id, []);
      break;
    case "textDocument/references":
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

function locationsFor(params) {
  return isValueRequest(params)
    ? [location(0, 4, 9), location(1, 6, 11)]
    : [location(1, 0, 5)];
}

function isValueRequest(params) {
  return params.position?.line === 0 || (params.position?.character ?? 0) >= 6;
}

function location(line, start, end) {
  return {
    uri: documentUri,
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
