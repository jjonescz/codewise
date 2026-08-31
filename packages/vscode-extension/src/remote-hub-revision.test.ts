import { describe, expect, it, vi } from "vitest";
import {
  detectGitHubPullRequestRevision,
  detectRemoteHubRevision,
  type RemoteHubApi,
  type RemoteHubExtension,
  type RemoteHubUri
} from "./remote-hub-revision.js";

const workspaceUri: RemoteHubUri = {
  scheme: "vscode-vfs",
  authority: "github+"
    + "7b2276223a312c22726566223a7b2274797065223a332c226964223a223834343139227d7d",
  path: "/dotnet/roslyn",
  toString: () => (
    "vscode-vfs://github%2B"
    + "7b2276223a312c22726566223a7b2274797065223a332c226964223a223834343139227d7d"
    + "/dotnet/roslyn"
  )
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

  it("initializes the workspace and retries delayed metadata", async () => {
    const getMetadata = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        getRevision: async () => ({ revision: commit })
      });
    const api: RemoteHubApi = { getMetadata };
    const initializeWorkspace = vi.fn(async () => {});

    const detected = await detectRemoteHubRevision(
      workspaceUri,
      () => ({
        isActive: true,
        exports: api,
        activate: async () => api
      }),
      initializeWorkspace
    );

    expect(detected).toBe(commit);
    expect(initializeWorkspace).toHaveBeenCalledOnce();
    expect(initializeWorkspace).toHaveBeenCalledWith(workspaceUri);
    expect(getMetadata).toHaveBeenCalledTimes(2);
  });

  it("initializes the workspace when its provider is not registered", async () => {
    const getMetadata = vi.fn()
      .mockRejectedValueOnce(new Error("No provider registered with github"))
      .mockResolvedValueOnce({
        getRevision: async () => ({ revision: commit })
      });
    const api: RemoteHubApi = { getMetadata };
    const initializeWorkspace = vi.fn(async () => {});

    await expect(detectRemoteHubRevision(
      workspaceUri,
      () => ({
        isActive: true,
        exports: api,
        activate: async () => api
      }),
      initializeWorkspace
    )).resolves.toBe(commit);

    expect(initializeWorkspace).toHaveBeenCalledOnce();
    expect(getMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated metadata errors", async () => {
    const failure = new Error("GitHub request failed");
    const api: RemoteHubApi = {
      getMetadata: vi.fn().mockRejectedValue(failure)
    };
    const initializeWorkspace = vi.fn(async () => {});

    await expect(detectRemoteHubRevision(
      workspaceUri,
      () => ({
        isActive: true,
        exports: api,
        activate: async () => api
      }),
      initializeWorkspace
    )).rejects.toBe(failure);

    expect(initializeWorkspace).not.toHaveBeenCalled();
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

describe("detectGitHubPullRequestRevision", () => {
  it("resolves the head commit from an encoded pull request workspace", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      ref: "refs/pull/84419/head",
      object: {
        type: "commit",
        sha: commit.toUpperCase()
      }
    }));

    await expect(
      detectGitHubPullRequestRevision(workspaceUri, fetcher)
    ).resolves.toBe(commit);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/dotnet/roslyn/git/ref/pull/84419/head",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }
    );
  });

  it("ignores workspaces that are not opened to a GitHub pull request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const branchWorkspace: RemoteHubUri = {
      ...workspaceUri,
      authority: "github",
      toString: () => "vscode-vfs://github/dotnet/roslyn"
    };

    await expect(
      detectGitHubPullRequestRevision(branchWorkspace, fetcher)
    ).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsuccessful pull request ref requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(undefined, {
      status: 403,
      statusText: "rate limit exceeded"
    }));

    await expect(
      detectGitHubPullRequestRevision(workspaceUri, fetcher)
    ).rejects.toThrow(
      "GitHub pull request revision lookup failed with HTTP 403 rate limit exceeded."
    );
  });

  it("rejects invalid pull request ref responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      object: {
        type: "commit",
        sha: "main"
      }
    }));

    await expect(
      detectGitHubPullRequestRevision(workspaceUri, fetcher)
    ).rejects.toThrow(
      "GitHub returned an invalid pull request ref response."
    );
  });
});
