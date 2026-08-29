import { describe, expect, it } from "vitest";
import { formatError, logMessage } from "./extension-logging.js";

describe("extension logging", () => {
  it("formats error codes and cause chains", () => {
    const cause = Object.assign(new Error("provider failed"), {
      code: "AUTH_FAILED"
    });
    const error = new Error("index resolution failed", { cause });

    const formatted = formatError(error);

    expect(formatted).toContain("Error: index resolution failed");
    expect(formatted).toContain("Caused by: Error: provider failed [code: AUTH_FAILED]");
  });

  it("prefixes messages with an ISO timestamp", () => {
    const lines: string[] = [];

    logMessage({ appendLine: (value) => lines.push(value) }, "Starting");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Starting$/u
    );
  });
});
