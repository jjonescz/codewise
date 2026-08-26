import { describe, expect, it } from "vitest";
import { WorkspaceUriMapper } from "./workspace-uri-mapper.js";

describe("WorkspaceUriMapper", () => {
  it("maps file workspace documents in both directions", () => {
    const mapper = new WorkspaceUriMapper("file:///C:/roslyn-3");

    expect(mapper.toRelativePath("file:///C:/roslyn-3/src/Widget.cs"))
      .toBe("src/Widget.cs");
    expect(mapper.toDocumentUri("src/Widget.cs"))
      .toBe("file:///c%3A/roslyn-3/src/Widget.cs");
  });

  it("preserves virtual workspace schemes and authorities", () => {
    const mapper = new WorkspaceUriMapper("vscode-vfs://github/dotnet/roslyn");

    expect(
      mapper.toRelativePath("vscode-vfs://github/dotnet/roslyn/src/Widget.cs")
    ).toBe("src/Widget.cs");
    expect(mapper.toDocumentUri("src/Widget.cs"))
      .toBe("vscode-vfs://github/dotnet/roslyn/src/Widget.cs");
  });

  it("rejects sibling paths and different authorities", () => {
    const mapper = new WorkspaceUriMapper("file:///C:/roslyn-3");

    expect(mapper.toRelativePath("file:///C:/roslyn-30/src/Widget.cs")).toBeUndefined();
    expect(mapper.toRelativePath("vscode-vfs://github/dotnet/roslyn/src/Widget.cs"))
      .toBeUndefined();
  });
});
