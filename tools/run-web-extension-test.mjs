import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { runTests } from "@vscode/test-web";

const fixtureIndexBase64 =
  "EoICCg1zcmMvV2lkZ2V0LmNzEjAKAwANExInc2NpcC1kb3RuZXQgbnVnZXQgZGVtbyAxLjAgRGVtby9XaWRnZXQjGAESLgoDAwgOEidzY2lwLWRvdG5ldCBudWdldCBkZW1vIDEuMCBEZW1vL1dpZGdldCMaUQonc2NpcC1kb3RuZXQgbnVnZXQgZGVtbyAxLjAgRGVtby9XaWRnZXQjGg5BIGRlbW8gd2lkZ2V0LjoWIgZjc2hhcnAqDGNsYXNzIFdpZGdldCIGY3NoYXJwKjRwdWJsaWMgY2xhc3MgV2lkZ2V0IHt9Cgp2b2lkIE0oKSB7CiAgICBfID0gV2lkZ2V0Owp9";
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

await mkdir(resolve(workspacePath, ".scip"), { recursive: true });
await mkdir(resolve(workspacePath, "src"), { recursive: true });
await mkdir(resolve(workspacePath, ".vscode"), { recursive: true });
await Promise.all([
  writeFile(
    resolve(workspacePath, ".scip", "index.scip"),
    Buffer.from(fixtureIndexBase64, "base64")
  ),
  writeFile(resolve(workspacePath, "src", "Widget.cs"), fixtureSource, "utf8"),
  writeFile(
    resolve(workspacePath, ".vscode", "settings.json"),
    `${JSON.stringify({
      "codewise.scip.indexPath": "C:\\missing-desktop-index\\index.scip"
    }, undefined, 2)}\n`,
    "utf8"
  )
]);

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
