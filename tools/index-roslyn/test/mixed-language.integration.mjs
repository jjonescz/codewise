import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { CodeIndex } from "@codewise/index-core";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const files = {
  "Mixed.slnx": `<Solution>
  <Project Path="CSharpApi/CSharpApi.csproj" />
  <Project Path="VisualBasic/VisualBasic.vbproj" />
  <Project Path="CSharpCaller/CSharpCaller.csproj" />
</Solution>
`,
  "CSharpApi/CSharpApi.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
  "CSharpApi/CSharpApi.cs": `namespace Mixed;

public static class CSharpApi
{
    public static int Increment(int amount) => amount + 1;
    public static int Increment(string amount) => amount.Length;
    public static T Echo<T>(T item) => item;
}

public sealed class CSharpBox<T>
{
    public T BoxEcho(T item) => item;
}
`,
  "VisualBasic/VisualBasic.vbproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace></RootNamespace>
    <OptionStrict>On</OptionStrict>
    <DefineConstants>$(DefineConstants),INDEX_FLAVOR=&quot;mixed/path/&quot;,INDEX_VERSION=3</DefineConstants>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../CSharpApi/CSharpApi.csproj" />
  </ItemGroup>
</Project>
`,
  "VisualBasic/VbApi.vb": `#If DEBUG AndAlso NET10_0 AndAlso INDEX_FLAVOR = "mixed/path/" AndAlso INDEX_VERSION = 3 Then
Namespace Mixed
    Public Class VbApi
        Public Shared Function Compute(value As Integer) As Integer
            Dim nextValue = CSharpApi.Increment(amount:=value)
            Return nextValue + NEXTVALUE
        End Function

        Public Shared Function Echo(Of T)(item As T) As T
            Return CSharpApi.Echo(Of T)(item:=item)
        End Function

        Public Shared Function UseBox(box As CSharpBox(Of Integer)) As Integer
            Return box.BoxEcho(item:=4)
        End Function

        ''' <summary>First <see cref="VbApi.Echo(Of T)(T)"/>.</summary>
        Public Shared Sub DocumentFirst()
        End Sub

        ''' <summary>Second <see cref="VbApi.Echo(Of T)(T)"/>.</summary>
        Public Shared Sub DocumentSecond()
        End Sub

        ''' <summary>CSharp <see cref="CSharpApi.Echo(Of T)(T)"/>.</summary>
        Public Shared Sub DocumentCSharp()
        End Sub
    End Class

    Public Class VbBox(Of T)
        Public Function BoxEcho(item As T) As T
            Return item
        End Function
    End Class
End Namespace
#End If
`,
  "CSharpCaller/CSharpCaller.csproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../VisualBasic/VisualBasic.vbproj" />
  </ItemGroup>
</Project>
`,
  "CSharpCaller/Caller.cs": `namespace Mixed;

public static class Caller
{
    public static int Run() => VbApi.Compute(value: 1);
    public static int RunGeneric() => VbApi.Echo<int>(item: 2);
    public static int RunBox(VbBox<int> box) => box.BoxEcho(item: 3);
}
`,
  "Loose/Unloaded.cs": "public class UnloadedCSharp {}\n",
  "Loose/Unloaded.vb": "Public Class UnloadedVisualBasic\nEnd Class\n"
};

describe("Roslyn mixed-language symbol graph", () => {
  let directory;
  let index;
  let log;
  let manifest;
  const vbPath = "VisualBasic/VbApi.vb";
  const csharpPath = "CSharpApi/CSharpApi.cs";
  const callerPath = "CSharpCaller/Caller.cs";

  beforeAll(async () => {
    // The CLI records Git HEAD, so keep the disposable workspace in the checkout.
    directory = await mkdtemp(join(repositoryRoot, ".codewise-mixed-test-"));
    const { stdout: sdkVersion } = await execute("dotnet", ["--version"], {
      cwd: repositoryRoot,
      windowsHide: true
    });
    await writeFile(join(directory, "global.json"), JSON.stringify({
      sdk: { version: sdkVersion.trim() }
    }));
    for (const [path, contents] of Object.entries(files)) {
      const absolutePath = resolve(directory, ...path.split("/"));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }
    await execute("dotnet", ["build", "Mixed.slnx", "--nologo", "-bl:{}"], {
      cwd: directory,
      windowsHide: true,
      timeout: 60_000
    });
    const databasePath = join(directory, "artifacts", "index.db");
    await execute(process.execPath, [
      join(repositoryRoot, "tools", "index-roslyn", "dist", "cli.js"),
      "--workspace-root", directory,
      "--database", databasePath,
      "--roslyn-symbol-graph"
    ], {
      cwd: repositoryRoot,
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024
    });

    log = await readFile(join(directory, "artifacts", "lsp-crawler.log"), "utf8");
    manifest = JSON.parse(await readFile(
      join(directory, "artifacts", "manifest.json"),
      "utf8"
    ));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    index = new CodeIndex({
      all: (sql, parameters = []) => database.prepare(sql).all(...parameters),
      close: () => database.close()
    });
  }, 120_000);

  beforeEach(() => {
    onTestFailed(() => console.error(log));
  });

  afterAll(async () => {
    try {
      index?.close();
    } finally {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("indexes VB locals and connects C#/VB definitions and references", () => {
    expect(manifest.statistics.documentCount).toBe(5);
    expect(manifest.recoveredRequestFailures).toBe(0);
    expect(manifest.symbolGraph).toMatchObject({
      status: "used",
      metrics: {
        processedDocumentCount: 3,
        missingDocumentCount: 2,
        failedDocumentCount: 0
      }
    });
    expect(manifest.requestStatistics.filter(
      (entry) => entry.method.startsWith("textDocument/")
        && !entry.method.startsWith("textDocument/semanticTokens/")
    )).toEqual([]);
    expect(log).not.toContain("Syntax tree is required");

    expectSymbol(index, locationOf(csharpPath, "Increment(int", "Increment"), [
      locationOf(vbPath, "CSharpApi.Increment", "Increment")
    ]);
    expectSymbol(index, locationOf(vbPath, "Function Compute", "Compute"), [
      locationOf(callerPath, "VbApi.Compute", "Compute")
    ]);
    expectSymbol(index, locationOf(csharpPath, "Increment(int", "amount"), [
      locationOf(csharpPath, "Increment(int", "amount", 1),
      locationOf(vbPath, "amount:=value", "amount")
    ]);
    expectSymbol(index, locationOf(vbPath, "Function Compute", "value"), [
      locationOf(vbPath, "amount:=value", "value"),
      locationOf(callerPath, "Compute(value:", "value")
    ]);
    expectSymbol(index, locationOf(vbPath, "Dim nextValue", "nextValue"), [
      locationOf(vbPath, "Return nextValue", "nextValue"),
      locationOf(vbPath, "Return nextValue", "NEXTVALUE")
    ]);
    expect(index.hover(vbPath, positionOf(vbPath, "Function Compute", "Compute")))
      .toBeDefined();
  });

  it("captures C# and VB highlighting with one semantic-token request per loaded document", () => {
    const requests = manifest.requestStatistics.filter(
      (entry) => entry.method.startsWith("textDocument/semanticTokens/")
    );
    expect(requests.reduce((count, entry) => count + entry.requestCount, 0))
      .toBe(manifest.symbolGraph.metrics.processedDocumentCount);
    expect(index.semanticTokens("Loose/Unloaded.cs")).toBeUndefined();
    expect(index.semanticTokens("Loose/Unloaded.vb")).toBeUndefined();
    for (const request of requests) {
      expect(["textDocument/semanticTokens/full", "textDocument/semanticTokens/range"])
        .toContain(request.method);
      expect(request.failed).toBe(0);
      expect(request.succeeded).toBe(request.requestCount);
    }
    for (const path of [csharpPath, vbPath, callerPath]) {
      const tokens = index.semanticTokens(path);
      expect(tokens).toBeDefined();
      expect(tokens.contentHash).toBe(createHash("sha256").update(files[path]).digest("hex"));
      expect(tokens.data.length).toBeGreaterThan(0);
      expect(tokens.data.length % 5).toBe(0);
    }
    for (const [path, fragment, token, type] of [
      [csharpPath, "public sealed class CSharpBox", "CSharpBox", "class"],
      [csharpPath, "public sealed class CSharpBox", "class", "keyword"],
      [csharpPath, "static T Echo<T>", "T", "typeParameter"],
      [csharpPath, "Increment(int amount)", "1", "number"],
      [vbPath, "Public Class VbApi", "VbApi", "class"],
      [vbPath, "Dim nextValue", "nextValue", "variable"],
      [callerPath, "public static class Caller", "Caller", "class"]
    ]) {
      expectSemanticToken(index, path, positionOf(path, fragment, token), type);
    }
  });

  it("keeps generic type, method, and value parameters scoped to their owners", () => {
    for (const [definition, references] of [
      [
        locationOf(csharpPath, "CSharpBox<T>", "T"),
        [
          locationOf(csharpPath, "public T BoxEcho", "T"),
          locationOf(csharpPath, "public T BoxEcho", "T", 1)
        ]
      ],
      [
        locationOf(csharpPath, "static T Echo<T>", "T", 1),
        [
          locationOf(csharpPath, "static T Echo<T>", "T"),
          locationOf(csharpPath, "static T Echo<T>", "T", 2)
        ]
      ],
      [
        locationOf(vbPath, "Class VbBox(Of T)", "T"),
        [
          locationOf(vbPath, "Function BoxEcho", "T"),
          locationOf(vbPath, "Function BoxEcho", "T", 1)
        ]
      ],
      [
        locationOf(vbPath, "Function Echo(Of T)", "T"),
        [
          locationOf(vbPath, "Function Echo(Of T)", "T", 1),
          locationOf(vbPath, "Function Echo(Of T)", "T", 2),
          locationOf(vbPath, "Return CSharpApi.Echo", "T")
        ]
      ],
      [
        locationOf(csharpPath, "static T Echo<T>", "item"),
        [
          locationOf(csharpPath, "static T Echo<T>", "item", 1),
          locationOf(vbPath, "Return CSharpApi.Echo", "item")
        ]
      ],
      [
        locationOf(vbPath, "Function Echo(Of T)", "item"),
        [
          locationOf(vbPath, "Return CSharpApi.Echo", "item", 1),
          locationOf(callerPath, "RunGeneric()", "item")
        ]
      ],
      [
        locationOf(csharpPath, "public T BoxEcho", "item"),
        [
          locationOf(csharpPath, "public T BoxEcho", "item", 1),
          locationOf(vbPath, "Return box.BoxEcho", "item")
        ]
      ],
      [
        locationOf(vbPath, "Function BoxEcho", "item"),
        [
          locationOf(vbPath, "Return item", "item"),
          locationOf(callerPath, "RunBox(", "item")
        ]
      ]
    ]) {
      expectSymbol(index, definition, references);
    }
  });

  it("indexes generic VB cref trivia without merging unrelated T placeholders", () => {
    for (const comment of ["First <see", "Second <see", "CSharp <see"]) {
      expectSymbol(
        index,
        locationOf(vbPath, comment, "T"),
        [locationOf(vbPath, comment, "T", 1)]
      );
    }
    // Roslyn binds both the name and the VB Of keyword to the generic method.
    expectSymbol(index, locationOf(vbPath, "Function Echo(Of T)", "Echo"), [
      locationOf(callerPath, "RunGeneric()", "Echo"),
      locationOf(vbPath, "First <see", "Echo"),
      locationOf(vbPath, "First <see", "Of"),
      locationOf(vbPath, "Second <see", "Echo"),
      locationOf(vbPath, "Second <see", "Of")
    ]);
    expectSymbol(index, locationOf(csharpPath, "static T Echo<T>", "Echo"), [
      locationOf(vbPath, "Return CSharpApi.Echo", "Echo"),
      locationOf(vbPath, "Return CSharpApi.Echo", "Of"),
      locationOf(vbPath, "CSharp <see", "Echo"),
      locationOf(vbPath, "CSharp <see", "Of")
    ]);
  });
});

function positionOf(path, lineFragment, token, occurrence = 0) {
  const lines = files[path].split("\n");
  const line = lines.findIndex((text) => text.includes(lineFragment));
  expect(line).toBeGreaterThanOrEqual(0);
  let character = -1;
  for (let index = 0; index <= occurrence; index++) {
    character = lines[line].indexOf(token, character + 1);
    expect(character).toBeGreaterThanOrEqual(0);
  }
  return { line, character };
}

function locationOf(path, lineFragment, token, occurrence = 0) {
  const start = positionOf(path, lineFragment, token, occurrence);
  return {
    relativePath: path,
    range: {
      start,
      end: { line: start.line, character: start.character + token.length }
    }
  };
}

function expectSemanticToken(index, path, position, type) {
  const tokens = index.semanticTokens(path);
  const legend = index.semanticTokensLegend;
  expect(tokens).toBeDefined();
  expect(legend).toBeDefined();
  let line = 0;
  let character = 0;
  let actualType;
  for (let offset = 0; offset < tokens.data.length; offset += 5) {
    const deltaLine = tokens.data[offset];
    line += deltaLine;
    character = deltaLine === 0 ? character + tokens.data[offset + 1]
      : tokens.data[offset + 1];
    if (line === position.line && character === position.character) {
      actualType = legend.tokenTypes[tokens.data[offset + 3]];
      break;
    }
  }
  expect(actualType, `${path}:${position.line}:${position.character}`).toBe(type);
}

function expectSymbol(index, definition, references) {
  const locations = (values) => values
    .map(({ relativePath, range }) => ({ relativePath, range }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (const occurrence of [definition, ...references]) {
    expect(locations(index.definition(occurrence.relativePath, occurrence.range.start)))
      .toEqual([definition]);
    expect(locations(index.references(occurrence.relativePath, occurrence.range.start, false)))
      .toEqual(locations(references));
    expect(locations(index.references(occurrence.relativePath, occurrence.range.start, true)))
      .toEqual(locations([definition, ...references]));
  }
}
