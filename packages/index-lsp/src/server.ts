import {
  ErrorCodes,
  PositionEncodingKind,
  ProposedFeatures,
  ResponseError,
  TextDocumentSyncKind,
  type Connection,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Location,
  type Position
} from "vscode-languageserver";
import type {
  CodeIndex,
  IndexLocation,
  IndexPosition
} from "@codewise/index-core";
import type { IndexSource } from "./index-source.js";
import { WorkspaceUriMapper } from "./workspace-uri-mapper.js";

export interface IndexInitializationOptions {
  readonly indexPath?: string;
}

interface ServerState {
  readonly index: CodeIndex;
  readonly mapper: WorkspaceUriMapper;
}

export function registerIndexLanguageServer(
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
        : {
            workspaceUri: mapper.rootUri,
            configuredIndexPath: options.indexPath
          };
      const loaded = await indexSource.load(context);
      state = { index: loaded.index, mapper };
      const statistics = loaded.index.statistics;
      connection.console.info(
        `Loaded ${loaded.description}: ${statistics.documentCount} documents, `
        + `${statistics.occurrenceCount} occurrences, `
        + `${statistics.completedAnswerCount} answers.`
      );

      return {
        capabilities: {
          definitionProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          textDocumentSync: TextDocumentSyncKind.None,
          positionEncoding: PositionEncodingKind.UTF16
        },
        serverInfo: {
          name: "codewise-index-lsp",
          version: "0.0.1"
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(`Failed to initialize Codewise index: ${message}`);
      throw new ResponseError(ErrorCodes.InternalError, message);
    }
  });

  connection.onShutdown(() => {
    state?.index.close();
    state = undefined;
  });

  connection.onDefinition((params) => {
    const current = requireState(state);
    const relativePath = current.mapper.toRelativePath(params.textDocument.uri);
    if (relativePath === undefined) {
      return null;
    }
    const locations = current.index.definition(
      relativePath,
      toIndexPosition(params.position)
    );
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
      toIndexPosition(params.position),
      params.context.includeDeclaration
    ).map((location) => toLocation(current.mapper, location));
  });

  connection.onHover((params): Hover | null => {
    const current = requireState(state);
    const relativePath = current.mapper.toRelativePath(params.textDocument.uri);
    if (relativePath === undefined) {
      return null;
    }
    const hover = current.index.hover(
      relativePath,
      toIndexPosition(params.position)
    );
    return hover === undefined
      ? null
      : {
          contents: hover.contents as Hover["contents"],
          ...(hover.range === undefined ? {} : { range: hover.range })
        };
  });
}

function parseInitializationOptions(value: unknown): IndexInitializationOptions {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codewise initializationOptions must be an object.");
  }
  const indexPath = Reflect.get(value, "indexPath");
  if (indexPath !== undefined && typeof indexPath !== "string") {
    throw new Error("Codewise initializationOptions.indexPath must be a string.");
  }
  return indexPath === undefined ? {} : { indexPath };
}

function toIndexPosition(position: Position): IndexPosition {
  return { line: position.line, character: position.character };
}

function toLocation(
  mapper: WorkspaceUriMapper,
  location: IndexLocation
): Location {
  const uri = location.relativePath === undefined
    ? location.uri
    : mapper.toDocumentUri(location.relativePath);
  if (uri === undefined) {
    throw new Error("An indexed location has neither a relative path nor a URI.");
  }
  return { uri, range: location.range };
}

function requireState(state: ServerState | undefined): ServerState {
  if (state === undefined) {
    throw new ResponseError(
      ErrorCodes.ServerNotInitialized,
      "The Codewise index has not been loaded."
    );
  }
  return state;
}

export { ProposedFeatures };
