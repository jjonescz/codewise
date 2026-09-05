import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CrawlerConfig } from "./config.js";
import {
  isObject,
  type InitializeResult,
  type PositionEncoding
} from "./lsp-types.js";

const methodNotFound = -32601;
const internalError = -32603;

interface PendingRequest {
  readonly method: string;
  readonly startedAt: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface RequestAccumulator {
  succeeded: number;
  failed: number;
  readonly durations: number[];
}

export interface LspRequestStatistics {
  readonly method: string;
  readonly requestCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly totalDurationMilliseconds: number;
  readonly averageDurationMilliseconds: number;
  readonly p95DurationMilliseconds: number;
  readonly maximumDurationMilliseconds: number;
}

interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export class LspResponseError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "LspResponseError";
  }
}

export class LspRequestTimeoutError extends Error {
  public constructor(
    public readonly method: string,
    public readonly timeoutMilliseconds: number
  ) {
    super(
      `Language server request ${method} timed out after `
      + `${timeoutMilliseconds}ms.`
    );
    this.name = "LspRequestTimeoutError";
  }
}

export class LspProcessClient {
  readonly #config: CrawlerConfig;
  readonly #onLog: (message: string) => void;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #dynamicRegistrations = new Map<string, unknown>();
  readonly #activeProgress = new Set<string>();
  readonly #requestStatistics = new Map<string, RequestAccumulator>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #initializeResult: InitializeResult | undefined;
  #lastProgressAt = Date.now();
  #stopping = false;
  #fatalError: Error | undefined;
  readonly #stderrTail: string[] = [];

  public constructor(
    config: CrawlerConfig,
    onLog: (message: string) => void = () => undefined
  ) {
    this.#config = config;
    this.#onLog = onLog;
  }

  public get initializeResult(): InitializeResult {
    if (this.#initializeResult === undefined) {
      throw new Error("The language server has not been initialized.");
    }
    return this.#initializeResult;
  }

  public get positionEncoding(): PositionEncoding {
    const value = this.initializeResult.capabilities["positionEncoding"];
    return value === "utf-8" || value === "utf-32" ? value : "utf-16";
  }

  public async start(): Promise<void> {
    if (this.#process !== undefined) {
      throw new Error("The language server process has already been started.");
    }

    const launch = serverLaunchCommand(
      this.#config.server.command,
      this.#config.server.args
    );
    const child = spawn(launch.command, launch.args, {
      cwd: this.#config.server.cwd,
      env: { ...process.env, ...this.#config.server.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(launch.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {})
    });
    this.#process = child;
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.length > 0) {
          this.#stderrTail.push(line);
          if (this.#stderrTail.length > 20) {
            this.#stderrTail.shift();
          }
          this.#onLog(`[server] ${line}`);
        }
      }
    });
    child.on("error", (error) => this.#breakConnection(error));
    child.on("close", (code, signal) => {
      if (!this.#stopping) {
        this.#breakConnection(
          new Error(
            `Language server exited unexpectedly with code ${String(code)} `
            + `and signal ${String(signal)}.${this.#stderrDetail()}`
          )
        );
      }
    });

    const rootUri = pathToFileURL(this.#config.workspaceRoot).href;
    const result = await this.request<unknown>("initialize", {
      processId: process.pid,
      clientInfo: { name: "codewise-lsp-crawler", version: "0.0.1" },
      rootUri,
      workspaceFolders: [{
        uri: rootUri,
        name: this.#config.workspaceRoot.split(/[\\/]/u).at(-1) ?? "workspace"
      }],
      capabilities: clientCapabilities(),
      initializationOptions: this.#config.initializationOptions ?? null,
      trace: "off"
    });
    if (!isObject(result) || !isObject(result["capabilities"])) {
      throw new Error("Language server returned an invalid initialize result.");
    }
    this.#initializeResult = result as unknown as InitializeResult;
    this.notify("initialized", {});
  }

  public supports(method: string): boolean {
    if (this.#dynamicRegistrations.has(method)) {
      return true;
    }
    const capabilities = this.initializeResult.capabilities;
    const capabilityName = new Map<string, string>([
      ["textDocument/definition", "definitionProvider"],
      ["textDocument/declaration", "declarationProvider"],
      ["textDocument/references", "referencesProvider"],
      ["textDocument/documentHighlight", "documentHighlightProvider"],
      ["textDocument/documentSymbol", "documentSymbolProvider"],
      ["textDocument/hover", "hoverProvider"]
    ]).get(method);
    if (capabilityName !== undefined) {
      const value = capabilities[capabilityName];
      return value === true || isObject(value);
    }
    if (method.startsWith("textDocument/semanticTokens/", 0)) {
      const value = capabilities["semanticTokensProvider"];
      if (!isObject(value)) {
        return value === true;
      }
      const capability = method.endsWith("/range") ? value["range"] : value["full"];
      return capability === true || isObject(capability);
    }
    return false;
  }

  public semanticTokensRegistration(): unknown {
    return this.#dynamicRegistrations.get("textDocument/semanticTokens")
      ?? this.initializeResult.capabilities["semanticTokensProvider"];
  }

  public requestStatistics(): readonly LspRequestStatistics[] {
    return [...this.#requestStatistics.entries()]
      .map(([method, accumulator]) => {
        const durations = [...accumulator.durations].sort((left, right) => left - right);
        const requestCount = durations.length;
        const totalDurationMilliseconds = durations.reduce(
          (total, duration) => total + duration,
          0
        );
        return {
          method,
          requestCount,
          succeeded: accumulator.succeeded,
          failed: accumulator.failed,
          totalDurationMilliseconds,
          averageDurationMilliseconds: requestCount === 0
            ? 0
            : totalDurationMilliseconds / requestCount,
          p95DurationMilliseconds: percentile(durations, 0.95),
          maximumDurationMilliseconds: durations.at(-1) ?? 0
        };
      })
      .sort((left, right) => (
        right.totalDurationMilliseconds - left.totalDurationMilliseconds
        || left.method.localeCompare(right.method)
      ));
  }

  public request<T>(
    method: string,
    params?: unknown,
    timeoutMilliseconds = this.#config.requestTimeoutMilliseconds
  ): Promise<T> {
    if (this.#fatalError !== undefined) {
      return Promise.reject(this.#fatalError);
    }
    const process = this.#requireProcess();
    const id = this.#nextId++;
    const startedAt = Date.now();
    return new Promise<T>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending === undefined) {
          return;
        }
        try {
          this.#write(process, {
            jsonrpc: "2.0",
            method: "$/cancelRequest",
            params: { id }
          });
        } finally {
          this.#pending.delete(id);
          this.#recordRequest(pending, false);
          reject(new LspRequestTimeoutError(method, timeoutMilliseconds));
        }
      }, timeoutMilliseconds);
      this.#pending.set(id, {
        method,
        startedAt,
        resolve: (value) => resolveRequest(value as T),
        reject,
        timer
      });
      this.#write(process, {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params })
      });
    });
  }

  public notify(method: string, params?: unknown): void {
    this.#write(this.#requireProcess(), {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    });
  }

  public async waitForIdle(): Promise<boolean> {
    const deadline = Date.now() + this.#config.workspaceLoadTimeoutMilliseconds;
    while (true) {
      const quietFor = Date.now() - this.#lastProgressAt;
      if (
        this.#activeProgress.size === 0
        && quietFor >= this.#config.settleMilliseconds
      ) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(Math.min(
        100,
        Math.max(1, this.#config.settleMilliseconds - quietFor)
      ));
    }
  }

  public async stop(): Promise<void> {
    const child = this.#process;
    if (child === undefined) {
      return;
    }
    this.#stopping = true;
    try {
      if (child.exitCode === null) {
        await Promise.race([
          this.request("shutdown"),
          delay(2_000).then(() => {
            throw new Error("Language server shutdown request timed out.");
          })
        ]);
        if (child.exitCode === null) {
          this.notify("exit");
        }
        await Promise.race([
          new Promise<void>((resolveExit) => {
            child.once("close", () => resolveExit());
          }),
          delay(2_000)
        ]);
      }
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      this.#process = undefined;
      this.#failPending(new Error("Language server stopped."));
    }
  }

  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /^Content-Length:\s*(\d+)\s*$/imu.exec(header);
      if (match?.[1] === undefined) {
        this.#breakConnection(
          new Error("Language server sent a message without Content-Length.")
        );
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) {
        return;
      }

      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.#breakConnection(
          new Error("Language server sent invalid JSON.", { cause: error })
        );
        return;
      }
      if (!isObject(message) || message["jsonrpc"] !== "2.0") {
        this.#breakConnection(
          new Error("Language server sent an invalid JSON-RPC message.")
        );
        return;
      }
      void this.#handleMessage(message as unknown as JsonRpcMessage);
    }
  }

  async #handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.method !== undefined && message.id !== undefined) {
      await this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) {
      this.#handleNotification(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    this.#recordRequest(pending, message.error === undefined);
    if (message.error !== undefined) {
      pending.reject(new LspResponseError(
        message.error.code,
        `${pending.method}: ${message.error.message}`,
        message.error.data
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  async #handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    const child = this.#requireProcess();
    try {
      const result = this.#serverRequestResult(method, params);
      this.#write(child, { jsonrpc: "2.0", id, result });
    } catch (error) {
      this.#write(child, {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof LspResponseError ? error.code : internalError,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  #serverRequestResult(method: string, params: unknown): unknown {
    if (Object.hasOwn(this.#config.server.requestResponses, method)) {
      return this.#config.server.requestResponses[method];
    }
    switch (method) {
      case "client/registerCapability":
        if (isObject(params) && Array.isArray(params["registrations"])) {
          for (const registration of params["registrations"]) {
            if (
              isObject(registration)
              && typeof registration["method"] === "string"
            ) {
              this.#dynamicRegistrations.set(
                registration["method"],
                registration["registerOptions"]
              );
            }
          }
        }
        return null;
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        return null;
      case "workspace/configuration": {
        const count = isObject(params) && Array.isArray(params["items"])
          ? params["items"].length
          : 0;
        return Array.from({ length: count }, () => null);
      }
      case "workspace/workspaceFolders":
        return [{
          uri: pathToFileURL(this.#config.workspaceRoot).href,
          name: this.#config.workspaceRoot.split(/[\\/]/u).at(-1) ?? "workspace"
        }];
      case "workspace/applyEdit":
        return {
          applied: false,
          failureReason: "The indexing client does not apply workspace edits."
        };
      case "window/showDocument":
        return { success: false };
      default:
        throw new LspResponseError(
          methodNotFound,
          `The indexing client does not implement server request ${method}.`
        );
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === "$/progress" && isObject(params)) {
      const token = String(params["token"]);
      const value = params["value"];
      if (isObject(value)) {
        if (value["kind"] === "begin") {
          this.#activeProgress.add(token);
        } else if (value["kind"] === "end") {
          this.#activeProgress.delete(token);
        }
      }
      this.#lastProgressAt = Date.now();
      return;
    }
    if (
      (method === "window/logMessage" || method === "window/showMessage")
      && isObject(params)
      && typeof params["message"] === "string"
    ) {
      this.#onLog(`[server] ${params["message"]}`);
    }
  }

  #write(process: ChildProcessWithoutNullStreams, message: JsonRpcMessage): void {
    const body = JSON.stringify(message);
    process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  #requireProcess(): ChildProcessWithoutNullStreams {
    if (this.#process === undefined) {
      throw new Error("The language server process is not running.");
    }
    return this.#process;
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      this.#recordRequest(pending, false);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #recordRequest(pending: PendingRequest, succeeded: boolean): void {
    const accumulator = this.#requestStatistics.get(pending.method) ?? {
      succeeded: 0,
      failed: 0,
      durations: []
    };
    if (succeeded) {
      accumulator.succeeded++;
    } else {
      accumulator.failed++;
    }
    accumulator.durations.push(Date.now() - pending.startedAt);
    this.#requestStatistics.set(pending.method, accumulator);
  }

  #breakConnection(error: Error): void {
    if (this.#fatalError !== undefined) {
      return;
    }
    this.#fatalError = error;
    this.#buffer = Buffer.alloc(0);
    this.#failPending(error);
    if (this.#process?.exitCode === null) {
      this.#process.kill();
    }
  }

  #stderrDetail(): string {
    return this.#stderrTail.length === 0
      ? ""
      : `\nRecent server stderr:\n${this.#stderrTail.join("\n")}`;
  }
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.max(
    0,
    Math.ceil(sortedValues.length * percentileValue) - 1
  );
  return sortedValues[index]!;
}

function clientCapabilities(): Record<string, unknown> {
  return {
    general: { positionEncodings: ["utf-8", "utf-16", "utf-32"] },
    window: { workDoneProgress: true },
    workspace: {
      workspaceFolders: true,
      configuration: true,
      symbol: { dynamicRegistration: true }
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: true,
        didSave: false,
        willSave: false,
        willSaveWaitUntil: false
      },
      declaration: { dynamicRegistration: true, linkSupport: true },
      definition: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      documentHighlight: { dynamicRegistration: true },
      documentSymbol: {
        dynamicRegistration: true,
        hierarchicalDocumentSymbolSupport: true
      },
      hover: {
        dynamicRegistration: true,
        contentFormat: ["markdown", "plaintext"]
      },
      semanticTokens: {
        dynamicRegistration: true,
        requests: { range: true, full: true },
        tokenTypes: [
          "namespace", "type", "class", "enum", "interface", "struct",
          "typeParameter", "parameter", "variable", "property", "enumMember",
          "event", "function", "method", "macro", "label", "comment", "string",
          "keyword", "number", "regexp", "operator", "decorator"
        ],
        tokenModifiers: [
          "declaration", "definition", "readonly", "static", "deprecated",
          "abstract", "async", "modification", "documentation", "defaultLibrary"
        ],
        formats: ["relative"],
        overlappingTokenSupport: true,
        multilineTokenSupport: true
      }
    }
  };
}

function serverLaunchCommand(
  command: string,
  args: readonly string[]
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
} {
  if (process.platform !== "win32") {
    return { command, args };
  }
  const resolvedCommand = resolveWindowsCommand(command) ?? command;
  if (!/\.(?:bat|cmd)$/iu.test(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }
  const shimExecutable = executableFromDotnetToolShim(resolvedCommand);
  if (shimExecutable !== undefined) {
    return { command: shimExecutable, args };
  }
  const commandLine = [resolvedCommand, ...args]
    .map((argument) => `"${argument.replace(/"/gu, "\"\"")}"`)
    .join(" ");
  return {
    command: process.env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

function resolveWindowsCommand(command: string): string | undefined {
  const extensions = command.includes(".")
    ? [""]
    : (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.toLowerCase());
  const directories = isAbsolute(command) || /[\\/]/u.test(command)
    ? [""]
    : (process.env["PATH"] ?? "").split(delimiter);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory.length === 0
        ? `${command}${extension}`
        : resolve(directory, `${command}${extension}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function executableFromDotnetToolShim(command: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(command, "utf8");
  } catch {
    return undefined;
  }
  const match = /"%~dp0([^"\r\n]+\.exe)"\s+%\*/iu.exec(contents);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const executable = resolve(dirname(command), match[1]);
  return existsSync(executable) ? executable : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
