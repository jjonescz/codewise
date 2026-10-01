import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  downloadRoslynArtifact,
  findLatestRoslynArtifact,
  findRoslynArtifact
} from "./github-artifact.js";
import { extractVerifiedRoslynIndex } from "./roslyn-index-artifact.js";
import {
  registerRoslynCommitCommand,
  resolveDownloadedRoslynIndex
} from "./roslyn-index-provider.js";

const mocks = vi.hoisted(() => ({
  getConfiguration: vi.fn(),
  configuration: { get: vi.fn(), update: vi.fn() },
  fs: {
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn()
  },
  getSession: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInputBox: vi.fn(),
  registerCommand: vi.fn<
    (command: string, callback: () => Promise<void>) => { dispose(): void }
  >(),
  executeCommand: vi.fn()
}));

vi.mock("vscode", () => {
  function uri(value: string) {
    return { toString: () => value };
  }
  class FileSystemError extends Error {
    readonly code = "FileNotFound";
    static FileNotFound() {
      return new FileSystemError("File not found");
    }
  }
  return {
    Uri: {
      parse: uri,
      joinPath: (base: { toString(): string }, ...segments: string[]) => (
        uri(`${base.toString()}/${segments.join("/")}`)
      )
    },
    FileSystemError,
    FileType: { File: 1 },
    ConfigurationTarget: { Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      fs: mocks.fs,
      getConfiguration: mocks.getConfiguration,
      workspaceFolders: [{
        uri: uri("vscode-vfs://github/dotnet/roslyn"),
        name: "roslyn",
        index: 0
      }]
    },
    authentication: { getSession: mocks.getSession },
    commands: {
      registerCommand: mocks.registerCommand,
      executeCommand: mocks.executeCommand
    },
    window: {
      showWarningMessage: mocks.showWarningMessage,
      showInformationMessage: mocks.showInformationMessage,
      showErrorMessage: mocks.showErrorMessage,
      showInputBox: mocks.showInputBox,
      withProgress: async (
        _options: unknown,
        callback: (progress: { report(update: unknown): void }) => Promise<unknown>
      ) => callback({ report: () => {} })
    }
  };
});

vi.mock("./github-artifact.js", () => ({
  findRoslynArtifact: vi.fn(),
  findLatestRoslynArtifact: vi.fn(),
  downloadRoslynArtifact: vi.fn()
}));

vi.mock("./roslyn-index-artifact.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./roslyn-index-artifact.js")>(),
  extractVerifiedRoslynIndex: vi.fn()
}));

const workspaceCommit = "1111111111111111111111111111111111111111";
const indexedCommit = "2222222222222222222222222222222222222222";
const artifact = {
  id: 42,
  name: `roslyn-codewise-${indexedCommit}`,
  expired: false,
  created_at: "2026-10-01T00:00:00Z"
};
const context = { globalStorageUri: vscode.Uri.parse("mem:/storage") };
const workspaceFolder = {
  uri: vscode.Uri.parse("vscode-vfs://github/dotnet/roslyn"),
  name: "roslyn",
  index: 0
};
const output: vscode.OutputChannel = {
  name: "Codewise",
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn()
};
const cachedFiles = new Map<string, Uint8Array>();
const index = new TextEncoder().encode("SQLite index bytes");

beforeEach(() => {
  vi.resetAllMocks();
  cachedFiles.clear();
  mocks.getConfiguration.mockReturnValue(mocks.configuration);
  mocks.configuration.get.mockReturnValue("");
  mocks.configuration.update.mockResolvedValue(undefined);
  mocks.fs.stat.mockResolvedValue({ type: vscode.FileType.File });
  mocks.fs.readFile.mockImplementation(async (uri: vscode.Uri) => {
    const contents = cachedFiles.get(uri.toString());
    if (contents === undefined) {
      throw vscode.FileSystemError.FileNotFound();
    }
    return contents;
  });
  mocks.fs.writeFile.mockResolvedValue(undefined);
  mocks.fs.createDirectory.mockResolvedValue(undefined);
  mocks.fs.rename.mockResolvedValue(undefined);
  mocks.fs.delete.mockResolvedValue(undefined);
  mocks.getSession.mockResolvedValue({ accessToken: "token" });
  mocks.showWarningMessage.mockResolvedValue(undefined);
  mocks.showInformationMessage.mockResolvedValue(undefined);
  mocks.executeCommand.mockResolvedValue(undefined);
  mocks.registerCommand.mockReturnValue({ dispose: () => {} });
  vi.mocked(findRoslynArtifact).mockResolvedValue(undefined);
  vi.mocked(findLatestRoslynArtifact).mockResolvedValue({
    commit: indexedCommit,
    artifact
  });
  vi.mocked(downloadRoslynArtifact).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(extractVerifiedRoslynIndex).mockImplementation(async (_bytes, commit) => ({
    index,
    manifest: manifest(commit)
  }));
});

describe("resolveDownloadedRoslynIndex", () => {
  it("prefers an exact retained artifact without discovering fallback commits", async () => {
    vi.mocked(findRoslynArtifact).mockResolvedValue(artifact);

    const result = await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    expect(result?.toString()).toBe(cachePath(workspaceCommit, "index.db"));
    expect(findLatestRoslynArtifact).not.toHaveBeenCalled();
    expect(extractVerifiedRoslynIndex).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]), workspaceCommit
    );
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("verifies and caches a fallback against the indexed commit and warns", async () => {
    const result = await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    expect(result?.toString()).toBe(cachePath(indexedCommit, "index.db"));
    expect(findLatestRoslynArtifact).toHaveBeenCalledWith(
      workspaceCommit, "token", expect.any(Function)
    );
    expect(extractVerifiedRoslynIndex).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]), indexedCommit
    );
    expect(mocks.fs.rename).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ toString: expect.any(Function) }),
      { overwrite: true }
    );
    expect(mocks.fs.rename.mock.calls.map((call) => call[1].toString())).toEqual([
      cachePath(indexedCommit, "index.db"),
      cachePath(indexedCommit, "manifest.json")
    ]);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Navigation and hover results may be inaccurate"),
      "Choose Different Commit"
    );
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it("uses a verified exact cache without authentication or artifact lookup", async () => {
    cacheIndex(workspaceCommit);

    const result = await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    expect(result?.toString()).toBe(cachePath(workspaceCommit, "index.db"));
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(findRoslynArtifact).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("reuses a verified fallback cache and still warns about the mismatch", async () => {
    cacheIndex(indexedCommit);

    const result = await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    expect(result?.toString()).toBe(cachePath(indexedCommit, "index.db"));
    expect(downloadRoslynArtifact).not.toHaveBeenCalled();
    expect(mocks.fs.writeFile).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).toHaveBeenCalledOnce();
  });

  it("redownloads a fallback cache whose manifest targets a different commit", async () => {
    cacheIndex(indexedCommit);
    cachedFiles.set(cachePath(indexedCommit, "manifest.json"), manifest(workspaceCommit));

    await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    expect(downloadRoslynArtifact).toHaveBeenCalledWith(
      artifact, "token", expect.any(Function)
    );
    expect(extractVerifiedRoslynIndex).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]), indexedCommit
    );
  });

  it("honors an explicit commit on both hosts and never falls back from it", async () => {
    mocks.configuration.get.mockReturnValue(indexedCommit.toUpperCase());
    const resolveCommit = vi.fn(async () => workspaceCommit);

    await expect(resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, resolveCommit
    )).rejects.toThrow(`No retained Roslyn Codewise workflow artifact is available for commit ${indexedCommit}.`);

    expect(resolveCommit).not.toHaveBeenCalled();
    expect(findRoslynArtifact).toHaveBeenCalledWith(
      indexedCommit, "token", expect.any(Function)
    );
    expect(findLatestRoslynArtifact).not.toHaveBeenCalled();
  });

  it("does not fall back after an artifact lookup error", async () => {
    vi.mocked(findRoslynArtifact).mockRejectedValue(new Error("HTTP 403 Forbidden"));

    await expect(resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    )).rejects.toThrow("HTTP 403 Forbidden");

    expect(findLatestRoslynArtifact).not.toHaveBeenCalled();
  });

  it("reports when neither the workspace commit nor any ancestor has an index", async () => {
    vi.mocked(findLatestRoslynArtifact).mockResolvedValue(undefined);

    await expect(resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    )).rejects.toThrow(`commit ${workspaceCommit} or any indexed ancestor.`);

    expect(downloadRoslynArtifact).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("opens commit selection from the mismatch warning", async () => {
    mocks.showWarningMessage.mockResolvedValue("Choose Different Commit");

    await resolveDownloadedRoslynIndex(
      context, workspaceFolder, output, async () => workspaceCommit
    );

    await vi.waitFor(() => expect(mocks.executeCommand)
      .toHaveBeenCalledWith("codewise.selectRoslynCommit"));
  });
});

describe("registerRoslynCommitCommand", () => {
  it("persists a normalized explicit commit and restarts the server", async () => {
    mocks.showInputBox.mockResolvedValue(` ${indexedCommit.toUpperCase()} `);
    const restart = vi.fn(async () => {});
    registerRoslynCommitCommand(restart);

    expect(mocks.registerCommand).toHaveBeenCalledWith(
      "codewise.selectRoslynCommit", expect.any(Function)
    );
    const callback = mocks.registerCommand.mock.calls[0]?.[1];
    expect(callback).toBeDefined();
    await callback?.();

    expect(mocks.configuration.update).toHaveBeenCalledWith(
      "roslynCommit", indexedCommit, vscode.ConfigurationTarget.Workspace
    );
    expect(restart).toHaveBeenCalledOnce();
  });

  it("leaves the current index alone when commit selection is cancelled", async () => {
    mocks.showInputBox.mockResolvedValue(undefined);
    const restart = vi.fn(async () => {});
    registerRoslynCommitCommand(restart);
    await mocks.registerCommand.mock.calls[0]?.[1]();

    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});

function cachePath(commit: string, name: string): string {
  return `mem:/storage/roslyn/${commit}/${name}`;
}

function cacheIndex(commit: string): void {
  cachedFiles.set(cachePath(commit, "index.db"), index);
  cachedFiles.set(cachePath(commit, "manifest.json"), manifest(commit));
}

function manifest(commit: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 3,
    repositoryCommit: commit,
    byteSize: index.byteLength,
    sha256: createHash("sha256").update(index).digest("hex")
  }));
}
