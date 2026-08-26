import { ScipIndexError } from "./errors.js";

const driveRootPattern = /^[A-Za-z]:\//;
const uriSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function normalizeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");

  if (normalized.length === 0) {
    throw new ScipIndexError("SCIP document path must not be empty.");
  }

  if (
    normalized.startsWith("/")
    || driveRootPattern.test(normalized)
    || uriSchemePattern.test(normalized)
  ) {
    throw new ScipIndexError(`SCIP document path must be relative: ${path}`);
  }

  const components = normalized.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new ScipIndexError(`SCIP document path is not canonical: ${path}`);
  }

  return normalized;
}

