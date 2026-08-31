import { Buffer } from "node:buffer";
import { emptyState, parseState, type IndexState } from "./state.js";

export interface StateMutation<T> {
  readonly state: IndexState;
  readonly result: T;
}

export class StateRepository {
  public constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly branch = "state",
    private readonly statePath = "index-state.json",
    private readonly apiBaseUrl = "https://api.github.com",
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async update<T>(
    commitMessage: string,
    mutate: (state: IndexState) => StateMutation<T>
  ): Promise<T> {
    for (let attempt = 1; attempt <= 50; attempt++) {
      const current = await this.read();
      const mutation = mutate(current.state);
      if (JSON.stringify(mutation.state) === JSON.stringify(current.state)) {
        return mutation.result;
      }
      const response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${this.repository}/contents/${this.statePath}`,
        {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({
            message: commitMessage,
            content: Buffer.from(
              `${JSON.stringify(mutation.state, undefined, 2)}\n`,
              "utf8"
            ).toString("base64"),
            branch: this.branch,
            ...(current.sha === undefined ? {} : { sha: current.sha })
          })
        }
      );
      if (response.ok) {
        return mutation.result;
      }
      if (response.status !== 409) {
        throw await this.responseError("update index state", response);
      }
      await delay(
        Math.min(2_000, 50 * (2 ** (attempt - 1)))
        + Math.floor(Math.random() * 100)
      );
    }
    throw new Error("Could not update index state after 50 conflict retries.");
  }

  private async read(): Promise<{
    readonly state: IndexState;
    readonly sha?: string;
  }> {
    const response = await this.fetcher(
      `${this.apiBaseUrl}/repos/${this.repository}/contents/${this.statePath}`
      + `?ref=${encodeURIComponent(this.branch)}`,
      { headers: this.headers() }
    );
    if (response.status === 404) {
      await this.ensureStateBranch();
      return { state: emptyState() };
    }
    if (!response.ok) {
      throw await this.responseError("read index state", response);
    }

    const value = await response.json() as {
      readonly content: string;
      readonly encoding: string;
      readonly sha: string;
    };
    if (value.encoding !== "base64" || value.sha.length === 0) {
      throw new Error("GitHub returned an invalid index state response.");
    }
    const content = Buffer.from(
      value.content.replaceAll("\n", ""),
      "base64"
    ).toString("utf8");
    return {
      state: content.trim() === "" ? emptyState() : parseState(content),
      sha: value.sha
    };
  }

  private async ensureStateBranch(): Promise<void> {
    const branchResponse = await this.fetcher(
      `${this.apiBaseUrl}/repos/${this.repository}/git/ref/heads/`
      + encodeURIComponent(this.branch),
      { headers: this.headers() }
    );
    if (branchResponse.ok) {
      return;
    }
    if (branchResponse.status !== 404) {
      throw await this.responseError("check index state branch", branchResponse);
    }

    const mainResponse = await this.fetcher(
      `${this.apiBaseUrl}/repos/${this.repository}/git/ref/heads/main`,
      { headers: this.headers() }
    );
    if (!mainResponse.ok) {
      throw await this.responseError("read main branch", mainResponse);
    }
    const main = await mainResponse.json() as {
      readonly object?: { readonly sha?: string };
    };
    const sha = main.object?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
      throw new Error("GitHub returned an invalid main branch reference.");
    }

    const createResponse = await this.fetcher(
      `${this.apiBaseUrl}/repos/${this.repository}/git/refs`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          ref: `refs/heads/${this.branch}`,
          sha
        })
      }
    );
    if (!createResponse.ok && createResponse.status !== 422) {
      throw await this.responseError("create index state branch", createResponse);
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": "codewise-hosted-indexing",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  private async responseError(
    operation: string,
    response: Response
  ): Promise<Error> {
    const body = await response.text();
    let message = body;
    try {
      message = (JSON.parse(body) as { readonly message?: string }).message ?? body;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
    return new Error(
      `Failed to ${operation}: ${response.status} ${response.statusText}: ${message}`
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
