import { readFileSync } from "node:fs";

export function readRequiredSdkVersion(globalJsonPath: string): string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(globalJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${globalJsonPath} as JSON.`, {
      cause: error
    });
  }
  if (!isObject(value) || !isObject(value["sdk"])) {
    throw new Error(`${globalJsonPath} does not define sdk.version.`);
  }
  const version = value["sdk"]["version"];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${globalJsonPath} does not define a valid sdk.version.`);
  }
  return version;
}

export function parseInstalledSdkVersions(output: string): readonly string[] {
  const versions: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+\[[^\]]+\]\s*$/u.exec(line.trim());
    if (match?.[1] !== undefined) {
      versions.push(match[1]);
    }
  }
  return versions;
}

export function assertRequiredSdkInstalled(
  requiredVersion: string,
  installedVersions: readonly string[],
  globalJsonPath: string
): void {
  if (installedVersions.includes(requiredVersion)) {
    return;
  }

  const installed = installedVersions.length === 0
    ? "  (none)"
    : installedVersions.map((version) => `  ${version}`).join("\n");
  throw new Error(
    `The workspace requires .NET SDK ${requiredVersion} from ${globalJsonPath}, `
    + "but that exact SDK is not installed for the current dotnet host.\n\n"
    + `Installed SDKs:\n${installed}\n\n`
    + `Install .NET SDK ${requiredVersion} before indexing the workspace.`
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
