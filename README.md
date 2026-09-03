# Codewise

Codewise is an experimental precomputed-code-intelligence language server and
VS Code extension. A generic Language Server Protocol crawler records
definition, references, document highlights, and hover answers in SQLite, and
Codewise serves those answers offline over LSP.

## Packages

- `packages/index-core`: runtime-neutral SQLite schema validation and queries.
- `packages/index-lsp`: standalone TypeScript language server over stdio.
- `packages/lsp-crawler`: generic Node.js LSP client and resumable SQLite writer.
- `packages/vscode-extension`: desktop and web VS Code language clients.
- `tools/index-roslyn`: reproducible local Roslyn indexing and manifest tool.
- `tools/hosted-indexing`: scheduled Roslyn discovery and index-state handling.

The shared core and LSP handlers avoid Node and VS Code APIs. Desktop VS Code
runs the server over stdio, while vscode.dev and github.dev run it in a Web
Worker.

## Prerequisites

- Node.js 22 or newer.
- A .NET SDK compatible with the target checkout.
- A restored and built Roslyn checkout.

## Setup

```powershell
npm install
dotnet tool restore
npm run build
npm test
```

## Generic LSP crawler

`@codewise/lsp-crawler` launches any stdio language server from a
`CrawlerConfig`. Configure the workspace, server command and arguments, and the
file-extension-to-language-ID mapping, then call:

```typescript
import { crawlWorkspace } from "@codewise/lsp-crawler";

await crawlWorkspace(config, ".codewise/index.db");
```

The crawler discovers candidate positions from semantic tokens and document
symbols, with an optional lexical fallback. It stores definitions, declarations,
references, document highlights, hovers, retryable failures, source hashes, and
resume state. Changing or removing a document invalidates workspace answers
that may point into it.

Language servers can require non-standard server-to-client requests. Fixed
acknowledgements can be supplied through `server.requestResponses`; the Roslyn
configuration acknowledges `razor/updateHtml`. This provides C# information in
Razor documents but does not run a separate HTML language server.

`requestTimeoutMilliseconds` limits individual LSP requests.
`workspaceLoadTimeoutMilliseconds` separately controls how long the crawler
waits for work-done progress to settle before starting. An unfinished progress
token is advisory: after that timeout the crawler records a warning and
continues instead of failing the whole index.

## Generate the local Roslyn index

Pass the workspace root to launch the pinned official
`roslyn-language-server`, open C#, Visual Basic, Razor, and CSHTML documents,
and crawl semantic-token positions including locals:

```powershell
npm run index:roslyn -- --workspace-root C:\path\to\roslyn
```

This command restores the pinned `roslyn-language-server` local tool
automatically before starting the crawl. It also checks that the current
`dotnet` host can see the exact SDK requested by the workspace's
`global.json` and binds language-server project evaluation to that SDK
installation and its workload manifests. A missing SDK is reported once before
the language server starts or existing index artifacts are replaced.

The command prints the generated `lsp-crawler.log` path before starting.
Every physical log line has an ISO-8601 UTC timestamp, and explicit lifecycle
entries record crawl start and terminal success or failure. Language-server
diagnostics are written only to that file; the terminal shows concise crawl
progress and the final index summary. When `CI=true` or `GITHUB_ACTIONS=true`,
diagnostics are also mirrored to stderr so a failed job retains them even if it
never reaches artifact upload.

Periodic crawl progress includes elapsed time, document throughput, and an
estimated remaining time. The final summary reports separate timings for
document discovery, server initialization, index preparation, workspace-load
waiting, document crawling, and the complete crawl.

The crawler covers the full workspace loaded by Roslyn rather than invoking a
language-specific batch indexer. By default, the database, log, and manifest are
written below the workspace's `artifacts\.codewise\` directory. Passing
`--database` places the log and manifest beside the selected database.

## Run the standalone language server

Any LSP client can launch the server over stdio after `npm run build`:

```powershell
node packages\index-lsp\dist\node.js --stdio --index C:\path\to\index.db
```

Indexed workspace locations are stored with portable relative paths, so the
consumer may use a different checkout root from the indexing runner.

## Test with Roslyn

Run the real-index stdio checks:

```powershell
npm run smoke:roslyn
```

Run the extension in an isolated VS Code Extension Host:

```powershell
npm run test:extension
```

Alternatively, use the **Run Codewise on Roslyn** launch configuration and
select the generated index with **Codewise: Select Index File**.

When no index path is configured and neither `.codewise\index.db` nor
`artifacts\.codewise\index.db` is present, opening a Roslyn root workspace makes
the extension download the retained
`roslyn-codewise-<HEAD>` Actions artifact from this repository. GitHub requires
authentication to download workflow artifacts, so Codewise requests permission
to use a GitHub session. The artifact manifest is verified before the index is
cached in extension global storage and used.

## VS Code for the Web

The extension manifest includes both desktop and browser entry points. In
vscode.dev and github.dev, the extension reads `.codewise/index.db` or
`artifacts/.codewise/index.db` through `vscode.workspace.fs` and transfers it to
a Web Worker. The conventional path takes priority. The desktop server uses
Node's SQLite implementation; the browser worker loads the same database with
the official SQLite WASM build bundled in the extension.
The **Codewise: Select Index File** command can select another index exposed by the
virtual workspace.

For a Roslyn workspace without a checked-in index, enter the exact 40-character
workspace commit when prompted. The extension remembers it in workspace state,
downloads the matching workflow artifact, verifies it, and caches it in web
extension storage. You can instead preconfigure
`codewise.roslynCommit`. github.dev does not expose the active Git commit
to extensions, so this value cannot be inferred there.

Use the **Run Codewise for Web** launch configuration to build the
extension and open an interactive local VS Code web workbench. The prompted
workspace folder should contain `.codewise\index.db`, unless the Roslyn artifact
download flow will provide it.

Create an unpacked deployment directory for **Developer: Install Extension from
Location...** with:

```powershell
npm run package:extension:web
```

The command writes `artifacts\web-extension\codewise`. Host that directory
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
npx serve artifacts\web-extension\codewise `
  --cors `
  -l 5000 `
  --ssl-cert "$HOME\.certs\localhost.pem" `
  --ssl-key "$HOME\.certs\localhost-key.pem"
```

Alternatively, run the `serve-codewise-for-vscode-dev` VS Code task after the
one-time certificate setup. The task packages the extension and serves it at
`https://localhost:5000`; terminate the task when testing is complete.

Open [vscode.dev](https://vscode.dev), run **Developer: Install Extension From
Location...**, and enter `https://localhost:5000`. Keep the server running while
the extension is in use. For a persistent installation available to other
users, publish the package through the VS Code Marketplace.

Build and run the headless web integration test with:

```powershell
npm run test:extension:web
```

## Publish the VS Code extension

Pushing a tag named `v<version>` runs
`.github\workflows\publish-extension.yml`. Stable release tags use the form
`v<major>.<minor>.<patch>`, and the tagged commit must be reachable from `main`.
The workflow applies the tag version to the extension manifest and lockfile in
its temporary checkout, type-checks, tests, creates a VSIX, retains it as a
workflow artifact, and publishes that exact package to the Visual Studio
Marketplace. It does not commit the generated version change.

The workflow uses the `@vscode/vsce` version pinned in the root development
dependencies and `package-lock.json`. This keeps the release tool visible to
dependency automation such as Dependabot.

Before the first release:

1. Confirm that the publisher declared in
   `packages\vscode-extension\package.json` exists in the
   [Marketplace publisher portal](https://marketplace.visualstudio.com/manage)
   and that your account can publish to it. Choose this publisher before the
   first release because it forms part of the extension's Marketplace identity.
2. Create an Azure DevOps personal access token for **All accessible
   organizations** with the **Marketplace > Manage** scope.
3. In this GitHub repository, open **Settings > Environments** and create an
   environment named `vscode-marketplace`.
4. Add the token to that environment as a secret named `VSCE_PAT`.
5. Configure the environment with required reviewers and restrict deployment
   tags to `v*`.

The publish job receives the PAT only after the unprivileged build job has
finished testing and packaging the VSIX and any environment protection rules
have passed. Rotate the secret before it expires.

To publish version `0.0.2`, tag a commit that is already on `main`:

```powershell
git tag v0.0.2
git push origin v0.0.2
```

Protect the `v*` tag pattern so only release maintainers can trigger
Marketplace publication.

The standalone Node filesystem and stdio adapters remain isolated in
`packages/index-lsp/src/node-file-index-source.ts` and
`packages/index-lsp/src/node.ts`.

## Hosted Roslyn indexing

`.github\workflows\scan-roslyn.yml` scans Roslyn main and open pull request
heads and dispatches up to four isolated `.github\workflows\index-roslyn.yml`
runs. Each run builds `Roslyn.slnx`, crawls the official Roslyn language server,
and uploads `roslyn-codewise-<sha>` for 90 days.

Roslyn source and builds are untrusted. The index job has no repository
permissions or secrets and fetches both repositories anonymously. The trusted
finalizer runs separately, receives no files or processes from the index job,
and records only its GitHub conclusion on the `state` branch. Treat downloaded
SQLite files as untrusted; consumers open them read-only, disable trusted
schemas and extension loading, and validate the complete schema before queries.

The trusted scanner creates the `state` branch and `index-state.json`
automatically on its first run. Scheduled scans run only when the repository variable
`ENABLE_SCHEDULED_INDEXING` is `true`. Manual **Scan Roslyn** runs remain
available, including the `reset_sha` retry input.
