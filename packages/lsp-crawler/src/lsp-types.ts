import type { IndexPosition as Position, IndexRange as Range } from "@codewise/index-core";

export type { Position, Range };

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface DocumentSymbol {
  readonly name: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

export interface SymbolInformation {
  readonly name: string;
  readonly location: Location;
}

export interface SemanticTokens {
  readonly data: readonly number[];
}

export interface SemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export interface Hover {
  readonly contents: unknown;
  readonly range?: Range;
}

export interface InitializeResult {
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo?: {
    readonly name: string;
    readonly version?: string;
  };
}

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

export function isLocation(value: unknown): value is Location {
  return isObject(value)
    && typeof value["uri"] === "string"
    && isRange(value["range"]);
}

export function isRange(value: unknown): value is Range {
  return isObject(value)
    && isPosition(value["start"])
    && isPosition(value["end"]);
}

export function isPosition(value: unknown): value is Position {
  return isObject(value)
    && isNonNegativeInteger(value["line"])
    && isNonNegativeInteger(value["character"]);
}

export function isSemanticTokens(value: unknown): value is SemanticTokens {
  return isObject(value)
    && Array.isArray(value["data"])
    && value["data"].every(isNonNegativeInteger);
}

export function isDocumentSymbol(value: unknown): value is DocumentSymbol {
  if (
    !isObject(value)
    || typeof value["name"] !== "string"
    || !isRange(value["range"])
    || !isRange(value["selectionRange"])
  ) {
    return false;
  }
  const children = value["children"];
  return children === undefined
    || (Array.isArray(children) && children.every(isDocumentSymbol));
}

export function isSymbolInformation(value: unknown): value is SymbolInformation {
  return isObject(value)
    && typeof value["name"] === "string"
    && isLocation(value["location"]);
}

export function isHover(value: unknown): value is Hover {
  return isObject(value)
    && "contents" in value
    && (value["range"] === undefined || isRange(value["range"]));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
