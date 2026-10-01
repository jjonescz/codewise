import * as vscode from "vscode";
import { formatError, logError, logMessage } from "./extension-logging.js";
import {
  downloadRoslynArtifact,
  findLatestRoslynArtifact,
  findRoslynArtifact
} from "./github-artifact.js";
import { gitCommitPattern } from "./remote-hub-revision.js";
import {
  extractVerifiedRoslynIndex,
  RoslynIndexValidationError,
  verifyRoslynIndex
} from "./roslyn-index-artifact.js";

const roslynProjectPath = [
  "src",
  "Compilers",
  "CSharp",
  "Portable",
  "Microsoft.CodeAnalysis.CSharp.csproj"
] as const;

export async function resolveDownloadedRoslynIndex(
  context: Pick<vscode.ExtensionContext, "globalStorageUri">,
  workspaceFolder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel,
  resolveCommit: () => Promise<string | undefined>
): Promise<vscode.Uri | undefined> {
  if (!await isRoslynWorkspace(workspaceFolder)) {
    return undefined;
  }
  logMessage(
    output,
    `Detected a compatible Roslyn workspace at ${workspaceFolder.uri.toString()}.`
  );

  const configuredCommit = vscode.workspace.getConfiguration(
    "codewise",
    workspaceFolder.uri
  ).get<string>("roslynCommit", "").trim().toLowerCase();
  const workspaceCommit = configuredCommit !== ""
    ? configuredCommit
    : await resolveCommit();
  if (workspaceCommit === undefined) {
    logMessage(output, "Roslyn commit selection was cancelled.");
    return undefined;
  }
  validateCommit(workspaceCommit);
  logMessage(output, `Resolving Codewise index for Roslyn commit ${workspaceCommit}.`);

  const workspaceCache = getCacheUris(context, workspaceCommit);
  if (await isValidCachedIndex(
    workspaceCache.indexUri,
    workspaceCache.manifestUri,
    workspaceCommit,
    output
  )) {
    logMessage(output, `Using cached Roslyn Codewise index for ${workspaceCommit}.`);
    return workspaceCache.indexUri;
  }
  logMessage(output, `No valid cached Codewise index was found for ${workspaceCommit}.`);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Resolving Roslyn Codewise index for ${workspaceCommit.slice(0, 12)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Authenticating with GitHub..." });
      const session = await getGitHubSession(output);
      progress.report({ message: "Finding workflow artifact..." });
      const logger = (message: string) => logMessage(output, message);
      const exactArtifact = await findRoslynArtifact(
        workspaceCommit,
        session.accessToken,
        logger
      );
      let selection = exactArtifact === undefined
        ? undefined
        : { commit: workspaceCommit, artifact: exactArtifact };
      if (selection === undefined && configuredCommit === "") {
        progress.report({ message: "Finding the latest indexed commit in branch history..." });
        selection = await findLatestRoslynArtifact(
          workspaceCommit,
          session.accessToken,
          logger
        );
      }
      if (selection === undefined) {
        throw new Error(
          `No retained Roslyn Codewise workflow artifact is available for commit ${workspaceCommit}`
          + (configuredCommit === "" ? " or any indexed ancestor." : ".")
        );
      }

      const { commit, artifact } = selection;
      if (commit !== workspaceCommit) {
        const cache = getCacheUris(context, commit);
        if (await isValidCachedIndex(
          cache.indexUri,
          cache.manifestUri,
          commit,
          output
        )) {
          return { commit, verifiedIndex: undefined };
        }
      }
      progress.report({ message: `Downloading index for ${commit.slice(0, 12)}...` });
      const bytes = await downloadRoslynArtifact(
        artifact,
        session.accessToken,
        logger
      );
      progress.report({ message: "Extracting and verifying index..." });
      const verifiedIndex = await extractVerifiedRoslynIndex(bytes, commit);
      logMessage(output, "Artifact extraction and manifest verification succeeded.");
      return { commit, verifiedIndex };
    }
  );

  const { commit, verifiedIndex } = result;
  const { cacheDirectory, indexUri, manifestUri } = getCacheUris(context, commit);
  if (verifiedIndex === undefined) {
    logMessage(output, `Using cached Roslyn Codewise index for ${commit}.`);
  } else {
    await writeCacheAtomically(
      cacheDirectory,
      indexUri,
      manifestUri,
      verifiedIndex.index,
      verifiedIndex.manifest
    );
    logMessage(output, `Downloaded and cached Roslyn Codewise index for ${commit}.`);
  }
  if (commit !== workspaceCommit) {
    const message = `Codewise is using an index for ${commit.slice(0, 12)}, `
      + `an older commit in the history of ${workspaceCommit.slice(0, 12)}. `
      + "Navigation and hover results may be inaccurate for changed files.";
    logMessage(output, message);
    void showFallbackWarning(message).catch((error: unknown) => {
      logError(output, "Could not select a different Roslyn index commit", error);
      void vscode.window.showErrorMessage(
        `Codewise could not select a different commit: ${formatError(error)}`
      );
    });
  } else if (verifiedIndex !== undefined) {
    void vscode.window.showInformationMessage(
      `Codewise downloaded the Roslyn index for ${commit.slice(0, 12)}.`
    );
  }
  return indexUri;
}

export function registerRoslynCommitCommand(
  restart: () => Promise<void>
): vscode.Disposable {
  return vscode.commands.registerCommand("codewise.selectRoslynCommit", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder === undefined) {
      await vscode.window.showErrorMessage("Codewise requires an open workspace folder.");
      return;
    }
    const configuration = vscode.workspace.getConfiguration("codewise", workspaceFolder.uri);
    const commit = await promptRoslynCommit(
      configuration.get<string>("roslynCommit", "")
    );
    if (commit === undefined) {
      return;
    }
    await configuration.update(
      "roslynCommit",
      commit,
      vscode.ConfigurationTarget.Workspace
    );
    await restart();
  });
}

export async function promptRoslynCommit(value = ""): Promise<string | undefined> {
  const enteredCommit = await vscode.window.showInputBox({
    title: "Roslyn Codewise index commit",
    prompt: "Enter the full commit SHA whose Roslyn index should be used.",
    placeHolder: "40-character Git commit SHA",
    value,
    ignoreFocusOut: true,
    validateInput: (input) => (
      gitCommitPattern.test(input.trim().toLowerCase())
        ? undefined
        : "Enter a full 40-character hexadecimal Git commit SHA."
    )
  });
  if (enteredCommit === undefined) {
    return undefined;
  }
  const commit = enteredCommit.trim().toLowerCase();
  validateCommit(commit);
  return commit;
}

async function showFallbackWarning(message: string): Promise<void> {
  const selected = await vscode.window.showWarningMessage(
    message,
    "Choose Different Commit"
  );
  if (selected === "Choose Different Commit") {
    await vscode.commands.executeCommand("codewise.selectRoslynCommit");
  }
}

function getCacheUris(
  context: Pick<vscode.ExtensionContext, "globalStorageUri">,
  commit: string
) {
  const cacheDirectory = vscode.Uri.joinPath(context.globalStorageUri, "roslyn", commit);
  return {
    cacheDirectory,
    indexUri: vscode.Uri.joinPath(cacheDirectory, "index.db"),
    manifestUri: vscode.Uri.joinPath(cacheDirectory, "manifest.json")
  };
}

async function getGitHubSession(
  output: vscode.OutputChannel
): Promise<vscode.AuthenticationSession> {
  const scopes = ["repo"] as const;
  try {
    logMessage(output, "Checking for an approved GitHub authentication session.");
    const existingSession = await vscode.authentication.getSession(
      "github",
      scopes,
      { silent: true }
    );
    if (existingSession !== undefined) {
      logMessage(output, "Reusing an approved GitHub authentication session.");
      return existingSession;
    }

    logMessage(
      output,
      "Requesting permission to use a GitHub session for artifact downloads."
    );
    const session = await vscode.authentication.getSession("github", scopes, {
      createIfNone: {
        detail:
          "Codewise needs GitHub access to download a public workflow artifact."
      }
    });
    logMessage(output, "GitHub authentication succeeded.");
    return session;
  } catch (error) {
    logError(output, "GitHub authentication failed", error);
    logMessage(
      output,
      "For authentication flow details, select 'GitHub Authentication' in the Output panel."
    );
    throw new Error(
      `GitHub authentication failed: ${formatError(error).split("\n", 1)[0]}. `
      + "See the Codewise and GitHub Authentication output channels.",
      { cause: error }
    );
  }
}

async function isRoslynWorkspace(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<boolean> {
  const projectUri = vscode.Uri.joinPath(workspaceFolder.uri, ...roslynProjectPath);
  try {
    const stat = await vscode.workspace.fs.stat(projectUri);
    return (stat.type & vscode.FileType.File) !== 0;
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function isValidCachedIndex(
  indexUri: vscode.Uri,
  manifestUri: vscode.Uri,
  commit: string,
  output: vscode.OutputChannel
): Promise<boolean> {
  let index: Uint8Array;
  let manifest: Uint8Array;
  try {
    [index, manifest] = await Promise.all([
      vscode.workspace.fs.readFile(indexUri),
      vscode.workspace.fs.readFile(manifestUri)
    ]);
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }

  try {
    await verifyRoslynIndex(index, manifest, commit);
    return true;
  } catch (error) {
    if (!(error instanceof RoslynIndexValidationError)) {
      throw error;
    }
    logMessage(
      output,
      `Ignoring invalid cached Roslyn Codewise index: ${error.message}`
    );
    return false;
  }
}

async function writeCacheAtomically(
  cacheDirectory: vscode.Uri,
  indexUri: vscode.Uri,
  manifestUri: vscode.Uri,
  index: Uint8Array,
  manifest: Uint8Array
): Promise<void> {
  await vscode.workspace.fs.createDirectory(cacheDirectory);
  const suffix = `${Date.now()}-${globalThis.crypto.randomUUID()}`;
  const temporaryIndexUri = vscode.Uri.joinPath(
    cacheDirectory,
    `index.db.${suffix}.tmp`
  );
  const temporaryManifestUri = vscode.Uri.joinPath(
    cacheDirectory,
    `manifest.json.${suffix}.tmp`
  );

  try {
    await Promise.all([
      vscode.workspace.fs.writeFile(temporaryIndexUri, index),
      vscode.workspace.fs.writeFile(temporaryManifestUri, manifest)
    ]);
    await vscode.workspace.fs.rename(temporaryIndexUri, indexUri, {
      overwrite: true
    });
    await vscode.workspace.fs.rename(temporaryManifestUri, manifestUri, {
      overwrite: true
    });
  } finally {
    await Promise.all([
      deleteTemporaryFile(temporaryIndexUri),
      deleteTemporaryFile(temporaryManifestUri)
    ]);
  }
}

async function deleteTemporaryFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function validateCommit(commit: string): void {
  if (!gitCommitPattern.test(commit)) {
    throw new Error(`Invalid Roslyn commit: ${commit}`);
  }
}
