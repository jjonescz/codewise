import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const webDistDirectory = fileURLToPath(new URL("../dist/web/", import.meta.url));
await mkdir(distDirectory, { recursive: true });
await rm(webDistDirectory, { recursive: true, force: true });
await mkdir(webDistDirectory, { recursive: true });

await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    outfile: fileURLToPath(new URL("../dist/extension.cjs", import.meta.url)),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true
  }),
  build({
    entryPoints: [fileURLToPath(new URL("../../scip-lsp/src/node.ts", import.meta.url))],
    outfile: fileURLToPath(new URL("../dist/server.cjs", import.meta.url)),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: true
  }),
  build({
    entryPoints: [fileURLToPath(new URL("../src/test/run.ts", import.meta.url))],
    outfile: fileURLToPath(new URL("../dist/test-runner.cjs", import.meta.url)),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: true
  }),
  build({
    entryPoints: [
      fileURLToPath(new URL("../src/browser-extension.ts", import.meta.url))
    ],
    outfile: fileURLToPath(new URL("../dist/web/extension.cjs", import.meta.url)),
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    external: ["vscode"],
    sourcemap: true
  }),
  build({
    entryPoints: [
      fileURLToPath(new URL("../src/browser-server.ts", import.meta.url))
    ],
    outfile: fileURLToPath(new URL("../dist/web/server.js", import.meta.url)),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: true
  }),
  build({
    entryPoints: [
      fileURLToPath(new URL("../src/test/web-run.ts", import.meta.url))
    ],
    outfile: fileURLToPath(new URL("../dist/web/test-runner.cjs", import.meta.url)),
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    external: ["vscode"],
    sourcemap: true
  })
]);
