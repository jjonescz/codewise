import { describe, expect, it } from "vitest";
import {
  missingWorkspaceIndexMessage,
  workspaceIndexPathSegments
} from "./workspace-index-paths.js";

describe("workspace index paths", () => {
  it("prefers the conventional path before crawler artifacts", () => {
    expect(workspaceIndexPathSegments).toEqual([
      [".codewise", "index.db"],
      ["artifacts", ".codewise", "index.db"]
    ]);
    expect(missingWorkspaceIndexMessage)
      .toContain("artifacts/.codewise/index.db");
  });
});
