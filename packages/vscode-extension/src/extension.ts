import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
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
      await restartClient(context);
    }),
    vscode.commands.registerCommand("codewise.scip.restartServer", async () => {
      await restartClient(context);
    })
  );

  await startClient(context);
}

export async function deactivate(): Promise<void> {
  await stopClient();
}

async function restartClient(context: vscode.ExtensionContext): Promise<void> {
  await stopClient();
  await startClient(context);
}

async function stopClient(): Promise<void> {
  const current = client;
  client = undefined;
  if (current !== undefined) {
    await current.stop();
  }
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = getWorkspaceFolder();
  if (workspaceFolder === undefined) {
    return;
  }

  const indexPath = vscode.workspace.getConfiguration(
    "codewise.scip",
    workspaceFolder.uri
  ).get<string>("indexPath", "").trim();

  if (!await indexExists(indexPath, workspaceFolder)) {
    const selected = await vscode.window.showErrorMessage(
      indexPath === ""
        ? "No SCIP index was found. Configure codewise.scip.indexPath or add .scip/index.scip to the workspace."
        : `The configured SCIP index does not exist: ${indexPath}`,
      "Select Index File"
    );
    if (selected === "Select Index File") {
      await vscode.commands.executeCommand("codewise.scip.selectIndex");
    }
    return;
  }

  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = {
    module: serverModule,
    transport: TransportKind.stdio,
    args: indexPath === "" ? [] : ["--index", indexPath]
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      {
        scheme: "file",
        language: "csharp"
      }
    ],
    initializationOptions: indexPath === "" ? {} : { indexPath },
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

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder === undefined) {
    void vscode.window.showErrorMessage(
      "Codewise SCIP requires an open workspace folder."
    );
  }
  return workspaceFolder;
}

async function indexExists(
  configuredPath: string,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<boolean> {
  const indexUri = configuredPath === ""
    ? vscode.Uri.joinPath(workspaceFolder.uri, ".scip", "index.scip")
    : vscode.Uri.file(configuredPath);

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

