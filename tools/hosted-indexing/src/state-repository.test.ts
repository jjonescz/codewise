import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { StateRepository } from "./state-repository.js";
import { emptyState } from "./state.js";

describe("StateRepository", () => {
  it("bootstraps the state branch and file", async () => {
    const mainSha = "a".repeat(40);
    const requests: Request[] = [];
    const responses = [
      new Response(undefined, { status: 404 }),
      new Response(undefined, { status: 404 }),
      Response.json({ object: { sha: mainSha } }),
      Response.json({}, { status: 201 }),
      Response.json({}, { status: 201 })
    ];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    };
    const repository = new StateRepository(
      "token",
      "jjonescz/codewise",
      "state",
      "index-state.json",
      "https://api.github.test",
      fetcher
    );

    await repository.update("Initialize", (state) => ({
      state: {
        ...state,
        updatedAt: "2026-08-31T00:00:00.000Z"
      },
      result: undefined
    }));

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "PUT"
    ]);
    expect(await requests[3]!.json()).toEqual({
      ref: "refs/heads/state",
      sha: mainSha
    });
    const update = await requests[4]!.json() as {
      readonly branch: string;
      readonly sha?: string;
      readonly content: string;
    };
    expect(update.branch).toBe("state");
    expect(update.sha).toBeUndefined();
    expect(Buffer.from(update.content, "base64").toString("utf8"))
      .toContain('"schemaVersion": 1');
  });

  it("confirms an ambiguous transient write before returning its result", async () => {
    const initial = emptyState(new Date("2026-09-01T12:00:00.000Z"));
    const reserved = {
      ...initial,
      updatedAt: "2026-09-01T12:01:00.000Z"
    };
    const requests: Request[] = [];
    const responses = [
      contentsResponse(initial, "state-sha-1"),
      new Response("Server Error", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "retry-after": "0" }
      }),
      contentsResponse(reserved, "state-sha-2")
    ];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    };
    const repository = new StateRepository(
      "token",
      "jjonescz/codewise",
      "state",
      "index-state.json",
      "https://api.github.test",
      fetcher
    );

    const result = await repository.update("Reserve", () => ({
      state: reserved,
      result: ["reserved-work"]
    }));

    expect(result).toEqual(["reserved-work"]);
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "PUT",
      "GET"
    ]);
  });
});

function contentsResponse(state: unknown, sha: string): Response {
  return Response.json({
    content: Buffer.from(`${JSON.stringify(state)}\n`, "utf8").toString("base64"),
    encoding: "base64",
    sha
  });
}
