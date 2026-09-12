import {
  type Location,
  type SymbolGraphDocument,
  type SymbolGraphProvider,
  type SymbolGraphResult,
  type SymbolGraphSymbol
} from "@codewise/lsp-crawler";

const protocolVersion = 2;
const handlerName = "Codewise.RoslynExtension.SymbolGraphHandler";
const activationMethod = "server/_vs_activateExtension";
const dispatchMethod = "workspace/_vs_dispatchExtensionMessage";
const requestTimeoutMilliseconds = 5 * 60_000;
const projectInitializationTimeoutMilliseconds = 10_000;
const projectLoadRetryMilliseconds = 2_000;
const projectLoadAttempts = 15;
const maximumOccurrencesPerChunk = 50_000;

export function createRoslynSymbolGraphProvider(
  assemblyFilePath: string,
  maximumOccurrencesPerRequest = maximumOccurrencesPerChunk
): SymbolGraphProvider {
  return {
    name: "roslyn-symbol-graph",
    languageIds: new Set(["csharp"]),
    fallbackToLsp: false,
    async populateSymbolGraph(client, documents, onChunk): Promise<void> {
      const occurrenceCount = documents.reduce(
        (count, document) => count + document.occurrences.length,
        0
      );
      if (occurrenceCount === 0) {
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

      const chunks = chunkSymbolGraphDocuments(
        documents,
        maximumOccurrencesPerRequest
      );
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
              "Roslyn did not load any requested documents for symbol binding."
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
                Documents: chunk.map((document) => ({
                  Uri: document.uri,
                  Occurrences: document.occurrences.map((occurrence) => ({
                    Id: occurrence.id,
                    StartLine: occurrence.range.start.line,
                    StartCharacter: occurrence.range.start.character,
                    EndLine: occurrence.range.end.line,
                    EndCharacter: occurrence.range.end.character
                  }))
                }))
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
  documents: readonly SymbolGraphDocument[],
  maximumOccurrences: number
): SymbolGraphDocument[][] {
  if (!Number.isSafeInteger(maximumOccurrences) || maximumOccurrences <= 0) {
    throw new Error("Symbol graph chunk size must be a positive integer.");
  }
  const chunks: SymbolGraphDocument[][] = [];
  let current: SymbolGraphDocument[] = [];
  let currentCount = 0;
  for (const document of documents) {
    let offset = 0;
    while (offset < document.occurrences.length) {
      if (currentCount === maximumOccurrences) {
        chunks.push(current);
        current = [];
        currentCount = 0;
      }
      const count = Math.min(
        maximumOccurrences - currentCount,
        document.occurrences.length - offset
      );
      current.push({
        ...document,
        occurrences: document.occurrences.slice(offset, offset + count)
      });
      offset += count;
      currentCount += count;
    }
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
    || !isNumberArray(value["UnresolvedOccurrenceIds"])
    || !isNonNegativeInteger(value["SolutionProjectCount"])
    || !isNonNegativeInteger(value["SolutionDocumentCount"])
    || !isNonNegativeNumber(value["SymbolResolutionMilliseconds"])
  ) {
    throw new Error("The Codewise extension returned an invalid symbol graph.");
  }

  return {
    symbols: value["Symbols"].map(parseSymbol),
    unresolvedOccurrenceIds: value["UnresolvedOccurrenceIds"],
    metrics: {
      solutionProjectCount: value["SolutionProjectCount"],
      solutionDocumentCount: value["SolutionDocumentCount"],
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
    occurrences: value["Occurrences"].map((edge) => {
      if (
        !isObject(edge)
        || !isNonNegativeInteger(edge["OccurrenceId"])
        || typeof edge["IsDefinition"] !== "boolean"
      ) {
        throw new Error("The Codewise extension returned an invalid symbol edge.");
      }
      return {
        occurrenceId: edge["OccurrenceId"],
        isDefinition: edge["IsDefinition"]
      };
    }),
    definitions: value["Definitions"].map(parseLocation)
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

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every((item) => isNonNegativeInteger(item));
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
