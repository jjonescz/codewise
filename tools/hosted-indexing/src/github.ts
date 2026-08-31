export type CandidateSourceKind = "main" | "pull-request";

export interface RoslynCandidate {
  readonly sha: string;
  readonly sourceKind: CandidateSourceKind;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly pullRequestNumber?: number;
}

export interface ReservedCandidate extends RoslynCandidate {
  readonly attempt: number;
}

interface GitReferenceResponse {
  readonly object: { readonly sha: string };
}

interface PullRequestResponse {
  readonly number: number;
  readonly head: { readonly sha: string };
}

export class RoslynClient {
  public constructor(
    private readonly apiBaseUrl = "https://api.github.com",
    private readonly roslynRepository = "dotnet/roslyn",
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async listCandidates(): Promise<readonly RoslynCandidate[]> {
    const mainReference = await this.request<GitReferenceResponse>(
      `/repos/${this.roslynRepository}/git/ref/heads/main`
    );
    const candidates: RoslynCandidate[] = [{
      sha: validateSha(mainReference.object.sha),
      sourceKind: "main",
      sourceRef: "refs/heads/main",
      sourceLabel: "main"
    }];
    for (let page = 1; ; page++) {
      const pulls = await this.request<readonly PullRequestResponse[]>(
        `/repos/${this.roslynRepository}/pulls`
        + `?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
      );
      for (const pull of pulls) {
        candidates.push({
          sha: validateSha(pull.head.sha),
          sourceKind: "pull-request",
          sourceRef: `refs/pull/${pull.number}/head`,
          sourceLabel: `PR #${pull.number}`,
          pullRequestNumber: pull.number
        });
      }
      if (pulls.length < 100) {
        break;
      }
    }
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.sha)) {
        return false;
      }
      seen.add(candidate.sha);
      return true;
    });
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codewise-hosted-indexing",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API GET ${path} failed with ${response.status} `
        + `${response.statusText}: ${await readErrorMessage(response)}. `
        + `Rate limit remaining: `
        + `${response.headers.get("x-ratelimit-remaining") ?? "unknown"}; reset: `
        + `${response.headers.get("x-ratelimit-reset") ?? "unknown"}.`
      );
    }
    return await response.json() as T;
  }
}

export class WorkflowClient {
  public constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly workflow = "index-roslyn.yml",
    private readonly workflowRef = "main",
    private readonly apiBaseUrl = "https://api.github.com",
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async dispatch(candidate: ReservedCandidate): Promise<void> {
    const response = await this.fetcher(
      `${this.apiBaseUrl}/repos/${this.repository}/actions/workflows/`
      + `${encodeURIComponent(this.workflow)}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "codewise-hosted-indexing",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          ref: this.workflowRef,
          inputs: {
            roslyn_sha: candidate.sha,
            roslyn_ref: candidate.sourceRef,
            source_kind: candidate.sourceKind,
            source_label: candidate.sourceLabel,
            pull_request_number: candidate.pullRequestNumber?.toString() ?? "",
            attempt: candidate.attempt.toString()
          }
        })
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub workflow dispatch failed with ${response.status} `
        + `${response.statusText}: ${await readErrorMessage(response)}`
      );
    }
  }
}

export function validateSha(value: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`Invalid commit SHA: ${value}`);
  }
  return value;
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const value = JSON.parse(body) as { readonly message?: string };
    return value.message ?? body;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return body;
    }
    throw error;
  }
}
