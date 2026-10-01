import { describe, expect, it, vi } from "vitest";
import {
  downloadRoslynArtifact,
  findLatestRoslynArtifact,
  GitHubArtifactHttpError,
  type RoslynArtifact
} from "./github-artifact.js";

const commit = "0f82fdec3c901702ec7fc3f0e9a813330a903ec9";

describe("downloadRoslynArtifact", () => {
  it("authenticates artifact requests without logging the access token", async () => {
    const logs: string[] = [];
    const accessToken = "secret-access-token";
    const authorizationHeaders: Array<string | null> = [];
    const fetcher: typeof fetch = async (input, init) => {
      authorizationHeaders.push(
        new Headers(init?.headers).get("Authorization")
      );
      const url = String(input);
      if (url.includes("/actions/artifacts?")) {
        return Response.json({
          artifacts: [
            {
              id: 42,
              name: `roslyn-codewise-${commit}`,
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
    expect(authorizationHeaders).toEqual([
      `Bearer ${accessToken}`,
      `Bearer ${accessToken}`
    ]);
    expect(logs).toEqual([
      `Looking up GitHub Actions artifact roslyn-codewise-${commit}.`,
      "Artifact lookup returned HTTP 200.",
      "Artifact lookup returned 1 result(s), 1 retained candidate(s).",
      "Downloading GitHub Actions artifact 42 (created 2026-08-29T08:00:00Z).",
      "Artifact download returned HTTP 200 OK.",
      "Downloaded 3 artifact bytes."
    ]);
    expect(logs.join("\n")).not.toContain(accessToken);
  });

  it("surfaces artifact lookup failures without retrying anonymously", async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount++;
      return new Response(undefined, {
        status: 403,
        statusText: "Forbidden"
      });
    };

    await expect(downloadRoslynArtifact(commit, "token", undefined, fetcher))
      .rejects.toEqual(
        new GitHubArtifactHttpError("lookup", 403, "Forbidden")
      );
    expect(requestCount).toBe(1);
  });
});

describe("findLatestRoslynArtifact", () => {
  const older = "1111111111111111111111111111111111111111";
  const closer = "2222222222222222222222222222222222222222";
  const unrelated = "3333333333333333333333333333333333333333";

  it("selects the closest indexed ancestor rather than the newest artifact", async () => {
    const artifacts = [
      artifact(1, unrelated, "2026-10-01T12:00:00Z"),
      artifact(2, older, "2026-10-01T11:00:00Z"),
      artifact(3, closer, "2026-09-30T11:00:00Z")
    ];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/actions/artifacts?")) {
        return Response.json({ artifacts });
      }
      if (url.includes(`${unrelated}...`)) {
        return Response.json({ status: "diverged", ahead_by: 8 });
      }
      return Response.json({
        status: "ahead",
        ahead_by: url.includes(`${closer}...`) ? 2 : 10
      });
    });

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .resolves.toEqual({ commit: closer, artifact: artifacts[2] });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/dotnet/roslyn/compare/${closer}...${commit}?per_page=1`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" })
      })
    );
  });

  it("paginates artifacts and skips expired, malformed, and duplicate candidates", async () => {
    const firstPage = Array.from({ length: 97 }, (_, index) => ({
      ...artifact(index, unrelated),
      expired: true
    }));
    firstPage.push(
      { ...artifact(98, unrelated), name: "another-workflow-artifact" },
      artifact(99, closer, "2026-09-30T00:00:00Z"),
      artifact(100, closer, "2026-10-01T00:00:00Z")
    );
    const retained = artifact(101, older);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/actions/artifacts?")) {
        return Response.json({
          artifacts: url.includes("page=2") ? [retained] : firstPage
        });
      }
      return Response.json({
        status: "ahead",
        ahead_by: url.includes(`${older}...`) ? 1 : 2
      });
    });

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .resolves.toEqual({ commit: older, artifact: retained });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["behind", "diverged"])("does not use a %s commit", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => Response.json(
      String(input).includes("/actions/artifacts?")
        ? { artifacts: [artifact(1, unrelated)] }
        : { status, ahead_by: 3 }
    ));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .resolves.toBeUndefined();
  });

  it("returns undefined when no retained index exists", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ artifacts: [] }));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses an exact index published while fallback discovery was running", async () => {
    const exact = artifact(1, commit);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ artifacts: [exact] }));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .resolves.toEqual({ commit, artifact: exact });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("surfaces artifact-list failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(undefined, {
      status: 403,
      statusText: "Forbidden"
    }));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .rejects.toEqual(new GitHubArtifactHttpError("lookup", 403, "Forbidden"));
  });

  it("surfaces history lookup failures", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => (
      String(input).includes("/actions/artifacts?")
        ? Response.json({ artifacts: [artifact(1, older)] })
        : new Response(undefined, { status: 403, statusText: "Forbidden" })
    ));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .rejects.toThrow("GitHub Roslyn history lookup failed with HTTP 403 Forbidden.");
  });

  it.each([
    { status: "ahead", ahead_by: -1 },
    { status: "ahead", ahead_by: 1.5 },
    { status: "ahead" },
    { status: "unknown", ahead_by: 1 }
  ])("rejects invalid comparison responses: %j", async (comparison) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => Response.json(
      String(input).includes("/actions/artifacts?")
        ? { artifacts: [artifact(1, older)] }
        : comparison
    ));

    await expect(findLatestRoslynArtifact(commit, "token", undefined, fetcher))
      .rejects.toThrow("GitHub returned an invalid commit-comparison response.");
  });
});

function artifact(
  id: number,
  indexedCommit: string,
  createdAt = "2026-10-01T00:00:00Z"
): RoslynArtifact {
  return {
    id,
    name: `roslyn-codewise-${indexedCommit}`,
    expired: false,
    created_at: createdAt
  };
}
