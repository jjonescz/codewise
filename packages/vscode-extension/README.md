# Codewise SCIP VS Code extension

This desktop extension launches the bundled Codewise SCIP language server over
stdio and enables C# definition, references, and hover from a prebuilt SCIP
index.

Set `codewise.scip.indexPath` to an absolute `index.scip` path, or place the
index at `.scip/index.scip` in the opened workspace. Use **SCIP: Select Index
File** and **SCIP: Restart Language Server** from the Command Palette.

When the setting is empty and the root workspace is a `dotnet/roslyn` checkout,
the extension looks up `roslyn-scip-<HEAD>` in the private
`jjonescz/indexer` GitHub Actions artifacts. It asks for GitHub `repo`
authentication, verifies the bundle's commit, byte size, and SHA-256 from its
manifest, and caches the index by commit in the extension's global storage.

The first prototype is desktop-only. SCIP decoding and shared LSP handlers live
outside this package and do not use Node or VS Code APIs, preserving a future
browser client and Web Worker server path.
