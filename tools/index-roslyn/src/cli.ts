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
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { ScipIndex } from "@codewise/scip-core";

const defaultProject = "src/Compilers/CSharp/Portable/Microsoft.CodeAnalysis.CSharp.csproj";

interface Options {
  readonly roslynRoot: string;
  readonly project: string;
}

interface Manifest {
  readonly schemaVersion: 1;
  readonly roslynCommit: string;
  readonly repositoryRoot: string;
  readonly indexedProject: string;
  readonly indexer: {
    readonly name: "scip-dotnet";
    readonly version: string;
  };
  readonly createdAt: string;
  readonly generationDurationMilliseconds: number;
  readonly byteSize: number;
  readonly sha256: string;
  readonly statistics: ReturnType<typeof getStatistics>;
  readonly validationWarnings: readonly string[];
}

function usage(): string {
  return [
    "Usage: codewise-index-roslyn [options]",
    "",
    "Options:",
    "  --roslyn-root <path>  Roslyn checkout root (default: C:\\roslyn-3 on Windows)",
    `  --project <path>      Project path, absolute or relative to the checkout`,
    "  --help                Show this help"
  ].join("\n");
}

function parseOptions(args: readonly string[]): Options {
  let roslynRoot = process.env["ROSLYN_ROOT"]
    ?? (process.platform === "win32" ? "C:\\roslyn-3" : resolve("../roslyn"));
  let project = defaultProject;

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
      case "--project":
        project = requireValue(args, ++index, argument);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }

  const resolvedRoot = resolve(roslynRoot);
  return {
    roslynRoot: resolvedRoot,
    project: isAbsolute(project) ? resolve(project) : resolve(resolvedRoot, project)
  };
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function runCapture(command: string, args: readonly string[], cwd: string): string {
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
      + `${result.stderr.trim()}`
    );
  }

  return result.stdout.trim();
}

async function runIndexer(
  args: readonly string[],
  cwd: string,
  logPath: string
): Promise<number> {
  const log = createWriteStream(logPath, { encoding: "utf8", flags: "w" });
  const child = spawn("dotnet", args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });

  await new Promise<void>((resolveEnd, reject) => {
    log.once("error", reject);
    log.end(resolveEnd);
  });

  return exitCode;
}

function getStatistics(index: ScipIndex) {
  return index.validationReport.statistics;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const toolManifest = resolve(repositoryRoot, ".config", "dotnet-tools.json");
  const roslynCommit = runCapture("git", ["-C", options.roslynRoot, "rev-parse", "HEAD"], repositoryRoot);
  const projectRelativePath = relative(options.roslynRoot, options.project).replaceAll("\\", "/");

  if (projectRelativePath.startsWith("../") || isAbsolute(projectRelativePath)) {
    throw new Error(`Project must be inside the Roslyn checkout: ${options.project}`);
  }

  const artifactDirectory = resolve(repositoryRoot, "artifacts", "roslyn", roslynCommit);
  const indexPath = resolve(artifactDirectory, "index.scip");
  const logPath = resolve(artifactDirectory, "scip-dotnet.log");
  const manifestPath = resolve(artifactDirectory, "manifest.json");
  mkdirSync(artifactDirectory, { recursive: true });

  for (const generatedPath of [indexPath, logPath, manifestPath]) {
    rmSync(generatedPath, { force: true });
  }

  const toolPrefix = [
    "tool",
    "run",
    "scip-dotnet",
    "--"
  ];
  // `dotnet tool run` discovers the pinned manifest from its working directory.
  // The indexer's own --working-directory still points MSBuild at the Roslyn checkout.
  statSync(toolManifest);
  const indexerVersion = runCapture(
    "dotnet",
    [...toolPrefix, "--version"],
    repositoryRoot
  );
  const indexArguments = [
    ...toolPrefix,
    "index",
    options.project,
    "--working-directory",
    options.roslynRoot,
    "--skip-dotnet-restore",
    "--output",
    indexPath
  ];

  console.log(`Indexing Roslyn commit ${roslynCommit}`);
  console.log(`Project: ${options.project}`);
  console.log(`Output: ${indexPath}`);

  const startedAt = performance.now();
  const exitCode = await runIndexer(indexArguments, repositoryRoot, logPath);
  const durationMilliseconds = Math.round(performance.now() - startedAt);

  if (exitCode !== 0) {
    throw new Error(`scip-dotnet failed with exit code ${exitCode}. See ${logPath}`);
  }

  const stat = statSync(indexPath, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size === 0) {
    throw new Error(`scip-dotnet did not produce a non-empty index at ${indexPath}`);
  }

  console.log(`Validating ${stat.size.toLocaleString()} bytes...`);
  const bytes = readFileSync(indexPath);
  const index = ScipIndex.fromBytes(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest: Manifest = {
    schemaVersion: 1,
    roslynCommit,
    repositoryRoot: options.roslynRoot,
    indexedProject: projectRelativePath,
    indexer: {
      name: "scip-dotnet",
      version: indexerVersion
    },
    createdAt: new Date().toISOString(),
    generationDurationMilliseconds: durationMilliseconds,
    byteSize: stat.size,
    sha256,
    statistics: getStatistics(index),
    validationWarnings: index.validationReport.warnings
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");

  console.log(`Validated ${manifest.statistics.documentCount.toLocaleString()} documents.`);
  for (const warning of manifest.validationWarnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
