import {
  type BulkReferenceGroup,
  type BulkReferenceProvider,
  type BulkReferenceResult,
  type Location
} from "@codewise/lsp-crawler";

const protocolVersion = 1;
const handlerName = "Codewise.RoslynExtension.BulkReferencesHandler";
const activationMethod = "server/_vs_activateExtension";
const dispatchMethod = "workspace/_vs_dispatchExtensionMessage";
const bulkRequestTimeoutMilliseconds = 30 * 60_000;
const projectLoadRetryMilliseconds = 2_000;
const projectLoadAttempts = 3;

export function createRoslynBulkReferenceProvider(
  assemblyFilePath: string,
  maxConcurrency: number
): BulkReferenceProvider {
  return {
    name: "roslyn-extension",
    languageIds: new Set(["csharp", "vb"]),
    async populateReferences(client, documents): Promise<BulkReferenceResult> {
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

      const occurrenceCount = documents.reduce(
        (count, document) => count + document.occurrences.length,
        0
      );
      for (let attempt = 1; attempt <= projectLoadAttempts; attempt++) {
        const result = await dispatchBulkRequest();
        if (
          result.groups.length > 0
          || result.unresolvedOccurrenceCount < occurrenceCount
          || attempt === projectLoadAttempts
        ) {
          return result;
        }
        await delay(projectLoadRetryMilliseconds);
      }
      throw new Error("Roslyn bulk reference retry loop did not return a result.");

      async function dispatchBulkRequest(): Promise<BulkReferenceResult> {
        const response = parseDispatchResponse(
          await client.request<unknown>(
            dispatchMethod,
            {
              messageName: handlerName,
              message: JSON.stringify({
                ProtocolVersion: protocolVersion,
                MaxConcurrency: maxConcurrency,
                Documents: documents.map((document) => ({
                  Uri: document.uri,
                  Occurrences: document.occurrences.map((occurrence) => ({
                    Id: occurrence.id,
                    Line: occurrence.position.line,
                    Character: occurrence.position.character
                  }))
                }))
              })
            },
            bulkRequestTimeoutMilliseconds
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
        return parseBulkResponse(response.response);
      }
    }
  };
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

function parseBulkResponse(json: string): BulkReferenceResult {
  const value: unknown = JSON.parse(json);
  if (
    !isObject(value)
    || value["ProtocolVersion"] !== protocolVersion
    || !Array.isArray(value["Groups"])
    || !isNumberArray(value["UnresolvedOccurrenceIds"])
    || !isNonNegativeInteger(value["SolutionProjectCount"])
    || !isNonNegativeInteger(value["SolutionDocumentCount"])
    || typeof value["SymbolResolutionMilliseconds"] !== "number"
    || typeof value["ReferenceSearchMilliseconds"] !== "number"
  ) {
    throw new Error("The Codewise extension returned an invalid bulk response.");
  }

  const groups: BulkReferenceGroup[] = [];
  let failedOccurrenceCount = 0;
  for (const group of value["Groups"]) {
    if (
      !isObject(group)
      || !isNumberArray(group["OccurrenceIds"])
      || !Array.isArray(group["Locations"])
    ) {
      throw new Error("The Codewise extension returned an invalid reference group.");
    }
    if (typeof group["Error"] === "string" && group["Error"].length > 0) {
      failedOccurrenceCount += group["OccurrenceIds"].length;
      continue;
    }
    groups.push({
      occurrenceIds: group["OccurrenceIds"],
      locations: group["Locations"].map(parseLocation)
    });
  }

  return {
    groups,
    unresolvedOccurrenceCount: value["UnresolvedOccurrenceIds"].length,
    failedOccurrenceCount,
    metrics: {
      solutionProjectCount: value["SolutionProjectCount"],
      solutionDocumentCount: value["SolutionDocumentCount"],
      symbolResolutionMilliseconds: value["SymbolResolutionMilliseconds"],
      referenceSearchMilliseconds: value["ReferenceSearchMilliseconds"]
    }
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
    && value.every((item) => Number.isSafeInteger(item) && item >= 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
