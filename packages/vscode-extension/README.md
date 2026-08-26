# Codewise SCIP VS Code extension

This desktop extension launches the bundled Codewise SCIP language server over
stdio and enables C# definition, references, and hover from a prebuilt SCIP
index.

Set `codewise.scip.indexPath` to an absolute `index.scip` path, or place the
index at `.scip/index.scip` in the opened workspace. Use **SCIP: Select Index
File** and **SCIP: Restart Language Server** from the Command Palette.

The first prototype is desktop-only. SCIP decoding and shared LSP handlers live
outside this package and do not use Node or VS Code APIs, preserving a future
browser client and Web Worker server path.

