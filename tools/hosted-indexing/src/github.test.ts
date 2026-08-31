import { describe, expect, it } from "vitest";
import { RoslynClient, WorkflowClient } from "./github.js";

const mainSha = "1".repeat(40);
const pullSha = "2".repeat(40);

describe("hosted GitHub clients", () => {
  it("prioritizes main and deduplicates Roslyn SHAs", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/main")) {
        return Response.json({ object: { sha: mainSha } });
      }
      return Response.json([
        { number: 10, head: { sha: pullSha } },
        { number: 11, head: { sha: mainSha } }
      ]);
    };
    await expect(new RoslynClient(
      "https://api.github.test",
      "dotnet/roslyn",
      fetcher
    ).listCandidates()).resolves.toEqual([
      {
        sha: mainSha,
        sourceKind: "main",
        sourceRef: "refs/heads/main",
        sourceLabel: "main"
      },
      {
        sha: pullSha,
        sourceKind: "pull-request",
        sourceRef: "refs/pull/10/head",
        sourceLabel: "PR #10",
        pullRequestNumber: 10
      }
    ]);
  });

  it("dispatches the exact reserved candidate", async () => {
    let body: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(undefined, { status: 204 });
    };
    await new WorkflowClient(
      "token",
      "jjonescz/codewise",
      "index-roslyn.yml",
      "main",
      "https://api.github.test",
      fetcher
    ).dispatch({
      sha: pullSha,
      sourceKind: "pull-request",
      sourceRef: "refs/pull/42/head",
      sourceLabel: "PR #42",
      pullRequestNumber: 42,
      attempt: 2
    });
    expect(body).toEqual({
      ref: "main",
      inputs: {
        roslyn_sha: pullSha,
        roslyn_ref: "refs/pull/42/head",
        source_kind: "pull-request",
        source_label: "PR #42",
        pull_request_number: "42",
        attempt: "2"
      }
    });
  });
});
