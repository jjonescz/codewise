import { describe, expect, it } from "vitest";
import {
  assertRequiredSdkInstalled,
  parseInstalledSdkVersions
} from "./sdk-preflight.js";

const globalJsonPath = "C:\\roslyn\\global.json";

describe("Roslyn SDK preflight", () => {
  it("accepts the exact SDK requested by global.json", () => {
    const installed = parseInstalledSdkVersions([
      "10.0.303 [C:\\dotnet\\sdk]",
      "11.0.100-preview.6.26359.118 [C:\\dotnet\\sdk]"
    ].join("\n"));

    expect(() => assertRequiredSdkInstalled(
      "11.0.100-preview.6.26359.118",
      installed,
      globalJsonPath
    )).not.toThrow();
  });

  it("rejects a different preview of the same feature band", () => {
    const installed = parseInstalledSdkVersions(
      "11.0.100-preview.7.26381.103 [C:\\dotnet\\sdk]"
    );

    expect(() => assertRequiredSdkInstalled(
      "11.0.100-preview.6.26359.118",
      installed,
      globalJsonPath
    )).toThrow(
      /requires \.NET SDK 11\.0\.100-preview\.6\.26359\.118[\s\S]*Installed SDKs:[\s\S]*11\.0\.100-preview\.7\.26381\.103/u
    );
  });
});
