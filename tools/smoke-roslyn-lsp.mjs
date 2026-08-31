import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-jsonrpc/node";
import { URI, Utils } from "vscode-uri";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roslynRoot = resolve(process.env.ROSLYN_ROOT ?? "C:\\roslyn-3");
const commit = spawnSync("git", ["-C", roslynRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true
}).stdout.trim();
const indexPath = resolve(repositoryRoot, "artifacts", "roslyn", commit, "index.db");
const verificationPath = resolve(
  repositoryRoot,
  "artifacts",
  "roslyn",
  commit,
  "lsp-verification.json"
);
const serverPath = process.env.CODEWISE_LSP_PATH
  ?? resolve(repositoryRoot, "packages", "index-lsp", "dist", "node.js");
const rootUri = URI.file(roslynRoot);
const cases = [
  {
    path: "src/Compilers/CSharp/Portable/Compilation/AttributeSemanticModel.cs",
    line: 123,
    token: "CSharpCompilation",
    definitionPath: "/Compilation/CSharpCompilation.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/CommandLine/CSharpCompiler.cs",
    line: 174,
    token: "CSharpParseOptions",
    definitionPath: "/CSharpParseOptions.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/CommandLine/CSharpCompiler.cs",
    line: 285,
    token: "LanguageVersion",
    definitionPath: "/LanguageVersion.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/CommandLine/CSharpCompiler.cs",
    line: 351,
    token: "SyntaxKind",
    definitionPath: "/Syntax/SyntaxKind.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/CommandLine/CSharpCompiler.cs",
    line: 363,
    token: "MessageProvider",
    definitionPath: "/Errors/MessageProvider.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/CommandLine/CSharpCompiler.cs",
    line: 389,
    token: "ErrorCode",
    definitionPath: "/Errors/ErrorCode.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/Parser/LanguageParser.cs",
    line: 37,
    token: "Lexer",
    definitionPath: "/Parser/Lexer.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/Compilation/CSharpCompilation.cs",
    line: 54,
    token: "CSharpCompilationOptions",
    definitionPath: "/CSharpCompilationOptions.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/Binder/Binder.cs",
    line: 573,
    token: "BindingDiagnosticBag",
    definitionPath: "/Binder/BindingDiagnosticBag.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/Binder/Binder.cs",
    line: 854,
    token: "TypeSymbol",
    definitionPath: "/Symbols/TypeSymbol.cs"
  },
  {
    path: "src/Compilers/CSharp/Portable/Binder/Binder.cs",
    line: 529,
    token: "MethodSymbol",
    definitionPath: "/Symbols/MethodSymbol.cs"
  }
];

const child = spawn(
  process.execPath,
  [serverPath, "--stdio", "--index", indexPath],
  {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  }
);
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

const connection = createMessageConnection(
  new StreamMessageReader(child.stdout),
  new StreamMessageWriter(child.stdin)
);
connection.listen();

try {
  const startedAt = performance.now();
  await connection.sendRequest("initialize", {
    processId: null,
    rootUri: rootUri.toString(),
    capabilities: {},
    workspaceFolders: [
      {
        name: "roslyn",
        uri: rootUri.toString()
      }
    ]
  });
  connection.sendNotification("initialized", {});
  const initializationMilliseconds = Math.round(performance.now() - startedAt);
  const results = [];
  for (const testCase of cases) {
    const sourceText = await readFile(resolve(roslynRoot, ...testCase.path.split("/")), "utf8");
    const lineText = sourceText.split(/\r?\n/u)[testCase.line - 1];
    const character = lineText?.indexOf(testCase.token) ?? -1;
    if (character < 0) {
      throw new Error(
        `Token ${testCase.token} was not found at ${testCase.path}:${testCase.line}.`
      );
    }

    const sourceUri = Utils.joinPath(rootUri, ...testCase.path.split("/")).toString();
    const request = {
      textDocument: { uri: sourceUri },
      position: { line: testCase.line - 1, character: character + 1 }
    };
    const definition = await connection.sendRequest("textDocument/definition", request);
    const definitionMatches = Array.isArray(definition) && definition.some((location) => (
      URI.parse(location.uri).path.endsWith(testCase.definitionPath)
    ));

    const references = await connection.sendRequest("textDocument/references", {
      ...request,
      context: { includeDeclaration: false }
    });
    const hover = await connection.sendRequest("textDocument/hover", request);
    results.push({
      token: testCase.token,
      definitionMatches,
      definitionCount: Array.isArray(definition) ? definition.length : 0,
      referenceCount: Array.isArray(references) ? references.length : 0,
      hasHover: hover !== null
    });
  }

  const matchingDefinitions = results.filter((result) => result.definitionMatches).length;
  const symbolsWithReferences = results.filter((result) => result.referenceCount > 1).length;
  const symbolsWithHover = results.filter((result) => result.hasHover).length;
  if (matchingDefinitions < 10) {
    throw new Error(
      `Only ${matchingDefinitions} curated symbols resolved to the expected definition:\n`
      + JSON.stringify(results, undefined, 2)
    );
  }
  if (symbolsWithReferences < 3) {
    throw new Error(`Only ${symbolsWithReferences} curated symbols returned multiple references.`);
  }
  if (symbolsWithHover < 3) {
    throw new Error(`Only ${symbolsWithHover} curated symbols returned hover information.`);
  }

  const verification = {
    commit,
    indexPath,
    verifiedAt: new Date().toISOString(),
    initializationMilliseconds,
    matchingDefinitions,
    symbolsWithMultipleReferences: symbolsWithReferences,
    symbolsWithHover,
    results
  };
  await writeFile(verificationPath, `${JSON.stringify(verification, undefined, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...verification, verificationPath }, undefined, 2));

  await connection.sendRequest("shutdown");
  connection.sendNotification("exit");
  if (stderr.length > 0) {
    throw new Error(`Language server wrote to stderr: ${stderr.join("")}`);
  }
} finally {
  connection.dispose();
  if (child.exitCode === null) {
    child.kill();
  }
}
