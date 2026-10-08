import * as vscode from "vscode";

export async function run(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert(workspaceFolder !== undefined, "The web extension test workspace was not opened.");

  const matchingExtensions = vscode.extensions.all.filter(
    (candidate) => candidate.packageJSON["name"] === "codewise-lsp"
  );
  const extension = matchingExtensions[0];
  assert(
    matchingExtensions.length === 1 && extension !== undefined,
    `Expected one Codewise extension; found: ${
      matchingExtensions.map((candidate) => candidate.id).join(", ") || "none"
    }.`
  );
  await extension.activate();

  await checkDocument(
    workspaceFolder,
    "Widget.cs",
    new vscode.MarkdownString().appendText("class Widget").value
  );
  await checkDocument(workspaceFolder, "WidgetGeneric.cs", "class Widget");
  console.log("Codewise web tests passed: navigation, semantic tokens, edit suppression and restoration.");
}

async function checkDocument(
  workspaceFolder: vscode.WorkspaceFolder,
  name: string,
  expectedSignature: string
): Promise<void> {
  const sourceUri = vscode.Uri.joinPath(workspaceFolder.uri, "src", name);
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
  assert(
    hoverText.includes(expectedSignature),
    `${name} hover did not include its signature: ${hoverText}`
  );
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
    "vscode.provideDocumentSemanticTokensLegend", sourceUri
  );
  assert(
    legend?.tokenTypes[0] === "class" && legend.tokenModifiers[0] === "declaration",
    "The semantic token legend was not registered."
  );
  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
    "vscode.provideDocumentSemanticTokens", sourceUri
  );
  assert(
    tokens !== undefined
      && Array.from(tokens.data).join(",") === "0,13,6,0,1,3,8,6,0,0",
    "The indexed semantic token stream was not returned."
  );
  const originalText = document.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(sourceUri, new vscode.Position(0, 0), "\n");
  assert(await vscode.workspace.applyEdit(edit), "Could not edit the test document.");
  const changedTokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
    "vscode.provideDocumentSemanticTokens", sourceUri
  );
  assert(changedTokens?.data.length === 0, "Highlighting was not suppressed after editing.");
  const restore = new vscode.WorkspaceEdit();
  restore.replace(
    sourceUri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
    originalText
  );
  assert(await vscode.workspace.applyEdit(restore), "Could not restore the test document.");
  const restoredTokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
    "vscode.provideDocumentSemanticTokens", sourceUri
  );
  assert(restoredTokens?.data.length === 10, "Highlighting did not return after restoring the snapshot.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
