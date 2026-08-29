# Codewise

Codewise is an experimental SCIP-backed language server and VS Code extension.
The current prototype indexes a built Roslyn compiler project and serves
definition, references, and hover over the Language Server Protocol.

## Packages

- `packages/scip-core`: runtime-neutral SCIP decoding, validation, and queries.
- `packages/scip-lsp`: standalone TypeScript language server over stdio.
- `packages/vscode-extension`: desktop and web VS Code language clients.
- `tools/index-roslyn`: reproducible local Roslyn indexing and manifest tool.

The shared core and LSP handlers avoid Node and VS Code APIs. Desktop VS Code
runs the server over stdio, while vscode.dev and github.dev run it in a Web
Worker.

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

When no index path is configured and `.scip\index.scip` is absent, opening a
Roslyn root workspace makes the extension download the retained
`roslyn-scip-<HEAD>` artifact from `jjonescz/indexer`. The extension tries
anonymous access first and requests GitHub authentication only when private or
rate-limited access requires it. The artifact manifest is verified before the
index is cached in extension global storage and used.

## VS Code for the Web

The extension manifest includes both desktop and browser entry points. In
vscode.dev and github.dev, the extension reads `.scip/index.scip` through
`vscode.workspace.fs` and transfers it to a bundled Web Worker language server.
The **SCIP: Select Index File** command can select another index exposed by the
virtual workspace.

For a Roslyn workspace without a checked-in index, enter the exact 40-character
workspace commit when prompted. The extension remembers it in workspace state,
downloads the matching workflow artifact, verifies it, and caches it in web
extension storage. You can instead preconfigure
`codewise.scip.roslynCommit`. github.dev does not expose the active Git commit
to extensions, so this value cannot be inferred there.

Use the **Run Codewise SCIP for Web** launch configuration to build the
extension and open an interactive local VS Code web workbench. The prompted
workspace folder should contain `.scip\index.scip`, unless the Roslyn artifact
download flow will provide it.

Create an unpacked deployment directory for **Developer: Install Extension from
Location...** with:

```powershell
npm run package:extension:web
```

The command writes `artifacts\web-extension\codewise-scip`. Host that directory
without changing its layout.

Hosted vscode.dev and github.dev enforce a fixed `connect-src` Content Security
Policy, so arbitrary HTTPS origins such as Cloudflare Pages cannot be used with
this command even when they enable CORS. The supported sideload flow uses HTTPS
localhost with a locally trusted certificate.

Install [`mkcert`](https://github.com/FiloSottile/mkcert), then create and trust
a localhost certificate once:

```powershell
New-Item -ItemType Directory -Force "$HOME\.certs" | Out-Null
Push-Location "$HOME\.certs"
mkcert -install
mkcert localhost
Pop-Location
```

Package and serve the extension:

```powershell
npm run package:extension:web
npx serve artifacts\web-extension\codewise-scip `
  --cors `
  -l 5000 `
  --ssl-cert "$HOME\.certs\localhost.pem" `
  --ssl-key "$HOME\.certs\localhost-key.pem"
```

Open [vscode.dev](https://vscode.dev), run **Developer: Install Extension From
Location...**, and enter `https://localhost:5000`. Keep the server running while
the extension is in use. For a persistent installation available to other
users, publish the package through the VS Code Marketplace.

Build and run the headless web integration test with:

```powershell
npm run test:extension:web
```

The standalone Node filesystem and stdio adapters remain isolated in
`packages/scip-lsp/src/node-file-index-source.ts` and
`packages/scip-lsp/src/node.ts`.
