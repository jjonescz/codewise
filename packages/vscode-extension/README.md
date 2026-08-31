# Codewise VS Code extension

This extension enables C# definition, references, and hover from a prebuilt
Codewise SQLite index in desktop VS Code, vscode.dev, and github.dev. Desktop VS
Code launches the bundled language server over stdio. VS Code for the Web loads
the same database through SQLite WASM in a Web Worker.

Set `codewise.indexPath` to an absolute desktop path or a workspace URI, or
place the index at `.codewise/index.db` in the opened workspace. Use **Codewise:
Select Index File** and **Codewise: Restart Language Server** from the Command
Palette.

When the setting is empty and the root workspace is a `dotnet/roslyn` checkout,
the extension downloads the `roslyn-codewise-<HEAD>` GitHub Actions artifact
from `jjonescz/codewise`. GitHub requires authentication for artifact downloads, so
the extension requests permission to use a GitHub session with the `repo`
scope. It verifies the bundle's commit, byte size, and SHA-256 from its manifest
and caches the index by commit in extension global storage.

Desktop VS Code obtains the Roslyn commit from local Git. On vscode.dev and
github.dev, the extension first obtains the exact revision from the built-in
Remote Repositories metadata API. For a GitHub pull request workspace, it can
also resolve the encoded pull request's head ref through the public GitHub API.
If automatic detection is unavailable, it falls back to a previously entered
SHA or asks for the full SHA and remembers it in workspace state. You can
override automatic detection with `codewise.roslynCommit`.

When a virtual web workspace inherits a desktop `file` path in
`codewise.indexPath`, the extension ignores that unavailable path and
continues with the workspace index and hosted-artifact fallbacks.

Authentication and artifact diagnostics are written to **Output: Codewise**
without access tokens or account identifiers. If GitHub authentication fails,
also inspect **Output: GitHub Authentication** for the built-in provider's
per-flow diagnostics.
