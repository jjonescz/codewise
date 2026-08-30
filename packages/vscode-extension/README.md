# Codewise VS Code extension

This extension enables C# definition, references, and hover from a prebuilt SCIP
index in desktop VS Code, vscode.dev, and github.dev. Desktop VS Code launches
the bundled language server over stdio. VS Code for the Web runs the same shared
server in a Web Worker.

Set `codewise.indexPath` to an absolute desktop path or a workspace URI, or
place the index at `.scip/index.scip` in the opened workspace. Use **Codewise:
Select Index File** and **Codewise: Restart Language Server** from the Command
Palette.

When the setting is empty and the root workspace is a `dotnet/roslyn` checkout,
the extension looks up `roslyn-scip-<HEAD>` in the `jjonescz/indexer` GitHub
Actions artifacts. It tries anonymous access first, then asks for GitHub `repo`
authentication only when private or rate-limited access requires it. The
extension verifies the bundle's commit, byte size, and SHA-256 from its manifest
and caches the index by commit in extension global storage.

Desktop VS Code obtains the Roslyn commit from local Git. github.dev does not
expose the active Git commit to web extensions, so the extension asks for its
full SHA and remembers it in workspace state before downloading the matching
artifact. You can preconfigure the SHA with `codewise.roslynCommit`.

When a virtual web workspace inherits a desktop `file` path in
`codewise.indexPath`, the extension ignores that unavailable path and
continues with the workspace index and hosted-artifact fallbacks.

Authentication and artifact diagnostics are written to **Output: Codewise**
without access tokens or account identifiers. If GitHub sign-in fails,
also inspect **Output: GitHub Authentication** for the built-in provider's
per-flow diagnostics.
