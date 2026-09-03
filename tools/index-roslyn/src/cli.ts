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
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  crawlWorkspace,
  type CrawlerConfig,
  type CrawlSummary
} from "@codewise/lsp-crawler";
import { resolveIndexOutputPaths } from "./output-paths.js";
import {
  assertRequiredSdkInstalled,
  parseInstalledSdkVersions,
  readRequiredSdkVersion
} from "./sdk-preflight.js";

interface Options {
  readonly workspaceRoot: string;
  readonly databasePath?: string;
  readonly concurrency: number;
}

interface Manifest {
  readonly schemaVersion: 3;
  readonly repositoryCommit: string;
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
  readonly timings: CrawlSummary["timings"];
}

function usage(): string {
  return [
    "Usage: codewise-index-roslyn [options]",
    "",
    "Options:",
    "  --workspace-root <path> Workspace root (or set WORKSPACE_ROOT)",
    "  --database <path>       Output database path",
    "  --concurrency <number>  Concurrent document crawls (default: 4)",
    "  --help                  Show this help"
  ].join("\n");
}

function parseOptions(args: readonly string[]): Options {
  let workspaceRoot = process.env["WORKSPACE_ROOT"];
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
      case "--workspace-root":
        workspaceRoot = requireValue(args, ++index, argument);
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

  if (workspaceRoot === undefined || workspaceRoot.trim() === "") {
    throw new Error(
      `--workspace-root is required unless WORKSPACE_ROOT is set.\n\n${usage()}`
    );
  }
  return {
    workspaceRoot: resolve(workspaceRoot),
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
  const workspaceCommit = runCapture(
    "git",
    ["-C", options.workspaceRoot, "rev-parse", "HEAD"],
    repositoryRoot
  );
  const globalJsonPath = resolve(options.workspaceRoot, "global.json");
  const requiredSdkVersion = readRequiredSdkVersion(globalJsonPath);
  const installedSdkVersions = parseInstalledSdkVersions(
    runCapture("dotnet", ["--list-sdks"], options.workspaceRoot)
  );
  assertRequiredSdkInstalled(
    requiredSdkVersion,
    installedSdkVersions,
    globalJsonPath
  );
  const { databasePath, logPath, manifestPath } = resolveIndexOutputPaths(
    options.workspaceRoot,
    options.databasePath
  );
  mkdirSync(dirname(databasePath), { recursive: true });
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
  const mirrorServerLogs = isCiEnvironment();
  const config: CrawlerConfig = {
    workspaceRoot: options.workspaceRoot,
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

  console.log(`Indexing commit ${workspaceCommit}`);
  console.log(`Required .NET SDK: ${requiredSdkVersion}`);
  console.log(`Workspace: ${options.workspaceRoot}`);
  console.log(`Output: ${databasePath}`);
  console.log(
    `Log: ${logPath}${mirrorServerLogs ? " (mirrored to stderr in CI)" : ""}`
  );
  const startedAt = performance.now();
  let summary: CrawlSummary;
  try {
    summary = await crawlWorkspace(config, databasePath, {
      onLog: (message) => {
        const line = `${message}\n`;
        log.write(line);
        if (mirrorServerLogs) {
          process.stderr.write(line);
        }
      },
      onProgress: (progress) => {
        if (
          progress.documentsCompleted === progress.documentCount
          || progress.documentsCompleted % 100 === 0
        ) {
          const rate = progress.documentsPerSecond.toFixed(
            progress.documentsPerSecond >= 10 ? 1 : 2
          );
          const estimate = progress.documentsCompleted === progress.documentCount
            ? ""
            : `, ETA ${formatDuration(progress.estimatedRemainingMilliseconds)}`;
          console.log(
            `Crawled ${progress.documentsCompleted}/${progress.documentCount} `
            + `documents in ${formatDuration(progress.elapsedMilliseconds)} `
            + `(${rate} docs/s${estimate}); latest: ${progress.currentDocument}`
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
    schemaVersion: 3,
    repositoryCommit: workspaceCommit,
    repositoryRoot: options.workspaceRoot,
    indexedWorkspace: ".",
    indexer: {
      name: "codewise-lsp-crawler",
      languageServer: "roslyn-language-server"
    },
    createdAt: new Date().toISOString(),
    generationDurationMilliseconds: durationMilliseconds,
    byteSize: stat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    statistics: summary.database,
    timings: summary.timings
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
  console.log(
    `Indexed ${manifest.statistics.documentCount.toLocaleString()} documents `
    + `and ${manifest.statistics.occurrenceCount.toLocaleString()} occurrences.`
  );
  console.log("Timings:");
  console.log(
    `  Document discovery: ${formatDuration(summary.timings.documentDiscoveryMilliseconds)}`
  );
  console.log(
    `  Server initialization: ${formatDuration(summary.timings.serverInitializationMilliseconds)}`
  );
  console.log(
    `  Index preparation: ${formatDuration(summary.timings.indexPreparationMilliseconds)}`
  );
  console.log(
    `  Workspace load wait: ${formatDuration(summary.timings.workspaceLoadWaitMilliseconds)}`
  );
  console.log(
    `  Document crawl: ${formatDuration(summary.timings.documentCrawlMilliseconds)}`
  );
  console.log(`  Total crawl: ${formatDuration(summary.timings.totalMilliseconds)}`);
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

function isCiEnvironment(): boolean {
  return process.env["GITHUB_ACTIONS"] === "true"
    || process.env["CI"]?.toLowerCase() === "true";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${Math.round(milliseconds)}ms`;
  }
  const totalSeconds = Math.round(milliseconds / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
