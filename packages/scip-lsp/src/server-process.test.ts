import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from "vscode-jsonrpc/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createFixtureIndexBytes } from "../../scip-core/test/fixture.js";

interface RunningServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: MessageConnection;
  readonly stderr: string[];
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serverPath = resolve(repositoryRoot, "packages/scip-lsp/dist/node.js");
const runningServers: RunningServer[] = [];
const temporaryDirectories: string[] = [];

async function startServer(indexPath: string): Promise<RunningServer> {
  const child = spawn(process.execPath, [serverPath, "--stdio", "--index", indexPath], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin)
  );
  connection.listen();

  const running = { child, connection, stderr };
  runningServers.push(running);
  return running;
}

async function initialize(connection: MessageConnection): Promise<unknown> {
  return connection.sendRequest("initialize", {
    processId: null,
    rootUri: "file:///workspace",
    capabilities: {},
    workspaceFolders: [
      {
        name: "workspace",
        uri: "file:///workspace"
      }
    ]
  });
}

beforeAll(async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "codewise-scip-"));
  temporaryDirectories.push(directory);
  await writeFile(resolve(directory, "index.scip"), createFixtureIndexBytes());
});

afterEach(async () => {
  for (const server of runningServers.splice(0)) {
    server.connection.sendNotification("exit");
    server.connection.dispose();
    await new Promise<void>((resolveExit) => {
      if (server.child.exitCode !== null) {
        resolveExit();
        return;
      }

      const timeout = setTimeout(() => {
        server.child.kill();
        resolveExit();
      }, 1_000);
      server.child.once("close", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
  }
});

describe("Node SCIP language server", () => {
  it("serves definition, references, and hover over stdio", async () => {
    const indexPath = resolve(temporaryDirectories[0]!, "index.scip");
    const server = await startServer(indexPath);
    const initializeResult = await initialize(server.connection) as {
      capabilities: Record<string, unknown>;
    };
    expect(initializeResult.capabilities).toMatchObject({
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      positionEncoding: "utf-16"
    });
    server.connection.sendNotification("initialized", {});

    const definition = await server.connection.sendRequest(
      "textDocument/definition",
      {
        textDocument: { uri: "file:///workspace/src/Widget.cs" },
        position: { line: 3, character: 10 }
      }
    );
    expect(definition).toEqual([
      {
        uri: "file:///workspace/src/Widget.cs",
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 19 }
        }
      }
    ]);

    const references = await server.connection.sendRequest(
      "textDocument/references",
      {
        textDocument: { uri: "file:///workspace/src/Widget.cs" },
        position: { line: 3, character: 10 },
        context: { includeDeclaration: false }
      }
    ) as unknown[];
    expect(references).toHaveLength(1);

    const hover = await server.connection.sendRequest(
      "textDocument/hover",
      {
        textDocument: { uri: "file:///workspace/src/Widget.cs" },
        position: { line: 3, character: 10 }
      }
    ) as { contents: { value: string } };
    expect(hover.contents.value).toContain("class Widget");
    expect(hover.contents.value).toContain("A demo widget.");
    expect(server.stderr.join("")).toBe("");
  });

  it("rejects initialization when the configured index is missing", async () => {
    const server = await startServer(resolve(temporaryDirectories[0]!, "missing.scip"));

    await expect(initialize(server.connection)).rejects.toMatchObject({
      message: expect.stringContaining("Unable to read SCIP index")
    });
  });
});

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});
