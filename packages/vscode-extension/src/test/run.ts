import { strict as assert } from "node:assert";
import * as vscode from "vscode";

const roslynRoot = process.env["ROSLYN_ROOT"] ?? "C:\\roslyn-3";

export async function run(): Promise<void> {
  const matchingExtensions = vscode.extensions.all.filter(
    (candidate) => candidate.packageJSON["name"] === "codewise"
  );
  const extension = matchingExtensions[0];
  assert(
    matchingExtensions.length === 1 && extension !== undefined,
    `Expected one Codewise extension; found: ${
      matchingExtensions.map((candidate) => candidate.id).join(", ") || "none"
    }.`
  );
  await extension.activate();

  const sourceUri = vscode.Uri.file(
    `${roslynRoot}\\src\\Compilers\\CSharp\\Portable\\Compilation\\AttributeSemanticModel.cs`
  );
  const document = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(document);
  const position = new vscode.Position(122, 60);

  const definitions = await vscode.commands.executeCommand<
    Array<vscode.Location | vscode.LocationLink>
  >("vscode.executeDefinitionProvider", sourceUri, position);
  assert(Array.isArray(definitions), "Definition provider did not return an array.");
  assert(
    definitions.some((definition) => {
      if (definition instanceof vscode.Location) {
        return (
          definition.uri.path.endsWith("/Compilation/CSharpCompilation.cs")
          && definition.range.start.line === 43
          && definition.range.start.character === 32
        );
      }
      return (
        definition.targetUri.path.endsWith("/Compilation/CSharpCompilation.cs")
        && definition.targetRange.start.line === 43
        && definition.targetRange.start.character === 32
      );
    }),
    "CSharpCompilation definition was not returned."
  );

  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    sourceUri,
    position
  );
  assert(
    Array.isArray(references) && references.length >= 10,
    `Expected at least 10 CSharpCompilation references; found ${references?.length ?? 0}.`
  );

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    sourceUri,
    position
  );
  assert(Array.isArray(hovers) && hovers.length > 0, "No CSharpCompilation hover was returned.");
  const hoverText = hovers.flatMap((hover) => hover.contents).map((content) => (
    typeof content === "string" ? content : content.value
  )).join("\n");
  assert(hoverText.includes("CSharpCompilation"), "Hover did not describe CSharpCompilation.");

  console.log(JSON.stringify({
    definitionCount: definitions.length,
    referenceCount: references.length,
    hoverCount: hovers.length
  }));
}
