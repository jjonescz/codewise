import { CodeIndexValidationError } from "./schema.js";
import type { SqlDatabase } from "./types.js";

export interface IndexSemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export interface IndexSemanticTokens {
  readonly contentHash: string;
  readonly data: readonly number[];
}

export function normalizeSemanticText(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
}

export function parseSemanticTokensLegend(value: unknown): IndexSemanticTokensLegend {
  if (
    typeof value !== "object" || value === null
    || !("tokenTypes" in value) || !isStringArray(value.tokenTypes)
    || !("tokenModifiers" in value) || !isStringArray(value.tokenModifiers)
    || value.tokenTypes.length > 65_536
    || value.tokenModifiers.length > 31
    || new Set(value.tokenTypes).size !== value.tokenTypes.length
    || new Set(value.tokenModifiers).size !== value.tokenModifiers.length
  ) {
    throw new CodeIndexValidationError("Invalid semantic token legend.");
  }
  return { tokenTypes: value.tokenTypes, tokenModifiers: value.tokenModifiers };
}

export function readSemanticTokensLegend(
  database: SqlDatabase
): IndexSemanticTokensLegend | undefined {
  const version = database.all(
    "SELECT value FROM metadata WHERE key = 'semantic_tokens_version'"
  )[0]?.["value"];
  if (version === undefined) {
    return undefined;
  }
  if (version !== "1") {
    throw new CodeIndexValidationError("Unsupported semantic token format version.");
  }
  const json = database.all(
    "SELECT value FROM metadata WHERE key = 'semantic_tokens_legend'"
  )[0]?.["value"];
  if (typeof json !== "string") {
    throw new CodeIndexValidationError("The index is missing its semantic token legend.");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new CodeIndexValidationError("Invalid semantic token legend JSON.", { cause: error });
  }
  return parseSemanticTokensLegend(value);
}

export function validateSemanticTokens(
  data: readonly number[],
  legend: IndexSemanticTokensLegend
): void {
  if (
    data.length % 5 !== 0
    || data.some((value) => !Number.isInteger(value) || value < 0 || value > 0x7fffffff)
  ) {
    throw new CodeIndexValidationError("Invalid semantic token data.");
  }
  for (let i = 0; i < data.length; i += 5) {
    if (
      data[i + 2] === 0
      || data[i + 3]! >= legend.tokenTypes.length
      || data[i + 4]! >= 2 ** legend.tokenModifiers.length
    ) {
      throw new CodeIndexValidationError("Invalid semantic token length, type or modifiers.");
    }
  }
}

export function encodeSemanticTokens(
  data: readonly number[],
  legend: IndexSemanticTokensLegend
): Uint8Array {
  validateSemanticTokens(data, legend);
  const bytes = new Uint8Array(data.length * 4);
  const view = new DataView(bytes.buffer);
  data.forEach((value, i) => view.setUint32(i * 4, value, true));
  return bytes;
}

export function decodeSemanticTokens(
  bytes: Uint8Array,
  legend: IndexSemanticTokensLegend
): readonly number[] {
  if (bytes.byteLength % 20 !== 0) {
    throw new CodeIndexValidationError("Invalid semantic token payload size.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = Array.from(
    { length: bytes.byteLength / 4 },
    (_, i) => view.getUint32(i * 4, true)
  );
  validateSemanticTokens(data, legend);
  return data;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0);
}
