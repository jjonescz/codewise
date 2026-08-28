import * as vscode from "vscode";
import { downloadRoslynArtifact } from "./github-artifact.js";
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

  const commit = await resolveCommit();
  if (commit === undefined) {
    return undefined;
  }
  validateCommit(commit);

  const cacheDirectory = vscode.Uri.joinPath(
    context.globalStorageUri,
    "roslyn",
    commit
  );
  const indexUri = vscode.Uri.joinPath(cacheDirectory, "index.scip");
  const manifestUri = vscode.Uri.joinPath(cacheDirectory, "manifest.json");

  if (await isValidCachedIndex(indexUri, manifestUri, commit, output)) {
    output.appendLine(`Using cached Roslyn SCIP index for ${commit}.`);
    return indexUri;
  }

  const session = await vscode.authentication.getSession(
    "github",
    ["repo"],
    { createIfNone: true }
  );
  if (session === undefined) {
    throw new Error(
      "GitHub authentication is required to download the private Roslyn SCIP artifact."
    );
  }

  const verifiedIndex = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading Roslyn SCIP index for ${commit.slice(0, 12)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: "Finding workflow artifact..." });
      const artifact = await downloadRoslynArtifact(commit, session.accessToken);
      progress.report({ message: "Extracting and verifying index..." });
      return await extractVerifiedRoslynIndex(artifact, commit);
    }
  );

  await writeCacheAtomically(
    cacheDirectory,
    indexUri,
    manifestUri,
    verifiedIndex.index,
    verifiedIndex.manifest
  );
  output.appendLine(`Downloaded and verified Roslyn SCIP index for ${commit}.`);
  void vscode.window.showInformationMessage(
    `Codewise downloaded the Roslyn SCIP index for ${commit.slice(0, 12)}.`
  );
  return indexUri;
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
    output.appendLine(`Ignoring invalid cached Roslyn SCIP index: ${error.message}`);
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
