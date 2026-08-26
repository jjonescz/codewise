import { create, toBinary } from "@bufbuild/protobuf";
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  SignatureSchema,
  SymbolInformationSchema,
  SymbolRole
} from "@scip-code/scip";

export const fixtureSymbol = "scip-dotnet nuget demo 1.0 Demo/Widget#";

export function createFixtureIndexBytes(): Uint8Array {
  return toBinary(IndexSchema, create(IndexSchema, {
    documents: [
      create(DocumentSchema, {
        language: "csharp",
        relativePath: "src/Widget.cs",
        occurrences: [
          create(OccurrenceSchema, {
            range: [0, 13, 19],
            symbol: fixtureSymbol,
            symbolRoles: SymbolRole.Definition
          }),
          create(OccurrenceSchema, {
            range: [3, 8, 14],
            symbol: fixtureSymbol
          })
        ],
        symbols: [
          create(SymbolInformationSchema, {
            symbol: fixtureSymbol,
            documentation: ["A demo widget."],
            signatureDocumentation: create(SignatureSchema, {
              language: "csharp",
              text: "class Widget"
            })
          })
        ],
        text: [
          "public class Widget {}",
          "",
          "void M() {",
          "    _ = Widget;",
          "}"
        ].join("\n")
      })
    ]
  }));
}

