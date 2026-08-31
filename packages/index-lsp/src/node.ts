#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures
} from "vscode-languageserver/node";
import { NodeFileIndexSource } from "./node-file-index-source.js";
import { registerIndexLanguageServer } from "./server.js";

function findIndexArgument(args: readonly string[]): string | undefined {
  const index = args.indexOf("--index");
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--index requires a file path.");
  }
  return value;
}

try {
  const connection = createConnection(ProposedFeatures.all);
  const indexSource = new NodeFileIndexSource(
    findIndexArgument(process.argv.slice(2))
  );
  registerIndexLanguageServer(connection, indexSource);
  connection.listen();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
