import * as vscode from "vscode";
import { formatError, logError, logMessage } from "./extension-logging.js";
import {
  downloadRoslynArtifact,
  shouldRetryArtifactRequestWithAuthentication
} from "./github-artifact.js";
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
  context: vscode.ExtensionContext,
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

  const commit = await resolveCommit();
  if (commit === undefined) {
    logMessage(output, "Roslyn commit selection was cancelled.");
    return undefined;
  }
  validateCommit(commit);
  logMessage(output, `Resolving SCIP index for Roslyn commit ${commit}.`);

  const cacheDirectory = vscode.Uri.joinPath(
    context.globalStorageUri,
    "roslyn",
    commit
  );
  const indexUri = vscode.Uri.joinPath(cacheDirectory, "index.scip");
  const manifestUri = vscode.Uri.joinPath(cacheDirectory, "manifest.json");

  if (await isValidCachedIndex(indexUri, manifestUri, commit, output)) {
    logMessage(output, `Using cached Roslyn SCIP index for ${commit}.`);
    return indexUri;
  }
  logMessage(output, `No valid cached SCIP index was found for ${commit}.`);

  const verifiedIndex = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading Roslyn SCIP index for ${commit.slice(0, 12)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Finding workflow artifact..." });
      const artifact = await downloadArtifactWithOptionalAuthentication(
        commit,
        output
      );
      progress.report({ message: "Extracting and verifying index..." });
      const verified = await extractVerifiedRoslynIndex(artifact, commit);
      logMessage(output, "Artifact extraction and manifest verification succeeded.");
      return verified;
    }
  );

  await writeCacheAtomically(
    cacheDirectory,
    indexUri,
    manifestUri,
    verifiedIndex.index,
    verifiedIndex.manifest
  );
  logMessage(output, `Downloaded and cached Roslyn SCIP index for ${commit}.`);
  void vscode.window.showInformationMessage(
    `Codewise downloaded the Roslyn SCIP index for ${commit.slice(0, 12)}.`
  );
  return indexUri;
}

async function downloadArtifactWithOptionalAuthentication(
  commit: string,
  output: vscode.OutputChannel
): Promise<Uint8Array> {
  const logger = (message: string) => logMessage(output, message);
  try {
    logMessage(output, "Trying anonymous GitHub artifact access.");
    const artifact = await downloadRoslynArtifact(
      commit,
      undefined,
      logger
    );
    logMessage(output, "Anonymous GitHub artifact access succeeded.");
    return artifact;
  } catch (error) {
    if (!shouldRetryArtifactRequestWithAuthentication(error)) {
      throw error;
    }
    logMessage(
      output,
      "Anonymous artifact access requires authentication; requesting a GitHub session."
    );
  }

  const session = await getGitHubSession(output);
  return downloadRoslynArtifact(commit, session.accessToken, logger);
}

async function getGitHubSession(
  output: vscode.OutputChannel
): Promise<vscode.AuthenticationSession> {
  const scopes = ["repo"] as const;
  try {
    logMessage(output, "Checking for an existing GitHub authentication session.");
    const existingSession = await vscode.authentication.getSession(
      "github",
      scopes,
      { silent: true }
    );
    if (existingSession !== undefined) {
      logMessage(output, "Reusing an existing GitHub authentication session.");
      logMessage(
        output,
        `GitHub authentication succeeded with scopes: `
        + `${existingSession.scopes.join(", ")}.`
      );
      return existingSession;
    }

    logMessage(
      output,
      "No reusable GitHub session is available; starting interactive sign-in."
    );
    const session = await vscode.authentication.getSession("github", scopes, {
      createIfNone: {
        detail:
          "Codewise needs repository access to download a private SCIP artifact."
      }
    });
    logMessage(
      output,
      `GitHub authentication succeeded with scopes: ${session.scopes.join(", ")}.`
    );
    return session;
  } catch (error) {
    logError(output, "GitHub authentication failed", error);
    logMessage(
      output,
      "For authentication flow details, select 'GitHub Authentication' in the Output panel."
    );
    throw new Error(
      `GitHub authentication failed: ${formatError(error).split("\n", 1)[0]}. `
      + "See the Codewise SCIP and GitHub Authentication output channels.",
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
      `Ignoring invalid cached Roslyn SCIP index: ${error.message}`
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
    `index.scip.${suffix}.tmp`
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
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(`Invalid Roslyn commit: ${commit}`);
  }
}
