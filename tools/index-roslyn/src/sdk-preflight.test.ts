import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSdkResolverEnvironment,
  parseInstalledSdks,
  resolveRequiredSdkInstallation
} from "./sdk-preflight.js";

const globalJsonPath = join("workspace", "global.json");
const sdkBasePath = join("dotnet", "sdk");

describe("workspace SDK preflight", () => {
  it("resolves the exact SDK installation requested by global.json", () => {
    const installed = parseInstalledSdks([
      `10.0.303 [${sdkBasePath}]`,
      `11.0.100-preview.6.26359.118 [${sdkBasePath}]`
    ].join("\n"));

    const requiredSdk = resolveRequiredSdkInstallation(
      "11.0.100-preview.6.26359.118",
      installed,
      globalJsonPath
    );
    expect(requiredSdk).toEqual({
      version: "11.0.100-preview.6.26359.118",
      dotnetRoot: join("dotnet"),
      msbuildSdksPath: join(
        sdkBasePath,
        "11.0.100-preview.6.26359.118",
        "Sdks"
      )
    });
    expect(createSdkResolverEnvironment(
      requiredSdk,
      join("dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet"),
      join("system", "bin"),
      process.platform === "win32" ? ";" : ":"
    )).toEqual({
      DOTNET_HOST_PATH: join(
        "dotnet",
        process.platform === "win32" ? "dotnet.exe" : "dotnet"
      ),
      DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR: join("dotnet"),
      DOTNET_MSBUILD_SDK_RESOLVER_SDKS_DIR: join(
        sdkBasePath,
        "11.0.100-preview.6.26359.118",
        "Sdks"
      ),
      DOTNET_MSBUILD_SDK_RESOLVER_SDKS_VER:
        "11.0.100-preview.6.26359.118",
      PATH: [
        join("dotnet"),
        join("system", "bin")
      ].join(process.platform === "win32" ? ";" : ":")
    });
  });

  it("rejects a different preview of the same feature band", () => {
    const installed = parseInstalledSdks(
      `11.0.100-preview.7.26381.103 [${sdkBasePath}]`
    );

    expect(() => resolveRequiredSdkInstallation(
      "11.0.100-preview.6.26359.118",
      installed,
      globalJsonPath
    )).toThrow(
      /requires \.NET SDK 11\.0\.100-preview\.6\.26359\.118[\s\S]*Installed SDKs:[\s\S]*11\.0\.100-preview\.7\.26381\.103/u
    );
  });
});
