import { exportRuntimeIndex } from "../packages/lsp-crawler/dist/index.js";

const [sourcePath, outputPath, ...extraArguments] = process.argv.slice(2);
if (sourcePath === undefined || outputPath === undefined || extraArguments.length > 0) {
  throw new Error("Usage: npm run export:runtime -- <crawl.db> <runtime.db>");
}
const exported = exportRuntimeIndex(sourcePath, outputPath);
console.log(
  `Exported compact runtime index: ${exported.sourceByteSize.toLocaleString()} -> `
  + `${exported.byteSize.toLocaleString()} bytes `
  + `(${(100 * (1 - exported.byteSize / exported.sourceByteSize)).toFixed(1)}% smaller).`
);
