import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runTests } from "@vscode/test-web";
import { createIndexSchemaSql } from "../packages/index-core/dist/schema.js";

const fixtureSource = [
  "public class Widget {}",
  "",
  "void M() {",
  "    _ = Widget;",
  "}"
].join("\n");

const repositoryRoot = resolve(import.meta.dirname, "..");
const extensionDevelopmentPath = resolve(
  repositoryRoot,
  "packages",
  "vscode-extension"
);
const extensionTestsPath = resolve(
  extensionDevelopmentPath,
  "dist",
  "web",
  "test-runner.cjs"
);
const workspacePath = resolve(
  repositoryRoot,
  "artifacts",
  "extension-web-test",
  "workspace"
);

await mkdir(resolve(workspacePath, ".codewise"), { recursive: true });
await mkdir(resolve(workspacePath, "src"), { recursive: true });
await mkdir(resolve(workspacePath, ".vscode"), { recursive: true });
await Promise.all([
  writeFile(resolve(workspacePath, "src", "Widget.cs"), fixtureSource, "utf8"),
  writeFile(
    resolve(workspacePath, ".vscode", "settings.json"),
    `${JSON.stringify({
      "codewise.indexPath": "C:\\missing-desktop-index\\index.db"
    }, undefined, 2)}\n`,
    "utf8"
  )
]);
const fixtureIndexPath = resolve(workspacePath, ".codewise", "index.db");
await rm(fixtureIndexPath, { force: true });
createFixtureIndex(fixtureIndexPath);

const port = await findAvailablePort();
await runTests({
  browserType: "chromium",
  extensionDevelopmentPath,
  extensionTestsPath,
  folderPath: workspacePath,
  headless: true,
  port,
  quality: "stable"
});

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not determine an available web test port.");
  }

  await closeServer(server);
  return address.port;
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

function createFixtureIndex(path) {
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
    value: "```csharp\nclass Widget\n```\n\nA demo widget."
  }));
  database.close();
}
