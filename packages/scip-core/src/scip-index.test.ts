import { create, toBinary } from "@bufbuild/protobuf";
import {
  DocumentSchema,
  IndexSchema,
  MultiLineRangeSchema,
  OccurrenceSchema,
  SignatureSchema,
  SingleLineRangeSchema,
  SymbolInformationSchema,
  SymbolRole
} from "@scip-code/scip";
import { describe, expect, it } from "vitest";
import { ScipIndex, ScipIndexError } from "./index.js";

const symbol = "scip-dotnet nuget demo 1.0 Demo/Widget#";

function createIndexBytes(): Uint8Array {
  const definition = create(OccurrenceSchema, {
    range: [0, 13, 19],
    symbol,
    symbolRoles: SymbolRole.Definition
  });
  const reference = create(OccurrenceSchema, {
    typedRange: {
      case: "singleLineRange",
      value: create(SingleLineRangeSchema, {
        line: 3,
        startCharacter: 8,
        endCharacter: 14
      })
    },
    symbol
  });
  const nestedReference = create(OccurrenceSchema, {
    range: [3, 8, 3, 12],
    symbol: "local nested",
    overrideDocumentation: ["Nested documentation"]
  });
  const symbolInformation = create(SymbolInformationSchema, {
    symbol,
    documentation: ["A demo widget."],
    signatureDocumentation: create(SignatureSchema, {
      language: "csharp",
      text: "class Widget"
    })
  });

  return toBinary(IndexSchema, create(IndexSchema, {
    documents: [
      create(DocumentSchema, {
        language: "csharp",
        relativePath: "src\\Widget.cs",
        occurrences: [definition, reference, nestedReference],
        symbols: [symbolInformation]
      })
    ]
  }));
}

describe("ScipIndex", () => {
  it("queries definitions and normalizes document paths", () => {
    const index = ScipIndex.fromBytes(createIndexBytes());

    expect(index.definition("src/Widget.cs", { line: 3, character: 13 })).toEqual([
      {
        relativePath: "src/Widget.cs",
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 19 }
        }
      }
    ]);
    expect(index.validationReport.warnings[0]).toContain("backslashes");
  });

  it("honors includeDeclaration for references", () => {
    const index = ScipIndex.fromBytes(createIndexBytes());

    expect(index.references("src/Widget.cs", { line: 0, character: 14 }, false))
      .toHaveLength(1);
    expect(index.references("src/Widget.cs", { line: 0, character: 14 }, true))
      .toHaveLength(2);
  });

  it("returns SCIP signature and documentation for hover", () => {
    const index = ScipIndex.fromBytes(createIndexBytes());

    expect(index.hover("src/Widget.cs", { line: 3, character: 13 })).toMatchObject({
      signature: "class Widget",
      signatureLanguage: "csharp",
      documentation: ["A demo widget."]
    });
  });

  it("selects the narrowest containing occurrence", () => {
    const index = ScipIndex.fromBytes(createIndexBytes());

    expect(index.hover("src/Widget.cs", { line: 3, character: 9 })).toMatchObject({
      documentation: ["Nested documentation"]
    });
  });

  it("decodes typed multi-line ranges", () => {
    const occurrence = create(OccurrenceSchema, {
      typedRange: {
        case: "multiLineRange",
        value: create(MultiLineRangeSchema, {
          startLine: 2,
          startCharacter: 4,
          endLine: 3,
          endCharacter: 7
        })
      },
      symbol
    });
    const bytes = toBinary(IndexSchema, create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: "Typed.cs",
          occurrences: [occurrence]
        })
      ]
    }));

    const index = ScipIndex.fromBytes(bytes);
    expect(index.references("Typed.cs", { line: 3, character: 1 }, true)).toHaveLength(1);
  });

  it("rejects traversal paths", () => {
    const bytes = toBinary(IndexSchema, create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: "../Outside.cs"
        })
      ]
    }));

    expect(() => ScipIndex.fromBytes(bytes)).toThrowError(ScipIndexError);
  });

  it("rejects malformed occurrence ranges", () => {
    const bytes = toBinary(IndexSchema, create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: "Broken.cs",
          occurrences: [
            create(OccurrenceSchema, {
              range: [1, 2],
              symbol
            })
          ]
        })
      ]
    }));

    expect(() => ScipIndex.fromBytes(bytes)).toThrow(/three or four/);
  });
});
