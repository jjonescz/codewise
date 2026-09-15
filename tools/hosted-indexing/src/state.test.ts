import { describe, expect, it } from "vitest";
import type { RoslynCandidate } from "./github.js";
import {
  completeCandidate,
  emptyState,
  reserveCandidates,
  type IndexState
} from "./state.js";

const now = new Date("2026-08-27T12:00:00.000Z");
const main = candidate("1", "main");
const pull = candidate("2", "pull-request", 10);

describe("hosted indexing state", () => {
  it.each([1, 2, 4])("reserves at most %i candidates, starting with main", (maxIndexes) => {
    const candidates = [
      main,
      pull,
      candidate("3", "pull-request", 11),
      candidate("4", "pull-request", 12),
      candidate("5", "pull-request", 13)
    ];
    const result = reserveCandidates(candidates, emptyState(now), {
      maxIndexes,
      maxAttempts: 3,
      retryAfterMilliseconds: 12 * 60 * 60 * 1000
    }, now);
    expect(result.selected).toEqual(
      candidates.slice(0, maxIndexes).map((candidate) => ({ ...candidate, attempt: 1 }))
    );
    expect(Object.keys(result.state.entries)).toEqual(
      result.selected.map((candidate) => candidate.sha)
    );
    expect(result.summary.eligible).toBe(candidates.length);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid job limit of %s",
    (maxIndexes) => {
      expect(() => reserveCandidates([main, pull], emptyState(now), {
        maxIndexes,
        maxAttempts: 3,
        retryAfterMilliseconds: 12 * 60 * 60 * 1000
      }, now)).toThrow("maxIndexes must be a positive integer.");
    }
  );

  it("skips retained successes and reserves eligible candidates", () => {
    const state: IndexState = {
      schemaVersion: 1,
      updatedAt: now.toISOString(),
      entries: {
        [main.sha]: {
          candidate: main,
          status: "success",
          attempts: 1,
          lastAttemptAt: now.toISOString(),
          lastConclusion: "success",
          artifactExpiresAt: new Date(
            now.getTime() + 60 * 60 * 1000
          ).toISOString()
        }
      }
    };
    const result = reserveCandidates([main, pull], state, {
      maxIndexes: 4,
      maxAttempts: 3,
      retryAfterMilliseconds: 12 * 60 * 60 * 1000
    }, now);
    expect(result.selected).toEqual([{ ...pull, attempt: 1 }]);
    expect(result.summary.complete).toBe(1);
  });

  it("reserves only the next eligible PR when main is already indexed and the limit is one", () => {
    const state = completeCandidate(emptyState(now), main, {
      attempt: 1,
      conclusion: "success",
      artifactRetentionMilliseconds: 90 * 24 * 60 * 60 * 1000
    }, now);
    const result = reserveCandidates([
      main,
      pull,
      candidate("3", "pull-request", 11)
    ], state, {
      maxIndexes: 1,
      maxAttempts: 3,
      retryAfterMilliseconds: 12 * 60 * 60 * 1000
    }, now);
    expect(result.selected).toEqual([{ ...pull, attempt: 1 }]);
    expect(Object.keys(result.state.entries)).toEqual([main.sha, pull.sha]);
    expect(result.state.entries[main.sha]).toEqual(state.entries[main.sha]);
    expect(result.summary.complete).toBe(1);
    expect(result.summary.eligible).toBe(2);
  });

  it("prioritizes the reset SHA within the job limit", () => {
    const state = completeCandidate(emptyState(now), pull, {
      attempt: 1,
      conclusion: "success",
      artifactRetentionMilliseconds: 90 * 24 * 60 * 60 * 1000
    }, now);
    const result = reserveCandidates([main, pull], state, {
      maxIndexes: 1,
      maxAttempts: 3,
      retryAfterMilliseconds: 12 * 60 * 60 * 1000,
      resetSha: pull.sha
    }, now);
    expect(result.selected).toEqual([{ ...pull, attempt: 2 }]);
    expect(Object.keys(result.state.entries)).toEqual([pull.sha]);
  });

  it("does not let a stale failure overwrite a newer success", () => {
    const success = completeCandidate(emptyState(now), main, {
      attempt: 2,
      conclusion: "success",
      artifactRetentionMilliseconds: 90 * 24 * 60 * 60 * 1000
    }, now);
    expect(completeCandidate(success, main, {
      attempt: 1,
      conclusion: "failure",
      artifactRetentionMilliseconds: 90 * 24 * 60 * 60 * 1000
    }, new Date(now.getTime() + 1_000))).toBe(success);
  });
});

function candidate(
  digit: string,
  sourceKind: RoslynCandidate["sourceKind"],
  pullRequestNumber?: number
): RoslynCandidate {
  const sha = digit.repeat(40);
  return sourceKind === "main"
    ? {
        sha,
        sourceKind,
        sourceRef: "refs/heads/main",
        sourceLabel: "main"
      }
    : {
        sha,
        sourceKind,
        sourceRef: `refs/pull/${pullRequestNumber}/head`,
        sourceLabel: `PR #${pullRequestNumber}`,
        pullRequestNumber: pullRequestNumber!
      };
}
