const indexerOwner = "jjonescz";
const indexerRepository = "codewise";
const githubApiVersion = "2022-11-28";
const maximumArtifactBytes = 512 * 1024 * 1024;

export type ArtifactLogger = (message: string) => void;
export type ArtifactOperation = "lookup" | "download";

export interface ArtifactDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | undefined;
}

export class GitHubArtifactHttpError extends Error {
  public readonly operation: ArtifactOperation;
  public readonly status: number;

  public constructor(
    operation: ArtifactOperation,
    status: number,
    statusText: string
  ) {
    const operationDescription = operation === "lookup"
      ? "artifact lookup"
      : "artifact download";
    super(
      `GitHub ${operationDescription} failed with HTTP ${status} ${statusText}.`
    );
    this.name = "GitHubArtifactHttpError";
    this.operation = operation;
    this.status = status;
  }
}

interface ArtifactList {
  readonly artifacts: readonly RoslynArtifact[];
}

export interface RoslynArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly created_at: string;
}

export interface RoslynArtifactSelection {
  readonly commit: string;
  readonly artifact: RoslynArtifact;
}

export async function downloadRoslynArtifact(
  commitOrArtifact: string | RoslynArtifact,
  accessToken: string,
  logger?: ArtifactLogger,
  fetcher: typeof fetch = fetch,
  onProgress?: (progress: ArtifactDownloadProgress) => void
): Promise<Uint8Array> {
  const artifact = typeof commitOrArtifact === "string"
    ? await findRoslynArtifact(commitOrArtifact, accessToken, logger, fetcher)
    : commitOrArtifact;
  if (artifact === undefined) {
    throw new Error(
      `No retained Roslyn Codewise workflow artifact is available for commit ${commitOrArtifact}.`
    );
  }
  logger?.(
    `Downloading GitHub Actions artifact ${artifact.id} `
    + `(created ${artifact.created_at}).`
  );

  const response = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: createHeaders(accessToken),
      redirect: "follow"
    }
  );
  logger?.(
    `Artifact download returned HTTP ${describeHttpResponse(response)}.`
  );
  if (!response.ok) {
    throw new GitHubArtifactHttpError(
      "download",
      response.status,
      response.statusText
    );
  }

  const bytes = await readResponseBytes(response, maximumArtifactBytes, onProgress);
  logger?.(`Downloaded ${bytes.byteLength} artifact bytes.`);
  return bytes;
}

export async function findRoslynArtifact(
  commit: string,
  accessToken: string,
  logger?: ArtifactLogger,
  fetcher: typeof fetch = fetch
): Promise<RoslynArtifact | undefined> {
  const artifactName = `roslyn-codewise-${commit}`;
  logger?.(`Looking up GitHub Actions artifact ${artifactName}.`);
  const query = new URLSearchParams({
    name: artifactName,
    per_page: "100"
  });
  const payload = await listArtifacts(query, accessToken, fetcher, logger);

  const candidates = payload.artifacts
    .filter((artifact) => artifact.name === artifactName && !artifact.expired)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  logger?.(
    `Artifact lookup returned ${payload.artifacts.length} result(s), `
    + `${candidates.length} retained candidate(s).`
  );
  return candidates[0];
}

export async function findLatestRoslynArtifact(
  workspaceCommit: string,
  accessToken: string,
  logger?: ArtifactLogger,
  fetcher: typeof fetch = fetch
): Promise<RoslynArtifactSelection | undefined> {
  const candidates = new Map<string, RoslynArtifact>();
  for (let page = 1; ; page += 1) {
    const payload = await listArtifacts(
      new URLSearchParams({ per_page: "100", page: String(page) }),
      accessToken,
      fetcher,
      logger
    );
    for (const artifact of payload.artifacts) {
      const match = /^roslyn-codewise-([a-f0-9]{40})$/u.exec(artifact.name);
      const commit = match?.[1];
      if (commit === undefined || artifact.expired) {
        continue;
      }
      const previous = candidates.get(commit);
      if (
        previous === undefined
        || artifact.created_at.localeCompare(previous.created_at) > 0
      ) {
        candidates.set(commit, artifact);
      }
    }
    if (payload.artifacts.length < 100) {
      break;
    }
  }

  logger?.(
    `Checking ${candidates.size} retained indexed commit(s) against Roslyn history.`
  );
  let selection: RoslynArtifactSelection | undefined;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const [commit, artifact] of candidates) {
    if (commit === workspaceCommit) {
      return { commit, artifact };
    }
    const response = await fetcher(
      `https://api.github.com/repos/dotnet/roslyn/compare/`
      + `${commit}...${workspaceCommit}?per_page=1`,
      { headers: createHeaders(accessToken) }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub Roslyn history lookup failed with HTTP ${describeHttpResponse(response)}.`
      );
    }
    const comparison: unknown = await response.json();
    if (
      !isRecord(comparison)
      || !["ahead", "behind", "diverged", "identical"].includes(
        String(comparison["status"])
      )
      || typeof comparison["ahead_by"] !== "number"
      || !Number.isSafeInteger(comparison["ahead_by"])
      || comparison["ahead_by"] < 0
    ) {
      throw new Error("GitHub returned an invalid commit-comparison response.");
    }
    if (
      (comparison["status"] === "ahead" || comparison["status"] === "identical")
      && comparison["ahead_by"] < minimumDistance
    ) {
      selection = { commit, artifact };
      minimumDistance = comparison["ahead_by"];
    }
  }
  logger?.(selection === undefined
    ? `No retained indexed ancestor was found for ${workspaceCommit}.`
    : `Selected indexed ancestor ${selection.commit}, ${minimumDistance} commit(s) behind ${workspaceCommit}.`
  );
  return selection;
}

async function listArtifacts(
  query: URLSearchParams,
  accessToken: string,
  fetcher: typeof fetch,
  logger?: ArtifactLogger
): Promise<ArtifactList> {
  const response = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/actions/artifacts?${query}`,
    { headers: createHeaders(accessToken) }
  );
  logger?.(`Artifact lookup returned HTTP ${describeHttpResponse(response)}.`);
  if (!response.ok) {
    throw new GitHubArtifactHttpError(
      "lookup",
      response.status,
      response.statusText
    );
  }
  const payload: unknown = await response.json();
  if (!isArtifactList(payload)) {
    throw new Error("GitHub returned an invalid artifact-list response.");
  }
  return payload;
}

function createHeaders(accessToken: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": githubApiVersion
  };
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  onProgress?: (progress: ArtifactDownloadProgress) => void
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  const parsedLength = contentLength !== null && /^[0-9]+$/u.test(contentLength)
    ? Number(contentLength)
    : Number.NaN;
  if (parsedLength > maximumBytes) {
    throw new Error(
      `The GitHub artifact exceeds the ${maximumBytes}-byte download limit.`
    );
  }
  const totalBytes = Number.isSafeInteger(parsedLength) && parsedLength > 0
    ? parsedLength
    : undefined;

  if (response.body === null) {
    throw new Error("GitHub returned an artifact response without a body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedBytes = 0;
  onProgress?.({ downloadedBytes, totalBytes });
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    downloadedBytes += result.value.byteLength;
    if (downloadedBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(
        `The GitHub artifact exceeds the ${maximumBytes}-byte download limit.`
      );
    }
    chunks.push(result.value);
    onProgress?.({ downloadedBytes, totalBytes });
  }

  const bytes = new Uint8Array(downloadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isArtifactList(value: unknown): value is ArtifactList {
  if (!isRecord(value) || !Array.isArray(value["artifacts"])) {
    return false;
  }
  return value["artifacts"].every((artifact) => (
    isRecord(artifact)
    && Number.isSafeInteger(artifact["id"])
    && typeof artifact["name"] === "string"
    && typeof artifact["expired"] === "boolean"
    && typeof artifact["created_at"] === "string"
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeHttpResponse(response: Response): string {
  return response.statusText === ""
    ? String(response.status)
    : `${response.status} ${response.statusText}`;
}
