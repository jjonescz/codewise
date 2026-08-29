import { describe, expect, it } from "vitest";
import { downloadRoslynArtifact } from "./github-artifact.js";

const commit = "0f82fdec3c901702ec7fc3f0e9a813330a903ec9";

describe("downloadRoslynArtifact", () => {
  it("logs artifact request phases without logging the access token", async () => {
    const logs: string[] = [];
    const accessToken = "secret-access-token";
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/actions/artifacts?")) {
        return Response.json({
          artifacts: [
            {
              id: 42,
              name: `roslyn-scip-${commit}`,
              expired: false,
              created_at: "2026-08-29T08:00:00Z"
            }
          ]
        });
      }
      if (url.endsWith("/actions/artifacts/42/zip")) {
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

    const bytes = await downloadRoslynArtifact(
      commit,
      accessToken,
      (message) => logs.push(message),
      fetcher
    );

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(logs).toEqual([
      `Looking up GitHub Actions artifact roslyn-scip-${commit}.`,
      "Artifact lookup returned HTTP 200.",
      "Artifact lookup returned 1 result(s), 1 retained candidate(s).",
      "Downloading GitHub Actions artifact 42 (created 2026-08-29T08:00:00Z).",
      "Artifact download returned HTTP 200 OK.",
      "Downloaded 3 artifact bytes."
    ]);
    expect(logs.join("\n")).not.toContain(accessToken);
  });
});
