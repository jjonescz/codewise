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
