import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { runTests } from "@vscode/test-web";
import {
  createIndexSchemaSql,
  createSemanticTokensSchemaSql,
  createSymbolGraphSchemaSql
} from "../packages/index-core/dist/schema.js";
import { encodeSemanticTokens } from "../packages/index-core/dist/index.js";
import { exportRuntimeIndex } from "../packages/lsp-crawler/dist/index.js";

const fixtureSource = [
  "public class Widget {} // one\u0085two\u2028three\u2029four",
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
    resolve(workspacePath, "src", "WidgetGeneric.cs"),
    fixtureSource.replace(/\n/gu, "\r"),
    "utf8"
  ),
  writeFile(
    resolve(workspacePath, ".vscode", "settings.json"),
    `${JSON.stringify({
      "codewise.indexPath": "C:\\missing-desktop-index\\index.db",
      "editor.unusualLineTerminators": "off"
    }, undefined, 2)}\n`,
    "utf8"
  )
]);
const fixtureIndexPath = resolve(workspacePath, ".codewise", "index.db");
await rm(fixtureIndexPath, { force: true });
const crawlIndexPath = resolve(workspacePath, ".codewise", "crawl.db");
await rm(crawlIndexPath, { force: true });
createFixtureIndex(crawlIndexPath);
exportRuntimeIndex(crawlIndexPath, fixtureIndexPath);
await rm(crawlIndexPath);

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
  database.exec(`
    INSERT INTO documents (
      id, uri, relative_path, language_id, content_hash, position_encoding
    ) VALUES (
      2, 'file:///crawler/src/WidgetGeneric.cs', 'src/WidgetGeneric.cs',
      'csharp', 'hash', 'utf-16'
    );
    INSERT INTO occurrences (
      id, document_id, start_line, start_character, end_line, end_character,
      start_key, end_key, discovery_source
    )
    SELECT id + 2, 2, start_line, start_character, end_line, end_character,
           start_key, end_key, discovery_source
    FROM occurrences WHERE document_id = 1;
    INSERT INTO answer_sets (id, kind, content_hash)
    SELECT id + 2, kind, content_hash || '-generic' FROM answer_sets WHERE id IN (1, 2);
    INSERT INTO answer_locations (
      answer_set_id, ordinal, uri, start_line, start_character, end_line, end_character
    )
    SELECT answer_set_id + 2, ordinal, 'file:///crawler/src/WidgetGeneric.cs',
           start_line, start_character, end_line, end_character
    FROM answer_locations WHERE answer_set_id IN (1, 2);
    INSERT INTO occurrence_answers (
      occurrence_id, kind, answer_set_id, status, attempt_count
    )
    SELECT occurrence_id + 2, kind, answer_set_id + 2, status, attempt_count
    FROM occurrence_answers WHERE occurrence_id = 2;
    INSERT INTO hover_results (
      occurrence_id, status, contents_json,
      start_line, start_character, end_line, end_character, attempt_count
    )
    SELECT occurrence_id + 2, status, contents_json,
           start_line, start_character, end_line, end_character, attempt_count
    FROM hover_results WHERE occurrence_id = 2;

    ${createSymbolGraphSchemaSql}
    INSERT INTO symbols (id, provider, provider_key, display_name)
    VALUES (1, 'test', 'widget', 'class Widget');
    INSERT INTO occurrence_symbols (occurrence_id, symbol_id, is_definition)
    VALUES (1, 1, 1), (2, 1, 0);
    INSERT INTO symbol_definitions (
      symbol_id, ordinal, uri, start_line, start_character, end_line, end_character
    ) VALUES (1, 0, 'file:///crawler/src/Widget.cs', 0, 13, 0, 19);
    DELETE FROM hover_results WHERE occurrence_id = 2;
  `);
  const legend = { tokenTypes: ["class"], tokenModifiers: ["declaration"] };
  database.exec(createSemanticTokensSchemaSql);
  database.prepare("INSERT INTO metadata (key, value) VALUES ('semantic_tokens_legend', ?)")
    .run(JSON.stringify(legend));
  const tokens = database.prepare(`
    INSERT INTO document_semantic_tokens (document_id, content_hash, data)
    VALUES (?, ?, ?)
  `);
  for (const id of [1, 2]) {
    tokens.run(
      id,
      createHash("sha256").update(fixtureSource).digest("hex"),
      encodeSemanticTokens([0, 13, 6, 0, 1, 3, 8, 6, 0, 0], legend)
    );
  }
  database.close();
}
