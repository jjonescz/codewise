import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
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
}
`,
  "VisualBasic/VisualBasic.vbproj": `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <RootNamespace></RootNamespace>
    <OptionStrict>On</OptionStrict>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../CSharpApi/CSharpApi.csproj" />
  </ItemGroup>
</Project>
`,
  "VisualBasic/VbApi.vb": `Namespace Mixed
    Public Class VbApi
        Public Shared Function Compute(value As Integer) As Integer
            Dim nextValue = CSharpApi.Increment(amount:=value)
            Return nextValue + NEXTVALUE
        End Function
    End Class
End Namespace
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
}
`
};

describe("Roslyn mixed-language symbol graph", () => {
  it("indexes VB locals and connects C#/VB definitions and references", async () => {
    // The CLI records Git HEAD, so keep the disposable workspace in the checkout.
    const directory = await mkdtemp(join(repositoryRoot, ".codewise-mixed-test-"));
    try {
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
      await execute("dotnet", ["build", "Mixed.slnx", "--nologo"], {
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

      const manifest = JSON.parse(await readFile(
        join(directory, "artifacts", "manifest.json"),
        "utf8"
      ));
      expect(manifest.statistics.documentCount).toBe(3);
      expect(manifest.recoveredRequestFailures).toBe(0);
      expect(manifest.symbolGraph).toMatchObject({
        status: "used",
        metrics: {
          processedDocumentCount: 3,
          missingDocumentCount: 0,
          failedDocumentCount: 0
        }
      });
      expect(manifest.requestStatistics.filter(
        (entry) => entry.method.startsWith("textDocument/")
      )).toEqual([]);
      expect(await readFile(join(directory, "artifacts", "lsp-crawler.log"), "utf8"))
        .not.toContain("Syntax tree is required");

      const database = new DatabaseSync(databasePath, { readOnly: true });
      const index = new CodeIndex({
        all: (sql, parameters = []) => database.prepare(sql).all(...parameters),
        close: () => database.close()
      });
      try {
        const vbPath = "VisualBasic/VbApi.vb";
        const csharpPath = "CSharpApi/CSharpApi.cs";
        const callerPath = "CSharpCaller/Caller.cs";
        const csharpDefinition = positionOf(csharpPath, "Increment(int", "Increment");
        const vbDefinition = positionOf(vbPath, "Function Compute", "Compute");

        expect(index.definition(
          vbPath,
          positionOf(vbPath, "CSharpApi.Increment", "Increment")
        )).toEqual([expect.objectContaining({
          relativePath: csharpPath,
          range: expect.objectContaining({ start: csharpDefinition })
        })]);
        expect(index.references(csharpPath, csharpDefinition, false))
          .toEqual([expect.objectContaining({ relativePath: vbPath })]);
        expect(index.definition(
          callerPath,
          positionOf(callerPath, "VbApi.Compute", "Compute")
        )).toEqual([expect.objectContaining({
          relativePath: vbPath,
          range: expect.objectContaining({ start: vbDefinition })
        })]);
        expect(index.references(vbPath, vbDefinition, false))
          .toEqual([expect.objectContaining({ relativePath: callerPath })]);
        expect(index.definition(
          vbPath,
          positionOf(vbPath, "amount:=value", "amount")
        )).toEqual([expect.objectContaining({
          relativePath: csharpPath,
          range: expect.objectContaining({
            start: positionOf(csharpPath, "Increment(int", "amount")
          })
        })]);
        expect(index.definition(
          callerPath,
          positionOf(callerPath, "Compute(value:", "value")
        )).toEqual([expect.objectContaining({
          relativePath: vbPath,
          range: expect.objectContaining({
            start: positionOf(vbPath, "Function Compute", "value")
          })
        })]);
        expect(index.references(
          vbPath,
          positionOf(vbPath, "Dim nextValue", "nextValue"),
          false
        )).toHaveLength(2);
        expect(index.definition(
          vbPath,
          positionOf(vbPath, "Return nextValue", "NEXTVALUE")
        )).toEqual([expect.objectContaining({
          relativePath: vbPath,
          range: expect.objectContaining({
            start: positionOf(vbPath, "Dim nextValue", "nextValue")
          })
        })]);
        expect(index.hover(vbPath, vbDefinition)).toBeDefined();
      } finally {
        index.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function positionOf(path, lineFragment, token) {
  const lines = files[path].split("\n");
  const line = lines.findIndex((text) => text.includes(lineFragment));
  expect(line).toBeGreaterThanOrEqual(0);
  const character = lines[line].indexOf(token);
  expect(character).toBeGreaterThanOrEqual(0);
  return { line, character };
}
