export const gitCommitPattern = /^[a-f0-9]{40}$/u;

const remoteHubExtensionIds = [
  "ms-vscode.remote-repositories",
  "GitHub.remoteHub",
  "GitHub.remoteHub-insiders"
] as const;

export interface RemoteHubUri {
  readonly scheme: string;
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

export async function detectRemoteHubRevision(
  workspaceUri: RemoteHubUri,
  getExtension: RemoteHubExtensionLookup
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

  const metadata = await api.getMetadata(workspaceUri);
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
