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

export async function detectGitHubPullRequestRevision(
  workspaceUri: RemoteHubUri,
  fetcher: typeof fetch = fetch
): Promise<string | undefined> {
  const pullRequest = parseGitHubPullRequestWorkspace(workspaceUri);
  if (pullRequest === undefined) {
    return undefined;
  }

  const { owner, repository, number } = pullRequest;
  const response = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/`
    + `${encodeURIComponent(repository)}/git/ref/pull/${number}/head`,
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
      `GitHub pull request revision lookup failed with HTTP ${status}.`
    );
  }

  const payload: unknown = await response.json();
  const revision = getPullRequestHeadRevision(payload);
  if (revision === undefined) {
    throw new Error("GitHub returned an invalid pull request ref response.");
  }
  return revision;
}

function isProviderUnavailableError(error: unknown): boolean {
  return error instanceof Error
    && /No provider registered/iu.test(error.message);
}

interface GitHubPullRequestWorkspace {
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
}

function parseGitHubPullRequestWorkspace(
  workspaceUri: RemoteHubUri
): GitHubPullRequestWorkspace | undefined {
  if (workspaceUri.scheme !== "vscode-vfs") {
    return undefined;
  }

  const separatorIndex = workspaceUri.authority.indexOf("+");
  const provider = separatorIndex === -1
    ? workspaceUri.authority
    : workspaceUri.authority.slice(0, separatorIndex);
  if (provider.toLowerCase() !== "github" || separatorIndex === -1) {
    return undefined;
  }

  const encodedMetadata = workspaceUri.authority.slice(separatorIndex + 1);
  const metadata = decodeAuthorityMetadata(encodedMetadata);
  if (
    !isRecord(metadata)
    || metadata["v"] !== 1
    || !isRecord(metadata["ref"])
    || metadata["ref"]["type"] !== 3
    || typeof metadata["ref"]["id"] !== "string"
    || !/^[1-9][0-9]*$/u.test(metadata["ref"]["id"])
  ) {
    return undefined;
  }

  const [owner, repository] = workspaceUri.path
    .split("/")
    .filter((segment) => segment !== "");
  if (owner === undefined || repository === undefined) {
    return undefined;
  }

  return {
    owner,
    repository,
    number: metadata["ref"]["id"]
  };
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

  const revision = payload["object"]["sha"].trim().toLowerCase();
  return gitCommitPattern.test(revision) ? revision : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
