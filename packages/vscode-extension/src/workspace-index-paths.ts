export const workspaceIndexPathSegments = [
  [".codewise", "index.db"],
  ["artifacts", ".codewise", "index.db"]
] as const;

export const missingWorkspaceIndexMessage =
  "No code intelligence index was found. Configure codewise.indexPath or add "
  + ".codewise/index.db or artifacts/.codewise/index.db to the workspace.";
