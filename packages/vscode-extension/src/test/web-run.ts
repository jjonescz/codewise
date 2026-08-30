import * as vscode from "vscode";

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder !== undefined, "The web extension test workspace was not opened.");

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

  const sourceUri = vscode.Uri.joinPath(workspaceFolder.uri, "src", "Widget.cs");
  const openedDocument = await vscode.workspace.openTextDocument(sourceUri);
  const document = await vscode.languages.setTextDocumentLanguage(
    openedDocument,
    "csharp"
  );
  await vscode.window.showTextDocument(document);
  const position = new vscode.Position(3, 10);

  const definitions = await vscode.commands.executeCommand<
    Array<vscode.Location | vscode.LocationLink>
  >("vscode.executeDefinitionProvider", sourceUri, position);
  assert(Array.isArray(definitions), "Definition provider did not return an array.");
  assert(definitions.length === 1, `Expected one definition; found ${definitions.length}.`);

  const definition = definitions[0]!;
  const definitionUri = definition instanceof vscode.Location
    ? definition.uri
    : definition.targetUri;
  const definitionRange = definition instanceof vscode.Location
    ? definition.range
    : definition.targetRange;
  assert(
    definitionUri.toString() === sourceUri.toString()
      && definitionRange.start.line === 0
      && definitionRange.start.character === 13,
    "Widget definition was not returned at the expected location."
  );

  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    sourceUri,
    position
  );
  assert(
    Array.isArray(references) && references.length === 2,
    `Expected two Widget references; found ${references?.length ?? 0}.`
  );

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    sourceUri,
    position
  );
  assert(Array.isArray(hovers) && hovers.length === 1, "Widget hover was not returned.");
  const hoverText = hovers.flatMap((hover) => hover.contents).map((content) => (
    typeof content === "string" ? content : content.value
  )).join("\n");
  assert(hoverText.includes("class Widget"), "Widget hover did not include its signature.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
