import { createHash } from "node:crypto";
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractVerifiedRoslynIndex,
  RoslynIndexValidationError
} from "./roslyn-index-artifact.js";

const commit = "0f82fdec3c901702ec7fc3f0e9a813330a903ec9";
const encoder = new TextEncoder();

describe("extractVerifiedRoslynIndex", () => {
  it("extracts an index whose commit, size, and SHA-256 match the manifest", async () => {
    const index = encoder.encode("valid SCIP bytes");
    const bundle = createBundle(index, commit);

    const result = await extractVerifiedRoslynIndex(bundle, commit);

    expect(result.index).toEqual(index);
    expect(JSON.parse(new TextDecoder().decode(result.manifest))).toMatchObject({
      schemaVersion: 1,
      roslynCommit: commit,
      byteSize: index.byteLength
    });
  });

  it("rejects an index produced for a different Roslyn commit", async () => {
    const bundle = createBundle(
      encoder.encode("valid SCIP bytes"),
      "1111111111111111111111111111111111111111"
    );

    await expect(extractVerifiedRoslynIndex(bundle, commit))
      .rejects.toThrowError(RoslynIndexValidationError);
    await expect(extractVerifiedRoslynIndex(bundle, commit))
      .rejects.toThrow(`not ${commit}`);
  });

  it("rejects an index whose bytes do not match the manifest SHA-256", async () => {
    const originalIndex = encoder.encode("original SCIP bytes");
    const replacementIndex = encoder.encode("modified SCIP bytes");
    const manifest = createManifest(originalIndex, commit);
    const bundle = wrapBundle(createTar({
      "index.scip": replacementIndex,
      "manifest.json": manifest
    }));

    await expect(extractVerifiedRoslynIndex(bundle, commit))
      .rejects.toThrow("SHA-256 does not match");
  });
});

function createBundle(index: Uint8Array, roslynCommit: string): Uint8Array {
  return wrapBundle(createTar({
    "index.scip": index,
    "manifest.json": createManifest(index, roslynCommit)
  }));
}

function createManifest(index: Uint8Array, roslynCommit: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    schemaVersion: 1,
    roslynCommit,
    byteSize: index.byteLength,
    sha256: createHash("sha256").update(index).digest("hex")
  }));
}

function wrapBundle(tarArchive: Uint8Array): Uint8Array {
  return gzipSync(tarArchive);
}

function createTar(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, contents] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    writeAscii(header, 0, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    writeAscii(header, 257, "ustar\0");
    writeAscii(header, 263, "00");

    const checksum = header.reduce((sum, value) => sum + value, 0);
    writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);

    const paddedContents = new Uint8Array(
      Math.ceil(contents.byteLength / 512) * 512
    );
    paddedContents.set(contents);
    chunks.push(header, paddedContents);
  }
  chunks.push(new Uint8Array(1024));

  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const archive = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  target.set(encoder.encode(value), offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number
): void {
  writeAscii(
    target,
    offset,
    `${value.toString(8).padStart(length - 1, "0")}\0`
  );
}
