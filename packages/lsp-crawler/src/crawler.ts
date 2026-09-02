import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { LspProcessClient, LspResponseError } from "./client.js";
import type { CrawlerConfig } from "./config.js";
import {
  CrawlerDatabase,
  type LocationAnswerKind
} from "./database.js";
import {
  isDocumentSymbol,
  isHover,
  isLocation,
  isObject,
  isRange,
  isSemanticTokens,
  isSymbolInformation,
  type DocumentSymbol,
  type Hover,
  type Location,
  type Position,
  type PositionEncoding,
  type Range,
  type SemanticTokensLegend
} from "./lsp-types.js";

export interface CrawlProgress {
  readonly documentsCompleted: number;
  readonly documentCount: number;
  readonly currentDocument: string;
  readonly elapsedMilliseconds: number;
  readonly documentsPerSecond: number;
  readonly estimatedRemainingMilliseconds: number;
}

export interface CrawlTimings {
  readonly documentDiscoveryMilliseconds: number;
  readonly serverInitializationMilliseconds: number;
  readonly indexPreparationMilliseconds: number;
  readonly workspaceLoadWaitMilliseconds: number;
  readonly documentCrawlMilliseconds: number;
  readonly totalMilliseconds: number;
}

export interface CrawlSummary {
  readonly documentCount: number;
  readonly documentsCompleted: number;
  readonly requestFailures: number;
  readonly database: ReturnType<CrawlerDatabase["statistics"]>;
  readonly timings: CrawlTimings;
}

export interface CrawlOptions {
  readonly onLog?: (message: string) => void;
  readonly onProgress?: (progress: CrawlProgress) => void;
}

interface Candidate {
  readonly range: Range;
  readonly discoverySource: "document-symbol" | "lexical" | "semantic-token";
  readonly semanticTokenType?: string;
  readonly semanticModifiers?: number;
}

interface WorkspaceDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly languageId: string;
}

const ignoredDirectories = new Set([
  ".git", ".idea", ".vs", "bin", "node_modules", "obj"
]);
const retryableErrorCodes = new Set([-32800, -32801, -32802]);
const methodNotFound = -32601;

export async function crawlWorkspace(
  config: CrawlerConfig,
  databasePath: string,
  options: CrawlOptions = {}
): Promise<CrawlSummary> {
  const startedAt = performance.now();
  const onLog = options.onLog ?? (() => undefined);
  const database = new CrawlerDatabase(databasePath);
  const client = new LspProcessClient(config, onLog);
  const failures: Error[] = [];

  try {
    const discoveryStartedAt = performance.now();
    const documents = await discoverWorkspaceDocuments(config);
    const documentDiscoveryMilliseconds =
      performance.now() - discoveryStartedAt;
    database.setMetadata("workspace_root", config.workspaceRoot);
    database.setMetadata("server_command", config.server.command);
    database.setMetadata("crawl_started_at", new Date().toISOString());
    database.setMetadata("document_count", String(documents.length));

    const serverInitializationStartedAt = performance.now();
    await client.start();
    const serverInitializationMilliseconds =
      performance.now() - serverInitializationStartedAt;
    database.setMetadata(
      "server_info",
      JSON.stringify(client.initializeResult.serverInfo ?? null)
    );
    database.setMetadata("position_encoding", client.positionEncoding);
    const indexPreparationStartedAt = performance.now();
    const documentInputs = await mapConcurrentValues(
      documents,
      Math.max(config.concurrency, 8),
      async (document) => ({
        uri: pathToFileURL(document.absolutePath).href,
        relativePath: document.relativePath,
        languageId: document.languageId,
        contentHash: createHash("sha256")
          .update(await readFile(document.absolutePath))
          .digest("hex"),
        positionEncoding: client.positionEncoding
      })
    );
    database.synchronizeDocuments(documentInputs);
    const indexPreparationMilliseconds =
      performance.now() - indexPreparationStartedAt;
    const workspaceLoadStartedAt = performance.now();
    if (!await client.waitForIdle()) {
      onLog(
        `[client] Language server did not report an idle workspace within `
        + `${config.workspaceLoadTimeoutMilliseconds}ms; continuing the crawl.`
      );
    }
    const workspaceLoadWaitMilliseconds =
      performance.now() - workspaceLoadStartedAt;

    let documentsCompleted = 0;
    const documentCrawlStartedAt = performance.now();
    await mapConcurrent(documents, config.concurrency, async (document) => {
      try {
        await crawlDocument(client, database, config, document, failures);
      } catch (error) {
        const failure = requestFailure("crawl", document.relativePath, error);
        failures.push(failure);
        onLog(failure.message);
      } finally {
        documentsCompleted++;
        const elapsedMilliseconds =
          performance.now() - documentCrawlStartedAt;
        const documentsPerSecond = elapsedMilliseconds === 0
          ? 0
          : documentsCompleted * 1_000 / elapsedMilliseconds;
        const estimatedRemainingMilliseconds = documentsPerSecond === 0
          ? 0
          : (documents.length - documentsCompleted)
            * 1_000
            / documentsPerSecond;
        options.onProgress?.({
          documentsCompleted,
          documentCount: documents.length,
          currentDocument: document.relativePath,
          elapsedMilliseconds,
          documentsPerSecond,
          estimatedRemainingMilliseconds
        });
      }
    });
    const documentCrawlMilliseconds =
      performance.now() - documentCrawlStartedAt;

    database.setMetadata("crawl_finished_at", new Date().toISOString());
    const summary: CrawlSummary = {
      documentCount: documents.length,
      documentsCompleted,
      requestFailures: failures.length,
      database: database.statistics(),
      timings: {
        documentDiscoveryMilliseconds,
        serverInitializationMilliseconds,
        indexPreparationMilliseconds,
        workspaceLoadWaitMilliseconds,
        documentCrawlMilliseconds,
        totalMilliseconds: performance.now() - startedAt
      }
    };
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `The LSP crawl completed with ${failures.length} failure(s).`
      );
    }
    return summary;
  } finally {
    await client.stop().catch((error) => {
      onLog(`Failed to stop language server: ${String(error)}`);
    });
    database.close();
  }
}

async function crawlDocument(
  client: LspProcessClient,
  database: CrawlerDatabase,
  config: CrawlerConfig,
  document: WorkspaceDocument,
  failures: Error[]
): Promise<void> {
  const content = await readFile(document.absolutePath, "utf8");
  const uri = pathToFileURL(document.absolutePath).href;
  const mapper = new TextCoordinateMapper(content, client.positionEncoding);
  const record = database.upsertDocument({
    uri,
    relativePath: document.relativePath,
    languageId: document.languageId,
    contentHash: createHash("sha256").update(content).digest("hex"),
    positionEncoding: client.positionEncoding
  });

  client.notify("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: document.languageId,
      version: 1,
      text: content
    }
  });
  try {
    const candidates = await discoverCandidates(
      client,
      config,
      uri,
      content,
      mapper,
      failures
    );
    for (const candidate of candidates) {
      database.upsertOccurrence({
        documentId: record.id,
        range: candidate.range,
        discoverySource: candidate.discoverySource,
        ...(candidate.semanticTokenType === undefined
          ? {}
          : { semanticTokenType: candidate.semanticTokenType }),
        ...(candidate.semanticModifiers === undefined
          ? {}
          : { semanticModifiers: candidate.semanticModifiers })
      });
    }
    for (const occurrence of database.listOccurrences(record.id)) {
      await probeOccurrence(
        client,
        database,
        uri,
        occurrence.id,
        occurrence.range.start,
        failures
      );
    }
  } finally {
    client.notify("textDocument/didClose", { textDocument: { uri } });
  }
}

async function discoverCandidates(
  client: LspProcessClient,
  config: CrawlerConfig,
  uri: string,
  content: string,
  mapper: TextCoordinateMapper,
  failures: Error[]
): Promise<readonly Candidate[]> {
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate): void => {
    if (comparePositions(candidate.range.start, candidate.range.end) >= 0) {
      return;
    }
    const key = rangeKey(candidate.range);
    const existing = candidates.get(key);
    if (
      existing === undefined
      || candidatePriority(candidate.discoverySource)
        > candidatePriority(existing.discoverySource)
    ) {
      candidates.set(key, candidate);
    }
  };

  const semanticRegistration = client.semanticTokensRegistration();
  if (semanticRegistration !== undefined && semanticRegistration !== false) {
    try {
      (await semanticTokenCandidates(
        client,
        uri,
        mapper,
        semanticRegistration
      )).forEach(add);
    } catch (error) {
      failures.push(requestFailure("semantic tokens", uri, error));
    }
  }
  if (client.supports("textDocument/documentSymbol")) {
    try {
      const value = await requestWithRetry<unknown>(
        client,
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      documentSymbolCandidates(value, uri).forEach(add);
    } catch (error) {
      failures.push(requestFailure("document symbols", uri, error));
    }
  }
  if (config.lexicalFallback) {
    lexicalCandidates(content, mapper).forEach(add);
  }
  return [...candidates.values()].sort((left, right) => (
    comparePositions(left.range.start, right.range.start)
    || comparePositions(left.range.end, right.range.end)
  ));
}

async function semanticTokenCandidates(
  client: LspProcessClient,
  uri: string,
  mapper: TextCoordinateMapper,
  registration: unknown
): Promise<readonly Candidate[]> {
  const legend = semanticTokensLegend(registration);
  const provider = isObject(registration) ? registration : {};
  let value: unknown;
  if (provider["full"] === true || isObject(provider["full"])) {
    value = await requestWithRetry(
      client,
      "textDocument/semanticTokens/full",
      { textDocument: { uri } }
    );
  } else if (provider["range"] === true || isObject(provider["range"])) {
    value = await requestWithRetry(
      client,
      "textDocument/semanticTokens/range",
      {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: mapper.end }
      }
    );
  } else {
    try {
      value = await requestWithRetry(
        client,
        "textDocument/semanticTokens/full",
        { textDocument: { uri } }
      );
    } catch (error) {
      if (!(error instanceof LspResponseError) || error.code !== methodNotFound) {
        throw error;
      }
      value = await requestWithRetry(
        client,
        "textDocument/semanticTokens/range",
        {
          textDocument: { uri },
          range: { start: { line: 0, character: 0 }, end: mapper.end }
        }
      );
    }
  }
  if (value === null) {
    return [];
  }
  if (!isSemanticTokens(value) || value.data.length % 5 !== 0) {
    throw new Error("Language server returned invalid semantic token data.");
  }

  const result: Candidate[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < value.data.length; index += 5) {
    const deltaLine = value.data[index]!;
    const deltaCharacter = value.data[index + 1]!;
    const length = value.data[index + 2]!;
    const tokenType = value.data[index + 3]!;
    const modifiers = value.data[index + 4]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
    const semanticTokenType = legend.tokenTypes[tokenType] ?? `token-${tokenType}`;
    if (length > 0 && isNavigableSemanticToken(semanticTokenType)) {
      result.push({
        range: {
          start: { line, character },
          end: { line, character: character + length }
        },
        discoverySource: "semantic-token",
        semanticTokenType,
        semanticModifiers: modifiers
      });
    }
  }
  return result;
}

function semanticTokensLegend(registration: unknown): SemanticTokensLegend {
  if (
    isObject(registration)
    && isObject(registration["legend"])
    && Array.isArray(registration["legend"]["tokenTypes"])
    && registration["legend"]["tokenTypes"].every(
      (item) => typeof item === "string"
    )
    && Array.isArray(registration["legend"]["tokenModifiers"])
    && registration["legend"]["tokenModifiers"].every(
      (item) => typeof item === "string"
    )
  ) {
    return registration["legend"] as unknown as SemanticTokensLegend;
  }
  return { tokenTypes: [], tokenModifiers: [] };
}

function documentSymbolCandidates(
  value: unknown,
  uri: string
): readonly Candidate[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Language server returned invalid document symbols.");
  }
  const candidates: Candidate[] = [];
  const visit = (symbol: DocumentSymbol): void => {
    candidates.push({
      range: symbol.selectionRange,
      discoverySource: "document-symbol"
    });
    symbol.children?.forEach(visit);
  };
  for (const symbol of value) {
    if (isDocumentSymbol(symbol)) {
      visit(symbol);
    } else if (isSymbolInformation(symbol) && symbol.location.uri === uri) {
      candidates.push({
        range: symbol.location.range,
        discoverySource: "document-symbol"
      });
    } else if (!isSymbolInformation(symbol)) {
      throw new Error("Language server returned an invalid document symbol.");
    }
  }
  return candidates;
}

function lexicalCandidates(
  content: string,
  mapper: TextCoordinateMapper
): readonly Candidate[] {
  const result: Candidate[] = [];
  const identifier = /[\p{ID_Start}_$][\p{ID_Continue}$]*/gu;
  for (const match of content.matchAll(identifier)) {
    if (match.index !== undefined && match[0].length > 0) {
      result.push({
        range: {
          start: mapper.positionAtUtf16Offset(match.index),
          end: mapper.positionAtUtf16Offset(match.index + match[0].length)
        },
        discoverySource: "lexical"
      });
    }
  }
  return result;
}

async function probeOccurrence(
  client: LspProcessClient,
  database: CrawlerDatabase,
  uri: string,
  occurrenceId: number,
  position: Position,
  failures: Error[]
): Promise<void> {
  const methods: readonly [LocationAnswerKind, string][] = [
    ["references", "textDocument/references"],
    ["definition", "textDocument/definition"],
    ["declaration", "textDocument/declaration"],
    ["highlights", "textDocument/documentHighlight"]
  ];
  for (const [kind, method] of methods) {
    if (!client.supports(method) || database.hasCompleteAnswer(occurrenceId, kind)) {
      continue;
    }
    try {
      const value = await requestWithRetry<unknown>(client, method, {
        textDocument: { uri },
        position,
        ...(kind === "references"
          ? { context: { includeDeclaration: true } }
          : {})
      });
      database.saveLocationAnswer(
        occurrenceId,
        kind,
        kind === "highlights" ? parseHighlights(value, uri) : parseLocations(value)
      );
    } catch (error) {
      if (error instanceof LspResponseError && error.code === methodNotFound) {
        continue;
      }
      database.saveAnswerError(occurrenceId, kind, error);
      failures.push(requestFailure(method, uri, error, position));
    }
  }

  if (
    client.supports("textDocument/hover")
    && !database.hasCompleteHover(occurrenceId)
  ) {
    try {
      const value = await requestWithRetry<unknown>(
        client,
        "textDocument/hover",
        { textDocument: { uri }, position }
      );
      if (value !== null && !isHover(value)) {
        throw new Error("Language server returned an invalid hover result.");
      }
      database.saveHover(occurrenceId, value as Hover | null);
    } catch (error) {
      if (!(error instanceof LspResponseError) || error.code !== methodNotFound) {
        database.saveHoverError(occurrenceId, error);
        failures.push(requestFailure("hover", uri, error, position));
      }
    }
  }
}

function parseLocations(value: unknown): readonly Location[] {
  if (value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((item): Location => {
    if (isLocation(item)) {
      return item;
    }
    if (
      isObject(item)
      && typeof item["targetUri"] === "string"
      && isRange(item["targetSelectionRange"])
    ) {
      return {
        uri: item["targetUri"],
        range: item["targetSelectionRange"]
      };
    }
    throw new Error("Language server returned an invalid location.");
  });
}

function parseHighlights(value: unknown, uri: string): readonly Location[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Language server returned invalid document highlights.");
  }
  return value.map((item): Location => {
    if (!isObject(item) || !isRange(item["range"])) {
      throw new Error("Language server returned an invalid document highlight.");
    }
    return { uri, range: item["range"] };
  });
}

async function requestWithRetry<T>(
  client: LspProcessClient,
  method: string,
  params: unknown
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await client.request<T>(method, params);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof LspResponseError)
        || !retryableErrorCodes.has(error.code)
        || attempt === 3
      ) {
        throw error;
      }
      await delay(attempt * 100);
    }
  }
  throw lastError;
}

export async function discoverWorkspaceDocuments(
  config: CrawlerConfig
): Promise<readonly WorkspaceDocument[]> {
  const languageByExtension = new Map<string, string>();
  for (const document of config.documents) {
    for (const extension of document.extensions) {
      const existing = languageByExtension.get(extension);
      if (existing !== undefined && existing !== document.languageId) {
        throw new Error(
          `Extension ${extension} is configured for both ${existing} `
          + `and ${document.languageId}.`
        );
      }
      languageByExtension.set(extension, document.languageId);
    }
  }

  const paths = await listGitFiles(config.workspaceRoot)
    ?? await walkFiles(config.workspaceRoot);
  const documents: WorkspaceDocument[] = [];
  for (const path of paths) {
    const languageId = languageByExtension.get(extname(path).toLowerCase());
    if (languageId !== undefined) {
      const absolutePath = resolve(config.workspaceRoot, path);
      documents.push({
        absolutePath,
        relativePath: relative(config.workspaceRoot, absolutePath)
          .replace(/\\/gu, "/"),
        languageId
      });
    }
  }
  documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return documents;
}

async function listGitFiles(root: string): Promise<readonly string[] | undefined> {
  return await new Promise((resolveFiles) => {
    const child = spawn(
      "git",
      ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolveFiles(undefined));
    child.on("close", (code) => {
      resolveFiles(code === 0
        ? Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean)
        : undefined);
    });
  });
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(relative(root, path));
      }
    }
  };
  await visit(root);
  return result;
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>
): Promise<void> {
  await mapConcurrentValues(values, concurrency, async (value) => {
    await action(value);
    return undefined;
  });
}

async function mapConcurrentValues<T, TResult>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<TResult>
): Promise<readonly TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        const value = values[index];
        if (value === undefined) {
          return;
        }
        results[index] = await action(value);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

class TextCoordinateMapper {
  readonly #content: string;
  readonly #encoding: PositionEncoding;
  readonly #lineStarts: readonly number[];

  public constructor(content: string, encoding: PositionEncoding) {
    this.#content = content;
    this.#encoding = encoding;
    const lineStarts = [0];
    for (let index = 0; index < content.length; index++) {
      if (content.charCodeAt(index) === 10) {
        lineStarts.push(index + 1);
      }
    }
    this.#lineStarts = lineStarts;
  }

  public get end(): Position {
    return this.positionAtUtf16Offset(this.#content.length);
  }

  public positionAtUtf16Offset(offset: number): Position {
    let low = 0;
    let high = this.#lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#lineStarts[middle]! <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    const prefix = this.#content.slice(this.#lineStarts[low]!, offset);
    return {
      line: low,
      character: this.#encoding === "utf-8"
        ? Buffer.byteLength(prefix, "utf8")
        : this.#encoding === "utf-32"
          ? [...prefix].length
          : prefix.length
    };
  }
}

function requestFailure(
  operation: string,
  target: string,
  error: unknown,
  position?: Position
): Error {
  return new Error(
    `${operation} failed for ${target}${
      position === undefined ? "" : `:${position.line}:${position.character}`
    }: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  );
}

function candidatePriority(source: Candidate["discoverySource"]): number {
  return source === "semantic-token" ? 3 : source === "document-symbol" ? 2 : 1;
}

function rangeKey(range: Range): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  ].join(":");
}

function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function isNavigableSemanticToken(tokenType: string): boolean {
  const normalized = tokenType.toLowerCase();
  if (
    normalized === "comment"
    || normalized === "string"
    || normalized === "keyword"
    || normalized === "number"
    || normalized === "regexp"
    || normalized === "operator"
  ) {
    return false;
  }
  return [
    "namespace", "type", "class", "enum", "interface", "struct", "parameter",
    "variable", "property", "member", "field", "event", "function", "method",
    "macro", "label", "local", "constant", "decorator", "component"
  ].some((part) => normalized.includes(part));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
