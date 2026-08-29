import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions
} from "vscode-languageclient/browser";
import {
  indexBootstrapErrorKind,
  indexBootstrapReadyKind,
  indexBootstrapRequestKind,
  type IndexBootstrapRequest
} from "./browser-protocol.js";
import {
  createBrowserWorker,
  defaultBrowserWorkerDependencies,
  type ManagedBrowserWorker
} from "./browser-worker.js";
import { logError, logMessage } from "./extension-logging.js";
import { resolveDownloadedRoslynIndex } from "./roslyn-index-provider.js";

interface RunningClient {
  readonly languageClient: LanguageClient;
  readonly serverWorker: ManagedBrowserWorker<Worker>;
}

const commitPattern = /^[a-f0-9]{40}$/u;
const roslynCommitStateKey = "codewise.scip.roslynCommit";
let client: RunningClient | undefined;

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

      const workspaceFolder = getWorkspaceFolder();
      if (workspaceFolder === undefined) {
        return;
      }

      await vscode.workspace.getConfiguration(
        "codewise.scip",
        workspaceFolder.uri
      ).update(
        "indexPath",
        selected[0]!.toString(),
        vscode.ConfigurationTarget.Workspace
      );
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
  if (current === undefined) {
    return;
  }

  try {
    await current.languageClient.stop();
  } finally {
    current.serverWorker.dispose();
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
  logMessage(
    output,
    `Starting browser extension: appHost=${vscode.env.appHost}, `
    + `uriScheme=${vscode.env.uriScheme}, remoteName=${vscode.env.remoteName ?? "none"}, `
    + `workspace=${workspaceFolder.uri.toString()}.`
  );

  let indexUri: vscode.Uri | undefined;
  try {
    indexUri = await resolveIndexUri(context, workspaceFolder, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(output, "SCIP index resolution failed", error);
    await showIndexError(
      `Codewise could not obtain a SCIP index: ${message}`,
      output
    );
    return;
  }
  if (indexUri === undefined) {
    return;
  }

  let indexBytes: Uint8Array;
  try {
    indexBytes = await vscode.workspace.fs.readFile(indexUri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(output, `Failed to read SCIP index ${indexUri.toString()}`, error);
    await showIndexError(
      `Codewise could not read ${indexUri.toString()}: ${message}`,
      output
    );
    return;
  }
  if (indexBytes.byteLength === 0) {
    await showIndexError(
      `The SCIP index is empty: ${indexUri.toString()}`,
      output
    );
    return;
  }

  const serverUri = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "web",
    "server.js"
  );
  let serverWorker: ManagedBrowserWorker<Worker> | undefined;

  try {
    serverWorker = await createBrowserWorker(
      serverUri.toString(true),
      "Codewise SCIP Language Server",
      (message) => logMessage(output, message),
      defaultBrowserWorkerDependencies
    );
    await bootstrapWorker(
      serverWorker.worker,
      indexBytes,
      indexUri.toString()
    );
  } catch (error) {
    serverWorker?.dispose();
    const message = error instanceof Error ? error.message : String(error);
    logError(output, "Browser language server startup failed", error);
    await vscode.window.showErrorMessage(
      `Codewise SCIP browser server failed to start: ${message}`
    );
    return;
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      {
        scheme: workspaceFolder.uri.scheme,
        language: "csharp"
      }
    ],
    initializationOptions: {},
    workspaceFolder
  };
  const languageClient = new LanguageClient(
    "codewise-scip",
    "Codewise SCIP",
    serverWorker.worker,
    clientOptions
  );
  client = { languageClient, serverWorker };

  try {
    await languageClient.start();
  } catch (error) {
    client = undefined;
    serverWorker.dispose();
    const message = error instanceof Error ? error.message : String(error);
    logError(output, "Language client startup failed", error);
    await vscode.window.showErrorMessage(
      `Codewise SCIP language server failed to start: ${message}`
    );
  }
}

async function resolveIndexUri(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel
): Promise<vscode.Uri | undefined> {
  const configuration = vscode.workspace.getConfiguration(
    "codewise.scip",
    workspaceFolder.uri
  );
  const configuredPath = configuration.get<string>("indexPath", "").trim();
  if (configuredPath !== "") {
    const configuredUri = parseConfiguredIndexUri(configuredPath);
    const isDesktopPathInVirtualWorkspace = configuredUri.scheme === "file"
      && workspaceFolder.uri.scheme !== "file";
    if (isDesktopPathInVirtualWorkspace) {
      logMessage(
        output,
        `Ignoring desktop SCIP index path in web workspace: ${configuredUri.toString()}`
      );
    } else if (await fileExists(configuredUri)) {
      return configuredUri;
    } else {
      await showIndexError(
        `The configured SCIP index does not exist: ${configuredUri.toString()}`,
        output
      );
      return undefined;
    }
  }

  const workspaceIndexUri = vscode.Uri.joinPath(
    workspaceFolder.uri,
    ".scip",
    "index.scip"
  );
  if (await fileExists(workspaceIndexUri)) {
    return workspaceIndexUri;
  }

  const downloadedIndexUri = await resolveDownloadedRoslynIndex(
    context,
    workspaceFolder,
    output,
    () => resolveBrowserRoslynCommit(context, workspaceFolder)
  );
  if (downloadedIndexUri !== undefined) {
    return downloadedIndexUri;
  }

  await showIndexError(
    "No SCIP index was found. Configure codewise.scip.indexPath or add .scip/index.scip to the workspace.",
    output
  );
  return undefined;
}

function parseConfiguredIndexUri(value: string): vscode.Uri {
  const isWindowsPath = /^[A-Za-z]:[\\/]/u.test(value);
  return !isWindowsPath && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ? vscode.Uri.parse(value, true)
    : vscode.Uri.file(value);
}

async function resolveBrowserRoslynCommit(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<string | undefined> {
  const configuration = vscode.workspace.getConfiguration(
    "codewise.scip",
    workspaceFolder.uri
  );
  const configuredCommit = configuration.get<string>("roslynCommit", "").trim();
  const rememberedCommit = context.workspaceState.get<string>(
    roslynCommitStateKey,
    ""
  );
  const candidateCommit = (configuredCommit || rememberedCommit).toLowerCase();
  if (candidateCommit !== "") {
    if (!commitPattern.test(candidateCommit)) {
      throw new Error(
        "codewise.scip.roslynCommit must be a full 40-character Git commit SHA."
      );
    }
    return candidateCommit;
  }

  const enteredCommit = await vscode.window.showInputBox({
    title: "Roslyn SCIP index commit",
    prompt: "Enter the full commit SHA checked out in this web workspace.",
    placeHolder: "40-character Git commit SHA",
    ignoreFocusOut: true,
    validateInput: (value) => (
      commitPattern.test(value.trim().toLowerCase())
        ? undefined
        : "Enter a full 40-character hexadecimal Git commit SHA."
    )
  });
  if (enteredCommit === undefined) {
    return undefined;
  }

  const commit = enteredCommit.trim().toLowerCase();
  await context.workspaceState.update(roslynCommitStateKey, commit);
  return commit;
}

function bootstrapWorker(
  worker: Worker,
  indexBytes: Uint8Array,
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while transferring the SCIP index to the worker."));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "object" || event.data === null) {
        return;
      }

      const kind = Reflect.get(event.data, "kind");
      if (kind === indexBootstrapReadyKind) {
        cleanup();
        resolve();
      } else if (kind === indexBootstrapErrorKind) {
        cleanup();
        reject(new Error(String(Reflect.get(event.data, "message"))));
      }
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "The SCIP browser worker failed to load."));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);

    const index = toTransferableArrayBuffer(indexBytes);
    const request: IndexBootstrapRequest = {
      kind: indexBootstrapRequestKind,
      index,
      description
    };
    worker.postMessage(request, [index]);
  });
}

function toTransferableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function showIndexError(
  message: string,
  output: vscode.OutputChannel
): Promise<void> {
  const selected = await vscode.window.showErrorMessage(
    message,
    "Show Logs",
    "Select Index File"
  );
  if (selected === "Show Logs") {
    output.show(true);
  } else if (selected === "Select Index File") {
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
