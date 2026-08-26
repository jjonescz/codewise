import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(distDirectory, { recursive: true });

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
  })
]);
