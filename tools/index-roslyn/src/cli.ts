#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  crawlWorkspace,
  type CrawlerConfig,
  type CrawlSummary
} from "@codewise/lsp-crawler";

interface Options {
  readonly roslynRoot: string;
  readonly databasePath?: string;
  readonly concurrency: number;
}

interface Manifest {
  readonly schemaVersion: 2;
  readonly roslynCommit: string;
  readonly repositoryRoot: string;
  readonly indexedWorkspace: ".";
  readonly indexer: {
    readonly name: "codewise-lsp-crawler";
    readonly languageServer: "roslyn-language-server";
  };
  readonly createdAt: string;
  readonly generationDurationMilliseconds: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly statistics: CrawlSummary["database"];
}

function usage(): string {
  return [
    "Usage: codewise-index-roslyn [options]",
    "",
    "Options:",
    "  --roslyn-root <path>   Roslyn checkout root (default: C:\\roslyn-3 on Windows)",
    "  --database <path>      Output database path",
    "  --concurrency <number> Concurrent document crawls (default: 4)",
    "  --help                 Show this help"
  ].join("\n");
}

function parseOptions(args: readonly string[]): Options {
  let roslynRoot = process.env["ROSLYN_ROOT"]
    ?? (process.platform === "win32" ? "C:\\roslyn-3" : resolve("../roslyn"));
  let databasePath: string | undefined;
  let concurrency = 4;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    switch (argument) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--roslyn-root":
        roslynRoot = requireValue(args, ++index, argument);
        break;
      case "--database":
        databasePath = requireValue(args, ++index, argument);
        break;
      case "--concurrency":
        concurrency = positiveInteger(
          requireValue(args, ++index, argument),
          argument
        );
        break;
      default:
        throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }

  return {
    roslynRoot: resolve(roslynRoot),
    concurrency,
    ...(databasePath === undefined
      ? {}
      : { databasePath: resolve(databasePath) })
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  statSync(resolve(repositoryRoot, ".config", "dotnet-tools.json"));
  const roslynCommit = runCapture(
    "git",
    ["-C", options.roslynRoot, "rev-parse", "HEAD"],
    repositoryRoot
  );
  const artifactDirectory = resolve(
    repositoryRoot,
    "artifacts",
    "roslyn",
    roslynCommit
  );
  const databasePath = options.databasePath
    ?? resolve(artifactDirectory, "index.db");
  const logPath = resolve(artifactDirectory, "lsp-crawler.log");
  const manifestPath = resolve(artifactDirectory, "manifest.json");
  mkdirSync(artifactDirectory, { recursive: true });
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
    logPath,
    manifestPath
  ]) {
    rmSync(path, { force: true });
  }

  const log = createWriteStream(logPath, { encoding: "utf8", flags: "w" });
  const config: CrawlerConfig = {
    workspaceRoot: options.roslynRoot,
    server: {
      command: "dotnet",
      args: [
        "tool",
        "run",
        "roslyn-language-server",
        "--",
        "--stdio",
        "--autoLoadProjects",
        "--logLevel",
        "Warning",
        "--telemetryLevel",
        "off"
      ],
      cwd: repositoryRoot,
      environment: {
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
        DOTNET_NOLOGO: "1"
      },
      requestResponses: {
        "razor/updateHtml": null
      }
    },
    documents: [
      { languageId: "csharp", extensions: [".cs"] },
      { languageId: "vb", extensions: [".vb"] },
      { languageId: "razor", extensions: [".razor", ".cshtml"] }
    ],
    concurrency: options.concurrency,
    requestTimeoutMilliseconds: 300_000,
    workspaceLoadTimeoutMilliseconds: 15 * 60_000,
    settleMilliseconds: 5_000,
    lexicalFallback: false
  };

  console.log(`Indexing Roslyn commit ${roslynCommit}`);
  console.log(`Workspace: ${options.roslynRoot}`);
  console.log(`Output: ${databasePath}`);
  const startedAt = performance.now();
  let summary: CrawlSummary;
  try {
    summary = await crawlWorkspace(config, databasePath, {
      onLog: (message) => {
        log.write(`${message}\n`);
        if (/\b(?:error|exception|fail(?:ed|ure)?|warn(?:ing)?)\b/iu.test(message)) {
          console.error(message);
        }
      },
      onProgress: (progress) => {
        if (
          progress.documentsCompleted === progress.documentCount
          || progress.documentsCompleted % 100 === 0
        ) {
          console.log(
            `Crawled ${progress.documentsCompleted}/${progress.documentCount} `
            + `documents; latest: ${progress.currentDocument}`
          );
        }
      }
    });
  } finally {
    await new Promise<void>((resolveLog, reject) => {
      log.once("error", reject);
      log.end(resolveLog);
    });
  }

  const durationMilliseconds = Math.round(performance.now() - startedAt);
  const stat = statSync(databasePath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size === 0) {
    throw new Error(`The crawler did not produce a database at ${databasePath}.`);
  }
  const bytes = readFileSync(databasePath);
  const manifest: Manifest = {
    schemaVersion: 2,
    roslynCommit,
    repositoryRoot: options.roslynRoot,
    indexedWorkspace: ".",
    indexer: {
      name: "codewise-lsp-crawler",
      languageServer: "roslyn-language-server"
    },
    createdAt: new Date().toISOString(),
    generationDurationMilliseconds: durationMilliseconds,
    byteSize: stat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    statistics: summary.database
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
  console.log(
    `Indexed ${manifest.statistics.documentCount.toLocaleString()} documents `
    + `and ${manifest.statistics.occurrenceCount.toLocaleString()} occurrences.`
  );
  console.log(`Manifest: ${manifestPath}`);
}

function requireValue(
  args: readonly string[],
  index: number,
  option: string
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function runCapture(
  command: string,
  args: readonly string[],
  cwd: string
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error !== undefined) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: `
      + result.stderr.trim()
    );
  }
  return result.stdout.trim();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
