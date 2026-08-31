const indexerOwner = "jjonescz";
const indexerRepository = "indexer";
const githubApiVersion = "2022-11-28";
const releaseAssetName = "roslyn-scip.tar.gz";
const maximumReleaseAssetBytes = 512 * 1024 * 1024;

export type ReleaseLogger = (message: string) => void;
export type ReleaseOperation = "lookup" | "download";

export class GitHubReleaseHttpError extends Error {
  public readonly operation: ReleaseOperation;
  public readonly status: number;

  public constructor(
    operation: ReleaseOperation,
    status: number,
    statusText: string
  ) {
    const operationDescription = operation === "lookup"
      ? "release lookup"
      : "release asset download";
    super(
      `GitHub ${operationDescription} failed with HTTP ${status} ${statusText}.`
    );
    this.name = "GitHubReleaseHttpError";
    this.operation = operation;
    this.status = status;
  }
}

interface Release {
  readonly assets: readonly ReleaseAsset[];
}

interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly created_at: string;
}

export async function downloadRoslynRelease(
  commit: string,
  logger?: ReleaseLogger,
  fetcher: typeof fetch = fetch
): Promise<Uint8Array> {
  const releaseTag = `roslyn-scip-${commit}`;
  logger?.(`Looking up public GitHub release ${releaseTag}.`);
  const lookupResponse = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers: createHeaders("application/vnd.github+json") }
  );
  logger?.(
    `Release lookup returned HTTP ${describeHttpResponse(lookupResponse)}.`
  );
  if (!lookupResponse.ok) {
    throw new GitHubReleaseHttpError(
      "lookup",
      lookupResponse.status,
      lookupResponse.statusText
    );
  }

  const payload: unknown = await lookupResponse.json();
  if (!isRelease(payload)) {
    throw new Error("GitHub returned an invalid release response.");
  }
  logger?.(`Release lookup returned ${payload.assets.length} asset(s).`);

  const matchingAssets = payload.assets.filter(
    (asset) => asset.name === releaseAssetName
  );
  if (matchingAssets.length !== 1) {
    throw new Error(
      `Public release ${releaseTag} must contain exactly one ${releaseAssetName} asset.`
    );
  }

  const asset = matchingAssets[0]!;
  if (asset.size > maximumReleaseAssetBytes) {
    throw new Error(
      `The GitHub release asset exceeds the ${maximumReleaseAssetBytes}-byte download limit.`
    );
  }
  logger?.(
    `Downloading public GitHub release asset ${asset.name} `
    + `(id ${asset.id}, created ${asset.created_at}).`
  );

  const downloadResponse = await fetcher(
    `https://api.github.com/repos/${indexerOwner}/${indexerRepository}/releases/assets/${asset.id}`,
    {
      headers: createHeaders("application/octet-stream"),
      redirect: "follow"
    }
  );
  logger?.(
    `Release asset download returned HTTP ${describeHttpResponse(downloadResponse)}.`
  );
  if (!downloadResponse.ok) {
    throw new GitHubReleaseHttpError(
      "download",
      downloadResponse.status,
      downloadResponse.statusText
    );
  }

  const bytes = await readResponseBytes(
    downloadResponse,
    maximumReleaseAssetBytes
  );
  logger?.(`Downloaded ${bytes.byteLength} release asset bytes.`);
  return bytes;
}

function createHeaders(accept: string): HeadersInit {
  return {
    Accept: accept,
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
        `The GitHub release asset exceeds the ${maximumBytes}-byte download limit.`
      );
    }
  }

  if (response.body === null) {
    throw new Error("GitHub returned a release asset response without a body.");
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
        `The GitHub release asset exceeds the ${maximumBytes}-byte download limit.`
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

function isRelease(value: unknown): value is Release {
  if (!isRecord(value) || !Array.isArray(value["assets"])) {
    return false;
  }
  return value["assets"].every((asset) => (
    isRecord(asset)
    && Number.isSafeInteger(asset["id"])
    && typeof asset["name"] === "string"
    && Number.isSafeInteger(asset["size"])
    && typeof asset["size"] === "number"
    && asset["size"] >= 0
    && typeof asset["created_at"] === "string"
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
