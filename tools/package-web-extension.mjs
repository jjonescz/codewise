import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultExtensionDirectory = resolve(
  repositoryRoot,
  "packages",
  "vscode-extension"
);
const defaultOutputDirectory = resolve(
  repositoryRoot,
  "artifacts",
  "web-extension",
  "codewise-scip"
);
const hostedBrowserEntry = "./dist/web/extension.js";

export async function packageWebExtension({
  extensionDirectory = defaultExtensionDirectory,
  outputDirectory = defaultOutputDirectory,
  logger = console.log
} = {}) {
  const manifestPath = resolve(extensionDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.browser !== "string" || manifest.browser === "") {
    throw new Error(`Extension manifest has no browser entry: ${manifestPath}`);
  }

  const {
    devDependencies: _devDependencies,
    main: _main,
    private: _private,
    scripts: _scripts,
    type: _type,
    ...webManifest
  } = manifest;
  webManifest.browser = hostedBrowserEntry;
  const filesToCopy = [
    ["README.md", "README.md"],
    ["LICENSE", "LICENSE"],
    [manifest.browser, hostedBrowserEntry],
    ["dist/web/server.js", "dist/web/server.js"]
  ];

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "package.json"),
    `${JSON.stringify(webManifest, undefined, 2)}\n`,
    "utf8"
  );

  for (const [sourcePath, destinationPath] of filesToCopy) {
    const source = resolve(extensionDirectory, sourcePath);
    const destination = resolve(outputDirectory, destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(source, destination);
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new Error(
          `Required web extension file is missing: ${source}. Build the extension first.`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  logger(
    `Packaged unpacked web extension at `
    + `${relative(repositoryRoot, outputDirectory)}`
  );
  return outputDirectory;
}

function isFileNotFound(error) {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  await packageWebExtension();
}
