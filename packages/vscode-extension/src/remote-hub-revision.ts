export const gitCommitPattern = /^[a-f0-9]{40}$/u;

const remoteHubExtensionIds = [
  "ms-vscode.remote-repositories",
  "GitHub.remoteHub",
  "GitHub.remoteHub-insiders"
] as const;

export interface RemoteHubUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  toString(skipEncoding?: boolean): string;
}

export interface RemoteHubRevision {
  readonly revision: string;
}

export interface RemoteHubMetadata {
  getRevision(): Promise<RemoteHubRevision>;
}

export interface RemoteHubApi {
  getMetadata(uri: RemoteHubUri): Promise<RemoteHubMetadata | undefined>;
}

export interface RemoteHubExtension {
  readonly isActive: boolean;
  readonly exports: RemoteHubApi;
  activate(): PromiseLike<RemoteHubApi>;
}

export type RemoteHubExtensionLookup = (
  extensionId: string
) => RemoteHubExtension | undefined;

export type RemoteHubWorkspaceInitializer = (
  workspaceUri: RemoteHubUri
) => PromiseLike<void>;

export async function detectRemoteHubRevision(
  workspaceUri: RemoteHubUri,
  getExtension: RemoteHubExtensionLookup,
  initializeWorkspace?: RemoteHubWorkspaceInitializer
): Promise<string | undefined> {
  const extension = remoteHubExtensionIds
    .map((extensionId) => getExtension(extensionId))
    .find((candidate) => candidate !== undefined);
  if (extension === undefined) {
    return undefined;
  }

  const api = extension.isActive
    ? extension.exports
    : await extension.activate();
  if (typeof api.getMetadata !== "function") {
    throw new Error("The Remote Repositories extension does not expose metadata.");
  }

  let metadata: RemoteHubMetadata | undefined;
  try {
    metadata = await api.getMetadata(workspaceUri);
  } catch (error) {
    if (initializeWorkspace === undefined || !isProviderUnavailableError(error)) {
      throw error;
    }
  }
  if (metadata === undefined && initializeWorkspace !== undefined) {
    await initializeWorkspace(workspaceUri);
    metadata = await api.getMetadata(workspaceUri);
  }
  if (metadata === undefined) {
    return undefined;
  }
  if (typeof metadata.getRevision !== "function") {
    throw new Error("The Remote Repositories metadata does not expose a revision.");
  }

  const { revision } = await metadata.getRevision();
  const commit = revision.trim().toLowerCase();
  if (!gitCommitPattern.test(commit)) {
    throw new Error(
      `Remote Repositories returned an invalid Git commit SHA: ${revision}`
    );
  }
  return commit;
}

export async function detectGitHubRevision(
  workspaceUri: RemoteHubUri,
  fetcher: typeof fetch = fetch
): Promise<string | undefined> {
  const workspace = parseGitHubWorkspace(workspaceUri);
  if (workspace === undefined) {
    return undefined;
  }

  const { owner, repository, ref } = workspace;
  if (ref.type === "commit") {
    return ref.id;
  }
  const isPullRequest = ref.type === "pull-request";
  const description = isPullRequest ? "pull request" : "workspace";
  const revisionPath = isPullRequest
    ? `git/ref/pull/${ref.id}/head`
    : `commits/${encodeURIComponent(ref.id)}`;
  const response = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/`
    + `${encodeURIComponent(repository)}/${revisionPath}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );
  if (!response.ok) {
    const status = response.statusText === ""
      ? String(response.status)
      : `${response.status} ${response.statusText}`;
    throw new Error(
      `GitHub ${description} revision lookup failed with HTTP ${status}.`
    );
  }

  const payload: unknown = await response.json();
  const revision = isPullRequest
    ? getPullRequestHeadRevision(payload)
    : isRecord(payload) ? normalizeCommit(payload["sha"]) : undefined;
  if (revision === undefined) {
    throw new Error(`GitHub returned an invalid ${description} ref response.`);
  }
  return revision;
}

function isProviderUnavailableError(error: unknown): boolean {
  return error instanceof Error
    && /No provider registered/iu.test(error.message);
}

interface GitHubWorkspace {
  readonly owner: string;
  readonly repository: string;
  readonly ref: {
    readonly type: "ref" | "commit" | "pull-request";
    readonly id: string;
  };
}

function parseGitHubWorkspace(
  workspaceUri: RemoteHubUri
): GitHubWorkspace | undefined {
  if (workspaceUri.scheme !== "vscode-vfs") {
    return undefined;
  }

  const separatorIndex = workspaceUri.authority.indexOf("+");
  const provider = separatorIndex === -1
    ? workspaceUri.authority
    : workspaceUri.authority.slice(0, separatorIndex);
  if (provider.toLowerCase() !== "github") {
    return undefined;
  }

  const [owner, repository] = workspaceUri.path
    .split("/")
    .filter((segment) => segment !== "");
  if (owner === undefined || repository === undefined) {
    return undefined;
  }

  let ref: GitHubWorkspace["ref"] = { type: "ref", id: "HEAD" };
  if (separatorIndex !== -1) {
    const metadata = decodeAuthorityMetadata(
      workspaceUri.authority.slice(separatorIndex + 1)
    );
    if (!isRecord(metadata) || metadata["v"] !== 1) {
      throw new Error("The GitHub workspace URI contains unsupported metadata.");
    }
    if (metadata["ref"] !== undefined) {
      const encodedRef = metadata["ref"];
      if (
        !isRecord(encodedRef)
        || typeof encodedRef["id"] !== "string"
        || encodedRef["id"].trim() === ""
      ) {
        throw new Error("The GitHub workspace URI contains an invalid ref.");
      }
      const id = encodedRef["id"];
      switch (encodedRef["type"]) {
        case 0: // Branch
        case 1: // Tag
        case 4: // Tree
          ref = { type: "ref", id };
          break;
        case 2: {
          const commit = normalizeCommit(id);
          if (commit === undefined) {
            throw new Error("The GitHub workspace URI contains an invalid commit.");
          }
          ref = { type: "commit", id: commit };
          break;
        }
        case 3:
          if (!/^[1-9][0-9]*$/u.test(id)) {
            throw new Error("The GitHub workspace URI contains an invalid pull request.");
          }
          ref = { type: "pull-request", id };
          break;
        default:
          throw new Error("The GitHub workspace URI contains an unsupported ref type.");
      }
    }
  }
  return { owner, repository, ref };
}

function decodeAuthorityMetadata(encodedMetadata: string): unknown {
  if (
    encodedMetadata === ""
    || encodedMetadata.length % 2 !== 0
    || !/^[a-f0-9]+$/iu.test(encodedMetadata)
  ) {
    throw new Error("The GitHub workspace URI contains invalid metadata.");
  }

  const bytes = new Uint8Array(encodedMetadata.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      encodedMetadata.slice(index * 2, index * 2 + 2),
      16
    );
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      "The GitHub workspace URI contains invalid metadata.",
      { cause: error }
    );
  }
}

function getPullRequestHeadRevision(payload: unknown): string | undefined {
  if (
    !isRecord(payload)
    || !isRecord(payload["object"])
    || payload["object"]["type"] !== "commit"
    || typeof payload["object"]["sha"] !== "string"
  ) {
    return undefined;
  }

  return normalizeCommit(payload["object"]["sha"]);
}

function normalizeCommit(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const commit = value.trim().toLowerCase();
  return gitCommitPattern.test(commit) ? commit : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
