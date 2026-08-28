# Codewise

Codewise is an experimental SCIP-backed language server and VS Code extension.
The current prototype indexes a built Roslyn compiler project and serves
definition, references, and hover over the Language Server Protocol.

## Packages

- `packages/scip-core`: runtime-neutral SCIP decoding, validation, and queries.
- `packages/scip-lsp`: standalone TypeScript language server over stdio.
- `packages/vscode-extension`: desktop VS Code language client.
- `tools/index-roslyn`: reproducible local Roslyn indexing and manifest tool.

The shared core and LSP handlers avoid Node and VS Code APIs so a later browser
client and Web Worker server can reuse them.

## Companion indexer repository

GitHub-hosted Roslyn indexing lives in the separate private repository
[`jjonescz/indexer`](https://github.com/jjonescz/indexer). When working on its
workflows or orchestration, check it out as `indexer` directly under this
repository root:

```powershell
gh repo clone jjonescz/indexer indexer
```

The nested checkout is intentionally ignored by this repository and is not a
submodule. Treat it as an independent Git repository: inspect, commit, and push
its changes separately from Codewise. Future agents working on hosted indexing
should reuse this location, cloning it first when `indexer\.git` is absent.

## Prerequisites

- Node.js 20 or newer.
- A .NET SDK compatible with the target checkout.
- A restored and built Roslyn checkout.

## Setup

```powershell
npm install
dotnet tool restore
npm run build
npm test
```

## Generate the local Roslyn index

By default, the command targets `C:\roslyn-3` and
`src\Compilers\CSharp\Portable\Microsoft.CodeAnalysis.CSharp.csproj`:

```powershell
npm run index:roslyn
```

To use another checkout:

```powershell
npm run index:roslyn -- --roslyn-root C:\path\to\roslyn
```

Generated indexes, logs, and manifests are written below
`artifacts\roslyn\<commit>\` and are ignored by version control.

## Run the standalone language server

Any LSP client can launch the server over stdio after `npm run build`:

```powershell
node packages\scip-lsp\dist\node.js --stdio --index C:\path\to\index.scip
```

The workspace root supplied during LSP initialization must be the same source
root used as `scip-dotnet --working-directory`.

## Test with Roslyn

Run the real-index stdio checks:

```powershell
npm run smoke:roslyn
```

Run the extension in an isolated VS Code Extension Host:

```powershell
npm run test:extension
```

Alternatively, use the **Run Codewise SCIP on Roslyn** launch configuration and
select the generated index with **SCIP: Select Index File**.

## Browser path

The current extension is desktop-only because it starts a Node child process
and reads a local index. Browser support requires three adapters, not a rewrite:

1. a `vscode-languageclient/browser` client;
2. a Web Worker entry using `vscode-languageserver/browser`;
3. an `IndexSource` that obtains bytes through `fetch` or `vscode.workspace.fs`.

`packages/scip-core`, `packages/scip-lsp/src/server.ts`,
`packages/scip-lsp/src/index-source.ts`, and URI mapping are shared with that
future implementation. Node filesystem and stdio code remain isolated in
`node-file-index-source.ts` and `node.ts`.
