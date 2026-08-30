import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roslynRoot = resolve(process.env.ROSLYN_ROOT ?? "C:\\roslyn-3");
const git = await import("node:child_process");
const commit = git.spawnSync("git", ["-C", roslynRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true
}).stdout.trim();
const indexPath = resolve(repositoryRoot, "artifacts", "roslyn", commit, "index.scip");
const testArtifactDirectory = resolve(repositoryRoot, "artifacts", "extension-test");
const workspacePath = resolve(testArtifactDirectory, "roslyn.code-workspace");
const extensionDevelopmentPath = resolve(repositoryRoot, "packages", "vscode-extension");
const extensionTestsPath = resolve(extensionDevelopmentPath, "dist", "test-runner.cjs");
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

await mkdir(testArtifactDirectory, { recursive: true });
await writeFile(workspacePath, `${JSON.stringify({
  folders: [
    {
      path: roslynRoot
    }
  ],
  settings: {
    "codewise.indexPath": indexPath
  }
}, undefined, 2)}\n`, "utf8");

const testOptions = {
  extensionDevelopmentPath,
  extensionTestsPath,
  extensionTestsEnv: {
    ROSLYN_ROOT: roslynRoot
  },
  launchArgs: [
    workspacePath,
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome"
  ]
};

await runTests(
  vscodeExecutablePath === undefined
    ? testOptions
    : { ...testOptions, vscodeExecutablePath }
);
