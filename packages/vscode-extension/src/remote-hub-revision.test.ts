import { describe, expect, it, vi } from "vitest";
import {
  detectGitHubRevision,
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

describe("detectGitHubRevision", () => {
  it("resolves the head commit from an encoded pull request workspace", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      ref: "refs/pull/84419/head",
      object: {
        type: "commit",
        sha: commit.toUpperCase()
      }
    }));

    await expect(
      detectGitHubRevision(workspaceUri, fetcher)
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

  it("resolves the default branch of a plain repository workspace", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      sha: commit.toUpperCase()
    }));
    const defaultWorkspace: RemoteHubUri = {
      ...workspaceUri,
      authority: "github",
      toString: () => "vscode-vfs://github/dotnet/roslyn"
    };

    await expect(detectGitHubRevision(defaultWorkspace, fetcher)).resolves.toBe(commit);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/dotnet/roslyn/commits/HEAD",
      expect.any(Object)
    );
  });

  it.each([
    [0, "feature/navigation"],
    [1, "v4.0.0"],
    [4, "main"]
  ])("resolves encoded ref type %s without assuming the default branch", async (type, id) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sha: commit }));

    await expect(
      detectGitHubRevision(workspaceWithRef(type, id), fetcher)
    ).resolves.toBe(commit);
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/dotnet/roslyn/commits/${encodeURIComponent(id)}`,
      expect.any(Object)
    );
  });

  it("uses an encoded commit without a GitHub request", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      detectGitHubRevision(workspaceWithRef(2, commit.toUpperCase()), fetcher)
    ).resolves.toBe(commit);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves metadata without a ref to the default branch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sha: commit }));
    const uri = {
      ...workspaceUri,
      authority: `github+${Buffer.from(JSON.stringify({ v: 1 })).toString("hex")}`
    };

    await expect(detectGitHubRevision(uri, fetcher)).resolves.toBe(commit);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/dotnet/roslyn/commits/HEAD",
      expect.any(Object)
    );
  });

  it("ignores non-GitHub workspaces", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const branchWorkspace: RemoteHubUri = {
      ...workspaceUri,
      authority: "azurerepos",
      toString: () => "vscode-vfs://azurerepos/dotnet/roslyn"
    };

    await expect(
      detectGitHubRevision(branchWorkspace, fetcher)
    ).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsuccessful pull request ref requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(undefined, {
      status: 403,
      statusText: "rate limit exceeded"
    }));

    await expect(
      detectGitHubRevision(workspaceUri, fetcher)
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
      detectGitHubRevision(workspaceUri, fetcher)
    ).rejects.toThrow(
      "GitHub returned an invalid pull request ref response."
    );
  });

  it("rejects invalid branch responses instead of returning a branch name", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sha: "main" }));

    await expect(detectGitHubRevision(workspaceWithRef(0, "main"), fetcher))
      .rejects.toThrow("GitHub returned an invalid workspace ref response.");
  });

  it.each([
    [2, "not-a-commit"],
    [3, "0"],
    [0, ""],
    [99, "main"]
  ])("rejects invalid encoded ref type %s and ID %s", async (type, id) => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(detectGitHubRevision(workspaceWithRef(type, id), fetcher))
      .rejects.toThrow("The GitHub workspace URI contains");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects corrupt authority metadata", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(detectGitHubRevision({
      ...workspaceUri,
      authority: "github+not-hex"
    }, fetcher)).rejects.toThrow("The GitHub workspace URI contains invalid metadata.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function workspaceWithRef(type: number, id: string): RemoteHubUri {
  const metadata = Buffer.from(JSON.stringify({ v: 1, ref: { type, id } })).toString("hex");
  return { ...workspaceUri, authority: `github+${metadata}` };
}
