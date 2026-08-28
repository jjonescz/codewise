import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";
import { resolveDownloadedRoslynIndex } from "./roslyn-index-provider.js";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codewise SCIP");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("codewise.scip.selectIndex", async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          "SCIP indexes": ["scip"]
        },
        openLabel: "Use SCIP Index",
        title: "Select index.scip"
      });
      if (selected === undefined || selected.length === 0) {
        return;
      }

      const indexUri = selected[0]!;
      if (indexUri.scheme !== "file") {
        await vscode.window.showErrorMessage(
          "The desktop prototype requires a local SCIP index file."
        );
        return;
      }

      const workspaceFolder = getWorkspaceFolder();
      if (workspaceFolder === undefined) {
        return;
      }

      await vscode.workspace.getConfiguration(
        "codewise.scip",
        workspaceFolder.uri
      ).update("indexPath", indexUri.fsPath, vscode.ConfigurationTarget.Workspace);
      await restartClient(context, output);
    }),
    vscode.commands.registerCommand("codewise.scip.restartServer", async () => {
      await restartClient(context, output);
    })
  );

  await startClient(context, output);
}

export async function deactivate(): Promise<void> {
  await stopClient();
}

async function restartClient(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  await stopClient();
  await startClient(context, output);
}

async function stopClient(): Promise<void> {
  const current = client;
  client = undefined;
  if (current !== undefined) {
    await current.stop();
  }
}

async function startClient(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const workspaceFolder = getWorkspaceFolder();
  if (workspaceFolder === undefined) {
    return;
  }

  const indexPath = vscode.workspace.getConfiguration(
    "codewise.scip",
    workspaceFolder.uri
  ).get<string>("indexPath", "").trim();

  let resolvedIndexPath: string | undefined;
  try {
    resolvedIndexPath = await resolveIndexPath(
      context,
      workspaceFolder,
      indexPath,
      output
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showIndexError(`Codewise could not obtain a SCIP index: ${message}`);
    return;
  }

  if (resolvedIndexPath === undefined) {
    return;
  }

  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    module: serverModule,
    transport: TransportKind.stdio,
    args: ["--index", resolvedIndexPath]
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      {
        scheme: "file",
        language: "csharp"
      }
    ],
    initializationOptions: { indexPath: resolvedIndexPath },
    workspaceFolder
  };

  const candidate = new LanguageClient(
    "codewise-scip",
    "Codewise SCIP",
    serverOptions,
    clientOptions
  );
  client = candidate;

  try {
    await candidate.start();
  } catch (error) {
    client = undefined;
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(
      `Codewise SCIP language server failed to start: ${message}`
    );
  }
}

async function resolveIndexPath(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  configuredPath: string,
  output: vscode.OutputChannel
): Promise<string | undefined> {
  if (configuredPath !== "") {
    if (await fileExists(vscode.Uri.file(configuredPath))) {
      return configuredPath;
    }
    await showIndexError(`The configured SCIP index does not exist: ${configuredPath}`);
    return undefined;
  }

  const workspaceIndexUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".scip",
    "index.scip"
  );
  if (await fileExists(workspaceIndexUri)) {
    return workspaceIndexUri.fsPath;
  }

  const downloadedIndexUri = await resolveDownloadedRoslynIndex(
    context,
    workspaceFolder,
    output,
    () => readGitCommit(workspaceFolder.uri.fsPath)
  );
  if (downloadedIndexUri !== undefined) {
    return downloadedIndexUri.fsPath;
  }

  await showIndexError(
    "No SCIP index was found. Configure codewise.scip.indexPath or add .scip/index.scip to the workspace."
  );
  return undefined;
}

async function showIndexError(message: string): Promise<void> {
  const selected = await vscode.window.showErrorMessage(
    message,
    "Select Index File"
  );
  if (selected === "Select Index File") {
    await vscode.commands.executeCommand("codewise.scip.selectIndex");
  }
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder === undefined) {
    void vscode.window.showErrorMessage(
      "Codewise SCIP requires an open workspace folder."
    );
  }
  return workspaceFolder;
}

async function fileExists(indexUri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(indexUri);
    return (stat.type & vscode.FileType.File) !== 0 && stat.size > 0;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return false;
    }
    throw error;
  }
}

function readGitCommit(workspacePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", workspacePath, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(
            `Could not determine the Roslyn workspace commit: ${error.message}`,
            { cause: error }
          ));
          return;
        }

        const commit = stdout.trim().toLowerCase();
        if (!/^[a-f0-9]{40}$/u.test(commit)) {
          reject(new Error(`Git returned an invalid Roslyn commit: ${commit}`));
          return;
        }
        resolve(commit);
      }
    );
  });
}
