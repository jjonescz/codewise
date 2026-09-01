import { Buffer } from "node:buffer";
import { emptyState, parseState, type IndexState } from "./state.js";

export interface StateMutation<T> {
  readonly state: IndexState;
  readonly result: T;
}

class GitHubApiError extends Error {
  public constructor(
    public readonly status: number,
    statusText: string,
    operation: string,
    message: string,
    public readonly retryAfterMilliseconds?: number
  ) {
    super(
      `Failed to ${operation}: ${status} ${statusText}: ${message}`
    );
    this.name = "GitHubApiError";
  }
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
    const ambiguousWrites: StateMutation<T>[] = [];
    for (let attempt = 1; attempt <= 50; attempt++) {
      let current: Awaited<ReturnType<StateRepository["read"]>>;
      try {
        current = await this.read();
      } catch (error) {
        if (!isRetryableError(error)) {
          throw error;
        }
        await delay(retryDelay(attempt, error));
        continue;
      }

      const confirmedWrite = ambiguousWrites.find(
        (candidate) => sameState(candidate.state, current.state)
      );
      if (confirmedWrite !== undefined) {
        return confirmedWrite.result;
      }

      const mutation = mutate(current.state);
      if (sameState(mutation.state, current.state)) {
        return mutation.result;
      }

      let response: Response;
      try {
        response = await this.fetcher(
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
      } catch (error) {
        if (!isRetryableError(error)) {
          throw error;
        }
        ambiguousWrites.push(mutation);
        await delay(retryDelay(attempt, error));
        continue;
      }

      if (response.ok) {
        return mutation.result;
      }
      if (response.status === 409) {
        await delay(retryDelay(attempt));
        continue;
      }
      if (isRetryableStatus(response)) {
        ambiguousWrites.push(mutation);
        await delay(retryDelay(attempt, response));
        continue;
      }
      throw await this.responseError("update index state", response);
    }
    throw new Error(
      "Could not update index state after 50 conflict or transient-error retries."
    );
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
    return new GitHubApiError(
      response.status,
      response.statusText,
      operation,
      message,
      retryAfterFromHeaders(response)
    );
  }
}

function sameState(left: IndexState, right: IndexState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRetryableError(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof GitHubApiError && isRetryableStatus(error.status));
}

function isRetryableStatus(response: Response): boolean;
function isRetryableStatus(status: number): boolean;
function isRetryableStatus(value: Response | number): boolean {
  const status = typeof value === "number" ? value : value.status;
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return true;
  }
  return typeof value !== "number"
    && status === 403
    && (
      value.headers.has("retry-after")
      || value.headers.get("x-ratelimit-remaining") === "0"
    );
}

function retryDelay(
  attempt: number,
  source?: Response | GitHubApiError | unknown
): number {
  const requestedDelay = source instanceof Response
    ? retryAfterFromHeaders(source)
    : source instanceof GitHubApiError
      ? source.retryAfterMilliseconds
      : undefined;
  return requestedDelay
    ?? Math.min(30_000, 250 * (2 ** Math.min(attempt - 1, 7)))
      + Math.floor(Math.random() * 250);
}

function retryAfterFromHeaders(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(120_000, Math.ceil(seconds * 1_000));
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(120_000, Math.max(0, date - Date.now()));
    }
  }

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) {
      return Math.min(
        120_000,
        Math.max(0, Math.ceil(reset * 1_000 - Date.now()))
      );
    }
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
