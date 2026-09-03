import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface InstalledSdk {
  readonly version: string;
  readonly sdkBasePath: string;
}

export interface RequiredSdkInstallation {
  readonly version: string;
  readonly dotnetRoot: string;
  readonly msbuildSdksPath: string;
}

export function createSdkResolverEnvironment(
  sdk: RequiredSdkInstallation,
  dotnetExecutablePath: string,
  inheritedPath: string | undefined,
  pathDelimiter: string
): Readonly<Record<string, string>> {
  return {
    DOTNET_HOST_PATH: dotnetExecutablePath,
    DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR: sdk.dotnetRoot,
    DOTNET_MSBUILD_SDK_RESOLVER_SDKS_DIR: sdk.msbuildSdksPath,
    DOTNET_MSBUILD_SDK_RESOLVER_SDKS_VER: sdk.version,
    PATH: inheritedPath === undefined || inheritedPath.length === 0
      ? sdk.dotnetRoot
      : `${sdk.dotnetRoot}${pathDelimiter}${inheritedPath}`
  };
}

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

export function parseInstalledSdks(output: string): readonly InstalledSdk[] {
  const installations: InstalledSdk[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+\[(.+)\]\s*$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      installations.push({
        version: match[1],
        sdkBasePath: match[2]
      });
    }
  }
  return installations;
}

export function resolveRequiredSdkInstallation(
  requiredVersion: string,
  installedSdks: readonly InstalledSdk[],
  globalJsonPath: string
): RequiredSdkInstallation {
  const installation = installedSdks.find(
    (candidate) => candidate.version === requiredVersion
  );
  if (installation !== undefined) {
    return {
      version: installation.version,
      dotnetRoot: dirname(installation.sdkBasePath),
      msbuildSdksPath: join(
        installation.sdkBasePath,
        installation.version,
        "Sdks"
      )
    };
  }

  const installed = installedSdks.length === 0
    ? "  (none)"
    : installedSdks
        .map((sdk) => `  ${sdk.version} [${sdk.sdkBasePath}]`)
        .join("\n");
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
