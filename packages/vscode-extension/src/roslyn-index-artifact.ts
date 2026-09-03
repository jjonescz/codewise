import { gunzipSync, unzipSync } from "fflate";

const bundleFileName = "roslyn-codewise.tar.gz";
const indexFileName = "index.db";
const manifestFileName = "manifest.json";

export interface VerifiedRoslynIndex {
  readonly index: Uint8Array;
  readonly manifest: Uint8Array;
}

export class RoslynIndexValidationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoslynIndexValidationError";
  }
}

export async function extractVerifiedRoslynIndex(
  artifact: Uint8Array,
  expectedCommit: string
): Promise<VerifiedRoslynIndex> {
  let zipEntries: Record<string, Uint8Array>;
  try {
    zipEntries = unzipSync(artifact, {
      filter: (entry) => normalizeArchivePath(entry.name) === bundleFileName
    });
  } catch (error) {
    throw new RoslynIndexValidationError(
      "The downloaded GitHub artifact is not a valid ZIP archive.",
      { cause: error }
    );
  }

  const bundles = Object.entries(zipEntries).filter(
    ([name]) => normalizeArchivePath(name) === bundleFileName
  );
  if (bundles.length !== 1) {
    throw new RoslynIndexValidationError(
      `The GitHub artifact must contain exactly one ${bundleFileName}.`
    );
  }

  let tarArchive: Uint8Array;
  try {
    tarArchive = gunzipSync(bundles[0]![1]);
  } catch (error) {
    throw new RoslynIndexValidationError(
      `${bundleFileName} is not a valid gzip archive.`,
      { cause: error }
    );
  }

  const files = readSelectedTarFiles(
    tarArchive,
    new Set([indexFileName, manifestFileName])
  );
  const index = files.get(indexFileName);
  const manifest = files.get(manifestFileName);
  if (index === undefined || manifest === undefined) {
    throw new RoslynIndexValidationError(
      `${bundleFileName} must contain ${indexFileName} and ${manifestFileName}.`
    );
  }

  await verifyRoslynIndex(index, manifest, expectedCommit);
  return { index, manifest };
}

export async function verifyRoslynIndex(
  index: Uint8Array,
  manifestBytes: Uint8Array,
  expectedCommit: string
): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise manifest is not valid UTF-8 JSON.",
      { cause: error }
    );
  }

  if (
    !isRecord(manifest)
    || (manifest["schemaVersion"] !== 2 && manifest["schemaVersion"] !== 3)
  ) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise manifest has an unsupported schema version."
    );
  }
  const indexedCommit = manifest["schemaVersion"] === 2
    ? manifest["roslynCommit"]
    : manifest["repositoryCommit"];
  if (indexedCommit !== expectedCommit) {
    throw new RoslynIndexValidationError(
      `The Roslyn Codewise manifest targets ${String(indexedCommit)}, not ${expectedCommit}.`
    );
  }

  const byteSize = manifest["byteSize"];
  if (!Number.isSafeInteger(byteSize) || byteSize !== index.byteLength) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise index size does not match its manifest."
    );
  }

  const expectedSha256 = manifest["sha256"];
  if (
    typeof expectedSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(expectedSha256)
  ) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise manifest does not contain a valid SHA-256."
    );
  }

  const digestInput = index.buffer instanceof ArrayBuffer
    ? new Uint8Array(index.buffer, index.byteOffset, index.byteLength)
    : Uint8Array.from(index);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  const actualSha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  if (actualSha256 !== expectedSha256) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise index SHA-256 does not match its manifest."
    );
  }
}

function readSelectedTarFiles(
  archive: Uint8Array,
  selectedNames: ReadonlySet<string>
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }

    verifyTarHeaderChecksum(header);
    const name = normalizeArchivePath(readTarString(header, 0, 100));
    const prefix = normalizeArchivePath(readTarString(header, 345, 155));
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const size = readTarOctal(header, 124, 12, "file size");
    const type = header[156];
    const dataOffset = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    const nextOffset = dataOffset + paddedSize;
    if (nextOffset > archive.byteLength) {
      throw new RoslynIndexValidationError("The Roslyn Codewise tar archive is truncated.");
    }

    if ((type === 0 || type === 48) && selectedNames.has(fullName)) {
      if (files.has(fullName)) {
        throw new RoslynIndexValidationError(
          `The Roslyn Codewise tar archive contains duplicate ${fullName} entries.`
        );
      }
      files.set(fullName, archive.slice(dataOffset, dataOffset + size));
    }

    offset = nextOffset;
  }

  return files;
}

function verifyTarHeaderChecksum(header: Uint8Array): void {
  const expected = readTarOctal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) {
    throw new RoslynIndexValidationError(
      "The Roslyn Codewise tar archive has an invalid header checksum."
    );
  }
}

function readTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  fieldName: string
): number {
  const value = readTarString(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new RoslynIndexValidationError(
      `The Roslyn Codewise tar archive has an invalid ${fieldName}.`
    );
  }

  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RoslynIndexValidationError(
      `The Roslyn Codewise tar archive has an unsupported ${fieldName}.`
    );
  }
  return parsed;
}

function readTarString(
  header: Uint8Array,
  offset: number,
  length: number
): string {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  return new TextDecoder("ascii").decode(bytes);
}

function normalizeArchivePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
