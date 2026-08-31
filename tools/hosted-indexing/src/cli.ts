#!/usr/bin/env node

import {
  RoslynClient,
  WorkflowClient,
  type CandidateSourceKind
} from "./github.js";
import { StateRepository } from "./state-repository.js";
import {
  candidateFromValues,
  completeCandidate,
  reserveCandidates,
  type WorkflowConclusion
} from "./state.js";

interface ScanOptions {
  readonly command: "scan";
  readonly resetSha?: string;
}

interface CompleteOptions {
  readonly command: "complete";
  readonly sha: string;
  readonly sourceKind: CandidateSourceKind;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly pullRequestNumber?: number;
  readonly attempt: number;
  readonly conclusion: WorkflowConclusion;
}

type Options = ScanOptions | CompleteOptions;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const token = requireSetting("GITHUB_TOKEN");
  const repository = requireSetting("GITHUB_REPOSITORY");
  const stateRepository = new StateRepository(
    token,
    repository,
    process.env["STATE_BRANCH"]?.trim() || "state"
  );
  if (options.command === "scan") {
    await scan(options, token, repository, stateRepository);
  } else {
    await complete(options, stateRepository);
  }
}

async function scan(
  options: ScanOptions,
  token: string,
  repository: string,
  stateRepository: StateRepository
): Promise<void> {
  const candidates = await new RoslynClient().listCandidates();
  const reservation = await stateRepository.update(
    "Reserve Roslyn Codewise indexing work",
    (state) => {
      const result = reserveCandidates(candidates, state, {
        maxIndexes: positiveIntegerSetting("MAX_INDEXES_PER_RUN", 4),
        maxAttempts: positiveIntegerSetting("MAX_ATTEMPTS", 3),
        retryAfterMilliseconds:
          positiveNumberSetting("RETRY_AFTER_HOURS", 12) * 60 * 60 * 1000,
        ...(options.resetSha === undefined ? {} : { resetSha: options.resetSha })
      });
      return { state: result.state, result };
    }
  );

  const workflow = new WorkflowClient(token, repository);
  const failures: unknown[] = [];
  for (const candidate of reservation.selected) {
    try {
      await workflow.dispatch(candidate);
      console.log(
        `Dispatched ${candidate.sourceLabel} at ${candidate.sha}, `
        + `attempt ${candidate.attempt}.`
      );
    } catch (error) {
      failures.push(error);
      console.error(
        `Failed to dispatch ${candidate.sourceLabel} at ${candidate.sha}.`,
        error
      );
    }
  }
  console.log(
    `Roslyn scan: ${candidates.length} active; `
    + `${reservation.summary.complete} complete, `
    + `${reservation.summary.waiting} waiting, `
    + `${reservation.summary.exhausted} exhausted, `
    + `${reservation.summary.eligible} eligible; `
    + `${reservation.selected.length} reserved.`
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} dispatch(es) failed.`);
  }
}

async function complete(
  options: CompleteOptions,
  stateRepository: StateRepository
): Promise<void> {
  const candidate = candidateFromValues({
    sha: options.sha,
    sourceKind: options.sourceKind,
    sourceRef: options.sourceRef,
    sourceLabel: options.sourceLabel,
    ...(options.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: options.pullRequestNumber })
  });
  await stateRepository.update(
    `Record Roslyn Codewise result for ${candidate.sha}`,
    (state) => ({
      state: completeCandidate(state, candidate, {
        attempt: options.attempt,
        conclusion: options.conclusion,
        artifactRetentionMilliseconds:
          positiveIntegerSetting("RESULT_RETENTION_DAYS", 90)
          * 24 * 60 * 60 * 1000
      }),
      result: undefined
    })
  );
  console.log(
    `Recorded ${options.conclusion} for ${candidate.sourceLabel} at `
    + `${candidate.sha}, attempt ${options.attempt}.`
  );
}

function parseOptions(args: readonly string[]): Options {
  const command = args[0];
  if (command !== "scan" && command !== "complete") {
    throw new Error(usage());
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !option.startsWith("--") || value === undefined) {
      throw new Error(usage());
    }
    values.set(option, value);
  }
  if (command === "scan") {
    const resetSha = values.get("--reset-sha")?.trim();
    return resetSha === undefined || resetSha === ""
      ? { command }
      : { command, resetSha };
  }

  const pullRequestNumber = values.get("--pull-request-number")?.trim();
  return {
    command,
    sha: requiredOption(values, "--sha"),
    sourceKind: enumValue(
      requiredOption(values, "--source-kind"),
      ["main", "pull-request"] as const,
      "--source-kind"
    ),
    sourceRef: requiredOption(values, "--source-ref"),
    sourceLabel: requiredOption(values, "--source-label"),
    attempt: positiveInteger(requiredOption(values, "--attempt"), "--attempt"),
    conclusion: enumValue(
      requiredOption(values, "--conclusion"),
      ["success", "failure", "cancelled", "skipped"] as const,
      "--conclusion"
    ),
    ...(pullRequestNumber === undefined || pullRequestNumber === ""
      ? {}
      : {
          pullRequestNumber: positiveInteger(
            pullRequestNumber,
            "--pull-request-number"
          )
        })
  };
}

function requireSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Missing required setting ${name}.`);
  }
  return value;
}

function requiredOption(
  values: ReadonlyMap<string, string>,
  name: string
): string {
  const value = values.get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.\n\n${usage()}`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function positiveIntegerSetting(name: string, defaultValue: number): number {
  const value = positiveNumberSetting(name, defaultValue);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function positiveNumberSetting(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive.`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: string,
  allowed: readonly T[],
  name: string
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function usage(): string {
  return [
    "Usage:",
    "  codewise-hosted-indexing scan [--reset-sha <sha>]",
    "  codewise-hosted-indexing complete --sha <sha> --source-kind <kind>",
    "    --source-ref <ref> --source-label <label> --attempt <number>",
    "    --conclusion <conclusion> [--pull-request-number <number>]"
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
