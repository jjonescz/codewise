import { describe, expect, it } from "vitest";
import {
  downloadRoslynRelease,
  GitHubReleaseHttpError
} from "./github-release.js";

const commit = "0f82fdec3c901702ec7fc3f0e9a813330a903ec9";

describe("downloadRoslynRelease", () => {
  it("downloads the public release asset without authorization", async () => {
    const logs: string[] = [];
    const authorizationHeaders: Array<string | null> = [];
    const fetcher: typeof fetch = async (input, init) => {
      authorizationHeaders.push(
        new Headers(init?.headers).get("Authorization")
      );
      const url = String(input);
      if (url.includes("/releases/tags/")) {
        return Response.json({
          assets: [
            {
              id: 42,
              name: "roslyn-scip.tar.gz",
              size: 3,
              created_at: "2026-08-29T08:00:00Z"
            }
          ]
        });
      }
      if (url.endsWith("/releases/assets/42")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          statusText: "OK"
        });
      }
      return new Response(undefined, {
        status: 404,
        statusText: "Not Found"
      });
    };

    const bytes = await downloadRoslynRelease(
      commit,
      (message) => logs.push(message),
      fetcher
    );

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(authorizationHeaders).toEqual([null, null]);
    expect(logs).toEqual([
      `Looking up public GitHub release roslyn-scip-${commit}.`,
      "Release lookup returned HTTP 200.",
      "Release lookup returned 1 asset(s).",
      "Downloading public GitHub release asset roslyn-scip.tar.gz "
        + "(id 42, created 2026-08-29T08:00:00Z).",
      "Release asset download returned HTTP 200 OK.",
      "Downloaded 3 release asset bytes."
    ]);
  });

  it("surfaces public release lookup failures without an authentication retry", async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount++;
      return new Response(undefined, {
        status: 404,
        statusText: "Not Found"
      });
    };

    await expect(downloadRoslynRelease(commit, undefined, fetcher))
      .rejects.toEqual(
        new GitHubReleaseHttpError("lookup", 404, "Not Found")
      );
    expect(requestCount).toBe(1);
  });

  it("requires exactly one expected release asset", async () => {
    const fetcher: typeof fetch = async () => Response.json({ assets: [] });

    await expect(downloadRoslynRelease(commit, undefined, fetcher))
      .rejects.toThrow(
        `Public release roslyn-scip-${commit} must contain exactly one `
        + "roslyn-scip.tar.gz asset."
      );
  });
});
