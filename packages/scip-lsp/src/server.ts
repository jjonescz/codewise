import {
  ErrorCodes,
  MarkupKind,
  PositionEncodingKind,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  type Connection,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type Position,
  type Range
} from "vscode-languageserver";
import {
  ScipIndex,
  type ScipHover,
  type ScipLocation,
  type ScipPosition,
  type ScipRange
} from "@codewise/scip-core";
import type { IndexSource } from "./index-source.js";
import { WorkspaceUriMapper } from "./workspace-uri-mapper.js";

export interface ScipInitializationOptions {
  readonly indexPath?: string;
}

interface ServerState {
  readonly index: ScipIndex;
  readonly mapper: WorkspaceUriMapper;
}

function parseInitializationOptions(value: unknown): ScipInitializationOptions {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SCIP initializationOptions must be an object.");
  }

  const indexPath = Reflect.get(value, "indexPath");
  if (indexPath !== undefined && typeof indexPath !== "string") {
    throw new Error("SCIP initializationOptions.indexPath must be a string.");
  }

  return indexPath === undefined ? {} : { indexPath };
}

function toScipPosition(position: Position): ScipPosition {
  return {
    line: position.line,
    character: position.character
  };
}

function toRange(range: ScipRange): Range {
  return {
    start: range.start,
    end: range.end
  };
}

function toLocation(mapper: WorkspaceUriMapper, location: ScipLocation): Location {
  return {
    uri: mapper.toDocumentUri(location.relativePath),
    range: toRange(location.range)
  };
}

function markdownCodeBlock(language: string | undefined, text: string): string {
  const safeLanguage = language !== undefined && /^[A-Za-z0-9_+-]+$/.test(language)
    ? language
    : "";
  return `\`\`\`${safeLanguage}\n${text}\n\`\`\``;
}

function toHover(hover: ScipHover): Hover {
  const parts: string[] = [];
  if (hover.signature !== undefined) {
    parts.push(markdownCodeBlock(hover.signatureLanguage, hover.signature));
  }
  parts.push(...hover.documentation);

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join("\n\n")
    },
    range: toRange(hover.range)
  };
}

export function registerScipLanguageServer(
  connection: Connection,
  indexSource: IndexSource
): void {
  let state: ServerState | undefined;

  connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    try {
      const mapper = WorkspaceUriMapper.fromInitializeParams(params);
      const options = parseInitializationOptions(params.initializationOptions);
      const context = options.indexPath === undefined
        ? { workspaceUri: mapper.rootUri }
        : { workspaceUri: mapper.rootUri, configuredIndexPath: options.indexPath };
      const loaded = await indexSource.load(context);
      const index = ScipIndex.fromBytes(loaded.bytes);
      state = { index, mapper };

      const statistics = index.validationReport.statistics;
      connection.console.info(
        `Loaded ${loaded.description}: ${statistics.documentCount} documents, `
        + `${statistics.occurrenceCount} occurrences, ${statistics.definitionCount} definitions.`
      );
      for (const warning of index.validationReport.warnings) {
        connection.console.warn(warning);
      }

      return {
        capabilities: {
          definitionProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          textDocumentSync: TextDocumentSyncKind.None,
          // scip-dotnet currently calculates columns from Roslyn UTF-16 LinePosition
          // values even though its metadata labels the source encoding as UTF-8.
          positionEncoding: PositionEncodingKind.UTF16
        },
        serverInfo: {
          name: "codewise-scip-lsp",
          version: "0.0.1"
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(`Failed to initialize SCIP language server: ${message}`);
      throw new ResponseError(ErrorCodes.InternalError, message);
    }
  });

  connection.onDefinition((params) => {
    const current = requireState(state);
    const relativePath = current.mapper.toRelativePath(params.textDocument.uri);
    if (relativePath === undefined) {
      return null;
    }

    const locations = current.index.definition(relativePath, toScipPosition(params.position));
    return locations.length === 0
      ? null
      : locations.map((location) => toLocation(current.mapper, location));
  });

  connection.onReferences((params) => {
    const current = requireState(state);
    const relativePath = current.mapper.toRelativePath(params.textDocument.uri);
    if (relativePath === undefined) {
      return [];
    }

    return current.index.references(
      relativePath,
      toScipPosition(params.position),
      params.context.includeDeclaration
    ).map((location) => toLocation(current.mapper, location));
  });

  connection.onHover((params) => {
    const current = requireState(state);
    const relativePath = current.mapper.toRelativePath(params.textDocument.uri);
    if (relativePath === undefined) {
      return null;
    }

    const hover = current.index.hover(relativePath, toScipPosition(params.position));
    return hover === undefined ? null : toHover(hover);
  });
}

function requireState(state: ServerState | undefined): ServerState {
  if (state === undefined) {
    throw new ResponseError(
      ErrorCodes.ServerNotInitialized,
      "The SCIP language server has not loaded an index."
    );
  }
  return state;
}

export { ProposedFeatures };

