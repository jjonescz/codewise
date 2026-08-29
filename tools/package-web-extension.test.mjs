import {
  mkdtemp,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packageWebExtension } from "./package-web-extension.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { recursive: true, force: true })
    )
  );
});

describe("packageWebExtension", () => {
  it("creates a minimal unpacked extension for remote web installation", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "codewise-web-extension-")
    );
    temporaryDirectories.push(temporaryDirectory);
    const outputDirectory = resolve(temporaryDirectory, "codewise-scip");

    await packageWebExtension({
      outputDirectory,
      logger: () => undefined
    });

    const files = (await readdir(outputDirectory, {
      recursive: true,
      withFileTypes: true
    }))
      .filter((entry) => entry.isFile())
      .map((entry) => (
        `${entry.parentPath.slice(outputDirectory.length + 1)}\\${entry.name}`
          .replace(/^\\/u, "")
          .replaceAll("\\", "/")
      ))
      .sort();
    expect(files).toEqual([
      "LICENSE",
      "README.md",
      "dist/web/extension.cjs",
      "dist/web/server.js",
      "package.json"
    ]);

    const manifest = JSON.parse(
      await readFile(resolve(outputDirectory, "package.json"), "utf8")
    );
    expect(manifest.browser).toBe("./dist/web/extension.cjs");
    expect(manifest.main).toBeUndefined();
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });
});
