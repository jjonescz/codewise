const indexerOwner = "jjonescz";
const indexerRepository = "indexer";
const githubApiVersion = "2022-11-28";
const maximumArtifactBytes = 512 * 1024 * 1024;

interface ArtifactList {
  readonly artifacts: readonly Artifact[];
}

interface Artifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly created_at: string;
}

export async function downloadRoslynArtifact(
  commit: string,
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<Uint8Array> {
  const artifact = await findRoslynArtifact(commit, accessToken, fetcher);
  if (artifact === undefined) {
    throw new Error(
      `No retained Roslyn SCIP workflow artifact is available for commit ${commit}.`
    );
  }

  const response = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: createHeaders(accessToken),
      redirect: "follow"
    }
  );
  if (!response.ok) {
    throw new Error(
      `GitHub artifact download failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  return readResponseBytes(response, maximumArtifactBytes);
}

async function findRoslynArtifact(
  commit: string,
  accessToken: string,
  fetcher: typeof fetch
): Promise<Artifact | undefined> {
  const artifactName = `roslyn-scip-${commit}`;
  const query = new URLSearchParams({
    name: artifactName,
    per_page: "100"
  });
  const response = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/actions/artifacts?${query}`,
    { headers: createHeaders(accessToken) }
  );
  if (!response.ok) {
    throw new Error(
      `GitHub artifact lookup failed with HTTP ${response.status} ${response.statusText}.`
    );
  }

  const payload: unknown = await response.json();
  if (!isArtifactList(payload)) {
    throw new Error("GitHub returned an invalid artifact-list response.");
  }

  return payload.artifacts
    .filter((artifact) => artifact.name === artifactName && !artifact.expired)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
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
  maximumBytes: number
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new Error(
        `The GitHub artifact exceeds the ${maximumBytes}-byte download limit.`
      );
    }
  }

  if (response.body === null) {
    throw new Error("GitHub returned an artifact response without a body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(
        `The GitHub artifact exceeds the ${maximumBytes}-byte download limit.`
      );
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
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
