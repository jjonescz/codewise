import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isObject } from "./lsp-types.js";

export interface DocumentLanguage {
  readonly languageId: string;
  readonly extensions: readonly string[];
}

export interface ServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly requestResponses: Readonly<Record<string, unknown>>;
}

export interface CrawlerConfig {
  readonly workspaceRoot: string;
  readonly server: ServerLaunch;
  readonly documents: readonly DocumentLanguage[];
  readonly initializationOptions?: unknown;
  readonly concurrency: number;
  readonly requestTimeoutMilliseconds: number;
  readonly settleMilliseconds: number;
  readonly lexicalFallback: boolean;
}

export async function loadCrawlerConfig(path: string): Promise<CrawlerConfig> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const value: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
  if (!isObject(value)) {
    throw new Error("Crawler configuration must be an object.");
  }

  const workspaceRoot = resolveRelativePath(
    requireString(value, "workspaceRoot"),
    directory
  );
  const serverValue = value["server"];
  if (!isObject(serverValue)) {
    throw new Error("Crawler configuration server must be an object.");
  }
  const documentsValue = value["documents"];
  if (!Array.isArray(documentsValue) || documentsValue.length === 0) {
    throw new Error("Crawler configuration documents must be a non-empty array.");
  }

  const documents = documentsValue.map((document, index): DocumentLanguage => {
    if (!isObject(document)) {
      throw new Error(`Crawler configuration documents[${index}] must be an object.`);
    }
    const languageId = requireString(document, "languageId");
    const extensions = requireStringArray(document, "extensions");
    if (extensions.length === 0 || extensions.some((item) => !item.startsWith("."))) {
      throw new Error(
        `Crawler configuration documents[${index}].extensions must be dot-prefixed.`
      );
    }
    return {
      languageId,
      extensions: [...new Set(extensions.map((item) => item.toLowerCase()))]
    };
  });
  const cwd = optionalString(serverValue, "cwd");

  return {
    workspaceRoot,
    server: {
      command: requireString(serverValue, "command"),
      args: optionalStringArray(serverValue, "args") ?? [],
      cwd: cwd === undefined ? workspaceRoot : resolveRelativePath(cwd, directory),
      environment: optionalStringRecord(serverValue, "environment") ?? {},
      requestResponses: optionalUnknownRecord(serverValue, "requestResponses") ?? {}
    },
    documents,
    concurrency: optionalInteger(value, "concurrency", 1) ?? 4,
    requestTimeoutMilliseconds:
      optionalInteger(value, "requestTimeoutMilliseconds", 1) ?? 60_000,
    settleMilliseconds: optionalInteger(value, "settleMilliseconds", 0) ?? 2_000,
    lexicalFallback: optionalBoolean(value, "lexicalFallback") ?? false,
    ...("initializationOptions" in value
      ? { initializationOptions: value["initializationOptions"] }
      : {})
  };
}

function resolveRelativePath(value: string, directory: string): string {
  return isAbsolute(value) ? value : resolve(directory, value);
}

function requireString(value: Record<string, unknown>, name: string): string {
  const result = optionalString(value, name);
  if (result === undefined) {
    throw new Error(`Crawler configuration ${name} must be a non-empty string.`);
  }
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  name: string
): string | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`Crawler configuration ${name} must be a non-empty string.`);
  }
  return candidate;
}

function requireStringArray(
  value: Record<string, unknown>,
  name: string
): string[] {
  const result = optionalStringArray(value, name);
  if (result === undefined) {
    throw new Error(`Crawler configuration ${name} must be an array of strings.`);
  }
  return result;
}

function optionalStringArray(
  value: Record<string, unknown>,
  name: string
): string[] | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(candidate)
    || candidate.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`Crawler configuration ${name} must be an array of strings.`);
  }
  return candidate;
}

function optionalStringRecord(
  value: Record<string, unknown>,
  name: string
): Record<string, string> | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (!isObject(candidate)) {
    throw new Error(`Crawler configuration ${name} must be an object of strings.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(candidate)) {
    if (typeof item !== "string") {
      throw new Error(`Crawler configuration ${name}.${key} must be a string.`);
    }
    result[key] = item;
  }
  return result;
}

function optionalUnknownRecord(
  value: Record<string, unknown>,
  name: string
): Record<string, unknown> | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (!isObject(candidate)) {
    throw new Error(`Crawler configuration ${name} must be an object.`);
  }
  return { ...candidate };
}

function optionalInteger(
  value: Record<string, unknown>,
  name: string,
  minimum: number
): number | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (
    typeof candidate !== "number"
    || !Number.isInteger(candidate)
    || candidate < minimum
  ) {
    throw new Error(
      `Crawler configuration ${name} must be an integer greater than or equal to ${minimum}.`
    );
  }
  return candidate;
}

function optionalBoolean(
  value: Record<string, unknown>,
  name: string
): boolean | undefined {
  const candidate = value[name];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "boolean") {
    throw new Error(`Crawler configuration ${name} must be a boolean.`);
  }
  return candidate;
}
