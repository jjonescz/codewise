import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { StateRepository } from "./state-repository.js";

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
});
