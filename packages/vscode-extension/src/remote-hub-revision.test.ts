import { describe, expect, it, vi } from "vitest";
import {
  detectRemoteHubRevision,
  type RemoteHubApi,
  type RemoteHubExtension,
  type RemoteHubUri
} from "./remote-hub-revision.js";

const workspaceUri: RemoteHubUri = {
  scheme: "vscode-vfs",
  toString: () => "vscode-vfs://github/dotnet/roslyn"
};

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("detectRemoteHubRevision", () => {
  it("activates Remote Repositories and returns its exact revision", async () => {
    const getMetadata = vi.fn(async () => ({
      getRevision: async () => ({ revision: commit.toUpperCase() })
    }));
    const api: RemoteHubApi = { getMetadata };
    const activate = vi.fn(async () => api);
    const extension: RemoteHubExtension = {
      isActive: false,
      exports: api,
      activate
    };
    const getExtension = vi.fn((extensionId: string) => (
      extensionId === "GitHub.remoteHub" ? extension : undefined
    ));

    await expect(
      detectRemoteHubRevision(workspaceUri, getExtension)
    ).resolves.toBe(commit);

    expect(getExtension).toHaveBeenNthCalledWith(
      1,
      "ms-vscode.remote-repositories"
    );
    expect(getExtension).toHaveBeenNthCalledWith(2, "GitHub.remoteHub");
    expect(activate).toHaveBeenCalledOnce();
    expect(getMetadata).toHaveBeenCalledWith(workspaceUri);
  });

  it("uses exports directly when the extension is already active", async () => {
    const api: RemoteHubApi = {
      getMetadata: async () => ({
        getRevision: async () => ({ revision: commit })
      })
    };
    const activate = vi.fn(async () => api);

    const detected = await detectRemoteHubRevision(
      workspaceUri,
      () => ({
        isActive: true,
        exports: api,
        activate
      })
    );

    expect(detected).toBe(commit);
    expect(activate).not.toHaveBeenCalled();
  });

  it("returns undefined when RemoteHub metadata is unavailable", async () => {
    await expect(
      detectRemoteHubRevision(workspaceUri, () => undefined)
    ).resolves.toBeUndefined();

    const api: RemoteHubApi = {
      getMetadata: async () => undefined
    };
    await expect(
      detectRemoteHubRevision(workspaceUri, () => ({
        isActive: true,
        exports: api,
        activate: async () => api
      }))
    ).resolves.toBeUndefined();
  });

  it("rejects an invalid revision returned by RemoteHub", async () => {
    const api: RemoteHubApi = {
      getMetadata: async () => ({
        getRevision: async () => ({ revision: "main" })
      })
    };

    await expect(
      detectRemoteHubRevision(workspaceUri, () => ({
        isActive: true,
        exports: api,
        activate: async () => api
      }))
    ).rejects.toThrow(
      "Remote Repositories returned an invalid Git commit SHA: main"
    );
  });
});
