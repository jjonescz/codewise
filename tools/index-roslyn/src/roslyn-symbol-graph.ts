import {
  type Location,
  type SymbolGraphDocument,
  type SymbolGraphDocumentFailure,
  type SymbolGraphProvider,
  type SymbolGraphResult,
  type SymbolGraphSymbol
} from "@codewise/lsp-crawler";

const protocolVersion = 3;
const handlerName = "Codewise.RoslynExtension.SymbolGraphHandler";
const activationMethod = "server/_vs_activateExtension";
const dispatchMethod = "workspace/_vs_dispatchExtensionMessage";
const requestTimeoutMilliseconds = 5 * 60_000;
const projectInitializationTimeoutMilliseconds = 10_000;
const projectLoadRetryMilliseconds = 2_000;
const projectLoadAttempts = 15;
const maximumDocumentsPerChunk = 64;
const maximumSourceBytesPerChunk = 2 * 1024 * 1024;

export function createRoslynSymbolGraphProvider(
  assemblyFilePath: string
): SymbolGraphProvider {
  return {
    name: "roslyn-symbol-graph",
    languageIds: new Set(["csharp"]),
    async populateSymbolGraph(client, documents, onChunk): Promise<void> {
      if (documents.length === 0) {
        return;
      }
      const projectInitializationCompleted = await client.waitForNotification(
        "workspace/projectInitializationComplete",
        projectInitializationTimeoutMilliseconds
      );
      const activation = parseActivationResponse(
        await client.request<unknown>(
          activationMethod,
          { assemblyFilePath }
        )
      );
      if (activation.extensionException !== undefined) {
        throw new Error(
          `Roslyn rejected the Codewise extension: ${
            formatExtensionException(activation.extensionException)
          }`
        );
      }
      if (!activation.workspaceMessageHandlers.includes(handlerName)) {
        throw new Error(
          `Roslyn activated the extension but did not discover ${handlerName}.`
        );
      }

      const chunks = chunkSymbolGraphDocuments(documents);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        const attempts = index === 0 && projectInitializationCompleted
          ? projectLoadAttempts
          : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const result = await dispatchSymbolGraphRequest(chunk);
          const projectCount =
            result.metrics?.["solutionProjectCount"] ?? 0;
          if (projectCount > 0) {
            onChunk(result);
            break;
          }
          if (attempt === attempts) {
            throw new Error(
              "Roslyn did not load any requested documents for symbol indexing."
            );
          }
          await delay(projectLoadRetryMilliseconds);
        }
      }

      async function dispatchSymbolGraphRequest(
        chunk: readonly SymbolGraphDocument[]
      ): Promise<SymbolGraphResult> {
        const response = parseDispatchResponse(
          await client.request<unknown>(
            dispatchMethod,
            {
              messageName: handlerName,
              message: JSON.stringify({
                ProtocolVersion: protocolVersion,
                Documents: chunk.map((document) => ({ Uri: document.uri }))
              })
            },
            requestTimeoutMilliseconds
          )
        );
        if (response.extensionWasUnloaded) {
          throw new Error("Roslyn unloaded the Codewise extension during indexing.");
        }
        if (response.extensionException !== undefined) {
          throw new Error(
            `The Codewise extension failed: ${
              formatExtensionException(response.extensionException)
            }`
          );
        }
        if (response.response === undefined) {
          throw new Error("The Codewise extension returned no response.");
        }
        return parseSymbolGraphResponse(response.response);
      }
    }
  };
}

export function chunkSymbolGraphDocuments(
  documents: readonly SymbolGraphDocument[]
): SymbolGraphDocument[][] {
  const chunks: SymbolGraphDocument[][] = [];
  let current: SymbolGraphDocument[] = [];
  let currentBytes = 0;
  for (const document of documents) {
    if (
      current.length > 0
      && (
        current.length === maximumDocumentsPerChunk
        || currentBytes + document.contentLength > maximumSourceBytesPerChunk
      )
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(document);
    currentBytes += document.contentLength;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function parseActivationResponse(value: unknown): {
  readonly workspaceMessageHandlers: readonly string[];
  readonly extensionException?: unknown;
} {
  if (
    !isObject(value)
    || !isStringArray(value["workspaceMessageHandlers"])
  ) {
    throw new Error("Roslyn returned an invalid extension activation response.");
  }
  return {
    workspaceMessageHandlers: value["workspaceMessageHandlers"],
    ...("extensionException" in value
      ? { extensionException: value["extensionException"] }
      : {})
  };
}

function parseDispatchResponse(value: unknown): {
  readonly response?: string;
  readonly extensionWasUnloaded: boolean;
  readonly extensionException?: unknown;
} {
  if (
    !isObject(value)
    || (
      "response" in value
      && value["response"] !== null
      && typeof value["response"] !== "string"
    )
    || (
      "extensionWasUnloaded" in value
      && typeof value["extensionWasUnloaded"] !== "boolean"
    )
  ) {
    throw new Error("Roslyn returned an invalid extension dispatch response.");
  }
  return {
    ...(typeof value["response"] === "string"
      ? { response: value["response"] }
      : {}),
    extensionWasUnloaded: value["extensionWasUnloaded"] === true,
    ...("extensionException" in value
      ? { extensionException: value["extensionException"] }
      : {})
  };
}

function parseSymbolGraphResponse(json: string): SymbolGraphResult {
  const value: unknown = JSON.parse(json);
  if (
    !isObject(value)
    || value["ProtocolVersion"] !== protocolVersion
    || !Array.isArray(value["Symbols"])
    || !isStringArray(value["ProcessedDocumentUris"])
    || !isStringArray(value["MissingDocumentUris"])
    || !Array.isArray(value["Failures"])
    || !isNonNegativeInteger(value["SolutionProjectCount"])
    || !isNonNegativeInteger(value["SolutionDocumentCount"])
    || !isNonNegativeNumber(value["TokenCount"])
    || !isNonNegativeNumber(value["OccurrenceCount"])
    || !isNonNegativeNumber(value["SymbolResolutionMilliseconds"])
  ) {
    throw new Error("The Codewise extension returned an invalid symbol graph.");
  }

  return {
    symbols: value["Symbols"].map(parseSymbol),
    processedDocumentUris: value["ProcessedDocumentUris"],
    missingDocumentUris: value["MissingDocumentUris"],
    failures: value["Failures"].map(parseFailure),
    metrics: {
      solutionProjectCount: value["SolutionProjectCount"],
      solutionDocumentCount: value["SolutionDocumentCount"],
      tokenCount: value["TokenCount"],
      occurrenceCount: value["OccurrenceCount"],
      symbolResolutionMilliseconds: value["SymbolResolutionMilliseconds"]
    }
  };
}

function parseSymbol(value: unknown): SymbolGraphSymbol {
  if (
    !isObject(value)
    || typeof value["ProviderKey"] !== "string"
    || value["ProviderKey"].length === 0
    || typeof value["DisplayName"] !== "string"
    || !Array.isArray(value["Occurrences"])
    || !Array.isArray(value["Definitions"])
  ) {
    throw new Error("The Codewise extension returned an invalid symbol.");
  }
  return {
    providerKey: value["ProviderKey"],
    displayName: value["DisplayName"],
    occurrences: value["Occurrences"].map((occurrence) => {
      if (
        !isObject(occurrence)
        || typeof occurrence["Uri"] !== "string"
        || !isNonNegativeInteger(occurrence["StartLine"])
        || !isNonNegativeInteger(occurrence["StartCharacter"])
        || !isNonNegativeInteger(occurrence["EndLine"])
        || !isNonNegativeInteger(occurrence["EndCharacter"])
        || typeof occurrence["IsDefinition"] !== "boolean"
      ) {
        throw new Error(
          "The Codewise extension returned an invalid symbol occurrence."
        );
      }
      return {
        uri: occurrence["Uri"],
        range: {
          start: {
            line: occurrence["StartLine"],
            character: occurrence["StartCharacter"]
          },
          end: {
            line: occurrence["EndLine"],
            character: occurrence["EndCharacter"]
          }
        },
        isDefinition: occurrence["IsDefinition"]
      };
    }),
    definitions: value["Definitions"].map(parseLocation)
  };
}

function parseFailure(value: unknown): SymbolGraphDocumentFailure {
  if (
    !isObject(value)
    || typeof value["Uri"] !== "string"
    || typeof value["Message"] !== "string"
  ) {
    throw new Error("The Codewise extension returned an invalid document failure.");
  }
  return {
    uri: value["Uri"],
    message: value["Message"]
  };
}

function parseLocation(value: unknown): Location {
  if (
    !isObject(value)
    || typeof value["Uri"] !== "string"
    || !isNonNegativeInteger(value["StartLine"])
    || !isNonNegativeInteger(value["StartCharacter"])
    || !isNonNegativeInteger(value["EndLine"])
    || !isNonNegativeInteger(value["EndCharacter"])
  ) {
    throw new Error("The Codewise extension returned an invalid location.");
  }
  return {
    uri: value["Uri"],
    range: {
      start: {
        line: value["StartLine"],
        character: value["StartCharacter"]
      },
      end: {
        line: value["EndLine"],
        character: value["EndCharacter"]
      }
    }
  };
}

function formatExtensionException(value: unknown): string {
  if (isObject(value) && typeof value["Message"] === "string") {
    return value["Message"];
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
