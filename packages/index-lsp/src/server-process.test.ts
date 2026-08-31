import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from "vscode-jsonrpc/node";
import { afterEach, describe, expect, it } from "vitest";
import { createIndexSchemaSql } from "@codewise/index-core";

interface RunningServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: MessageConnection;
  readonly stderr: string[];
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serverPath = resolve(repositoryRoot, "packages/index-lsp/dist/node.js");
const runningServers: RunningServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of runningServers.splice(0)) {
    await server.connection.sendRequest("shutdown").catch(() => undefined);
    server.connection.sendNotification("exit");
    server.connection.dispose();
    await waitForExit(server.child);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Node index language server", () => {
  it("serves definition, references, and hover over stdio", async () => {
    const indexPath = await createFixtureIndex();
    const server = startServer(indexPath);
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

    const request = {
      textDocument: { uri: "file:///workspace/src/Widget.cs" },
      position: { line: 3, character: 10 }
    };
    expect(await server.connection.sendRequest(
      "textDocument/definition",
      request
    )).toEqual([{
      uri: "file:///workspace/src/Widget.cs",
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 19 }
      }
    }]);
    expect(await server.connection.sendRequest(
      "textDocument/references",
      { ...request, context: { includeDeclaration: false } }
    )).toHaveLength(1);
    expect(await server.connection.sendRequest(
      "textDocument/hover",
      request
    )).toMatchObject({
      contents: { value: expect.stringContaining("class Widget") }
    });
    expect(server.stderr.join("")).toBe("");
  });

  it("rejects initialization when the index is missing", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "codewise-index-lsp-"));
    temporaryDirectories.push(directory);
    const server = startServer(resolve(directory, "missing.db"));
    await expect(initialize(server.connection)).rejects.toMatchObject({
      message: expect.stringContaining("Unable to read Codewise index")
    });
  });
});

async function createFixtureIndex(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "codewise-index-lsp-"));
  temporaryDirectories.push(directory);
  const path = resolve(directory, "index.db");
  const database = new DatabaseSync(path);
  database.exec(createIndexSchemaSql);
  const uri = "file:///crawler/src/Widget.cs";
  database.prepare(`
    INSERT INTO documents (
      id, uri, relative_path, language_id, content_hash, position_encoding
    ) VALUES (1, ?, 'src/Widget.cs', 'csharp', 'hash', 'utf-16')
  `).run(uri);
  database.exec(`
    INSERT INTO occurrences (
      id, document_id, start_line, start_character, end_line, end_character,
      start_key, end_key, discovery_source
    ) VALUES
      (1, 1, 0, 13, 0, 19, 13, 19, 'semantic-token'),
      (2, 1, 3, 8, 3, 14, 12884901896, 12884901902, 'semantic-token');
    INSERT INTO answer_sets (id, kind, content_hash) VALUES
      (1, 'definition', 'definition'),
      (2, 'references', 'references');
  `);
  const location = database.prepare(`
    INSERT INTO answer_locations (
      answer_set_id, ordinal, uri, start_line, start_character,
      end_line, end_character
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  location.run(1, 0, uri, 0, 13, 0, 19);
  location.run(2, 0, uri, 0, 13, 0, 19);
  location.run(2, 1, uri, 3, 8, 3, 14);
  database.exec(`
    INSERT INTO occurrence_answers (
      occurrence_id, kind, answer_set_id, status, attempt_count
    ) VALUES
      (2, 'definition', 1, 'complete', 1),
      (2, 'references', 2, 'complete', 1);
  `);
  database.prepare(`
    INSERT INTO hover_results (
      occurrence_id, status, contents_json, attempt_count
    ) VALUES (2, 'complete', ?, 1)
  `).run(JSON.stringify({
    kind: "markdown",
    value: "```csharp\nclass Widget\n```"
  }));
  database.close();
  return path;
}

function startServer(indexPath: string): RunningServer {
  const child = spawn(
    process.execPath,
    [serverPath, "--stdio", "--index", indexPath],
    {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
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

function initialize(connection: MessageConnection): Promise<unknown> {
  return connection.sendRequest("initialize", {
    processId: null,
    rootUri: "file:///workspace",
    capabilities: {},
    workspaceFolders: [{ name: "workspace", uri: "file:///workspace" }]
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolveExit();
    }, 1_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
