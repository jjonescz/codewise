import {
  validateSha,
  type ReservedCandidate,
  type RoslynCandidate
} from "./github.js";

export type WorkflowConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped";

export interface IndexStateEntry {
  readonly candidate: RoslynCandidate;
  readonly status: "queued" | "success" | "failed";
  readonly attempts: number;
  readonly lastAttemptAt: string;
  readonly lastConclusion: "queued" | WorkflowConclusion;
  readonly artifactExpiresAt?: string;
}

export interface IndexState {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly entries: Readonly<Record<string, IndexStateEntry>>;
}

export interface ReserveOptions {
  readonly maxIndexes: number;
  readonly maxAttempts: number;
  readonly retryAfterMilliseconds: number;
  readonly resetSha?: string;
}

export interface ReserveResult {
  readonly state: IndexState;
  readonly selected: readonly ReservedCandidate[];
  readonly summary: {
    readonly complete: number;
    readonly waiting: number;
    readonly exhausted: number;
    readonly eligible: number;
  };
}

export function emptyState(now = new Date()): IndexState {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    entries: {}
  };
}

export function reserveCandidates(
  candidates: readonly RoslynCandidate[],
  state: IndexState,
  options: ReserveOptions,
  now = new Date()
): ReserveResult {
  positiveInteger(options.maxIndexes, "maxIndexes");
  positiveInteger(options.maxAttempts, "maxAttempts");
  positiveNumber(options.retryAfterMilliseconds, "retryAfterMilliseconds");
  const uniqueShas = new Set(candidates.map((candidate) => candidate.sha));
  if (uniqueShas.size !== candidates.length) {
    throw new Error("Candidate commit SHAs must be unique.");
  }
  const resetSha = options.resetSha?.trim();
  if (resetSha !== undefined && resetSha !== "" && !uniqueShas.has(resetSha)) {
    throw new Error(`Cannot reset ${resetSha} because it is not active.`);
  }
  const normalizedReset = resetSha === "" ? undefined : resetSha;
  const ordered = normalizedReset === undefined
    ? candidates
    : [
        candidates.find((candidate) => candidate.sha === normalizedReset)!,
        ...candidates.filter((candidate) => candidate.sha !== normalizedReset)
      ];
  const entries: Record<string, IndexStateEntry> = {};
  const selected: ReservedCandidate[] = [];
  let changed = Object.keys(state.entries).some((sha) => !uniqueShas.has(sha));
  let complete = 0;
  let waiting = 0;
  let exhausted = 0;
  let eligible = 0;

  for (const candidate of ordered) {
    const saved = state.entries[candidate.sha];
    const existing = candidate.sha === normalizedReset ? undefined : saved;
    if (existing !== undefined) {
      entries[candidate.sha] = { ...existing, candidate };
      changed ||= !sameCandidate(existing.candidate, candidate);
    } else if (saved !== undefined) {
      changed = true;
    }
    if (existing?.status === "success") {
      if (requiredDate(existing.artifactExpiresAt).getTime() > now.getTime()) {
        complete++;
        continue;
      }
    } else if (existing !== undefined) {
      if (existing.attempts >= options.maxAttempts) {
        exhausted++;
        continue;
      }
      if (
        requiredDate(existing.lastAttemptAt).getTime()
          + options.retryAfterMilliseconds
        > now.getTime()
      ) {
        waiting++;
        continue;
      }
    }
    eligible++;
    if (selected.length >= options.maxIndexes) {
      continue;
    }
    const attempt = candidate.sha === normalizedReset && saved !== undefined
      ? saved.attempts + 1
      : existing?.status === "success"
        ? 1
        : (existing?.attempts ?? 0) + 1;
    selected.push({ ...candidate, attempt });
    entries[candidate.sha] = {
      candidate,
      status: "queued",
      attempts: attempt,
      lastAttemptAt: now.toISOString(),
      lastConclusion: "queued"
    };
    changed = true;
  }
  return {
    state: changed
      ? {
          schemaVersion: 1,
          updatedAt: now.toISOString(),
          entries
        }
      : state,
    selected,
    summary: { complete, waiting, exhausted, eligible }
  };
}

function sameCandidate(
  left: RoslynCandidate,
  right: RoslynCandidate
): boolean {
  return left.sha === right.sha
    && left.sourceKind === right.sourceKind
    && left.sourceRef === right.sourceRef
    && left.sourceLabel === right.sourceLabel
    && left.pullRequestNumber === right.pullRequestNumber;
}

export function completeCandidate(
  state: IndexState,
  candidate: RoslynCandidate,
  options: {
    readonly attempt: number;
    readonly conclusion: WorkflowConclusion;
    readonly artifactRetentionMilliseconds: number;
  },
  now = new Date()
): IndexState {
  const existing = state.entries[candidate.sha];
  if (existing !== undefined && options.attempt < existing.attempts) {
    return state;
  }
  if (
    existing?.status === "success"
    && options.attempt === existing.attempts
    && options.conclusion !== "success"
  ) {
    return state;
  }
  const common = {
    candidate,
    attempts: Math.max(existing?.attempts ?? 0, options.attempt),
    lastAttemptAt: now.toISOString(),
    lastConclusion: options.conclusion
  };
  const entry: IndexStateEntry = options.conclusion === "success"
    ? {
        ...common,
        status: "success",
        artifactExpiresAt: new Date(
          now.getTime() + options.artifactRetentionMilliseconds
        ).toISOString()
      }
    : { ...common, status: "failed" };
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    entries: { ...state.entries, [candidate.sha]: entry }
  };
}

export function parseState(content: string): IndexState {
  const value: unknown = JSON.parse(content);
  if (!isObject(value) || value["schemaVersion"] !== 1) {
    throw new Error("Index state has an unsupported schema version.");
  }
  const rawEntries = value["entries"];
  if (!isObject(rawEntries) || typeof value["updatedAt"] !== "string") {
    throw new Error("Index state is malformed.");
  }
  requiredDate(value["updatedAt"]);
  const entries: Record<string, IndexStateEntry> = {};
  for (const [sha, rawEntry] of Object.entries(rawEntries)) {
    validateSha(sha);
    if (!isObject(rawEntry) || !isObject(rawEntry["candidate"])) {
      throw new Error(`State entry ${sha} is malformed.`);
    }
    const candidate = parseCandidate(rawEntry["candidate"]);
    const status = enumValue(
      rawEntry["status"],
      ["queued", "success", "failed"] as const
    );
    const attempts = positiveInteger(rawEntry["attempts"], "attempts");
    const lastAttemptAt = requiredDateString(rawEntry["lastAttemptAt"]);
    const lastConclusion = enumValue(
      rawEntry["lastConclusion"],
      ["queued", "success", "failure", "cancelled", "skipped"] as const
    );
    entries[sha] = status === "success"
      ? {
          candidate,
          status,
          attempts,
          lastAttemptAt,
          lastConclusion,
          artifactExpiresAt: rawEntry["artifactExpiresAt"] === undefined
            ? lastAttemptAt
            : requiredDateString(rawEntry["artifactExpiresAt"])
        }
      : { candidate, status, attempts, lastAttemptAt, lastConclusion };
  }
  return {
    schemaVersion: 1,
    updatedAt: value["updatedAt"],
    entries
  };
}

export function candidateFromValues(values: {
  readonly sha: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly pullRequestNumber?: number;
}): RoslynCandidate {
  return parseCandidate(values);
}

function parseCandidate(value: unknown): RoslynCandidate {
  if (!isObject(value)) {
    throw new Error("Candidate is malformed.");
  }
  const sha = validateSha(requiredString(value["sha"]));
  const sourceKind = enumValue(
    value["sourceKind"],
    ["main", "pull-request"] as const
  );
  const sourceRef = requiredString(value["sourceRef"]);
  const sourceLabel = requiredString(value["sourceLabel"]);
  if (sourceKind === "main") {
    if (sourceRef !== "refs/heads/main" || value["pullRequestNumber"] !== undefined) {
      throw new Error("Main candidate is malformed.");
    }
    return { sha, sourceKind, sourceRef, sourceLabel };
  }
  const pullRequestNumber = positiveInteger(
    value["pullRequestNumber"],
    "pullRequestNumber"
  );
  if (sourceRef !== `refs/pull/${pullRequestNumber}/head`) {
    throw new Error("Pull request candidate is malformed.");
  }
  return {
    sha,
    sourceKind,
    sourceRef,
    sourceLabel,
    pullRequestNumber
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty string.");
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive.`);
  }
  return value;
}

function requiredDateString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected an ISO date.");
  }
  requiredDate(value);
  return value;
}

function requiredDate(value: unknown): Date {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Expected an ISO date.");
  }
  return new Date(value);
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Expected one of ${allowed.join(", ")}.`);
  }
  return value as T;
}
