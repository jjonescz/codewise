import { describe, expect, it } from "vitest";
import { formatTimestampedLogEntry } from "./timestamped-log.js";

describe("formatTimestampedLogEntry", () => {
  it("timestamps every physical line in a log entry", () => {
    const timestamp = new Date("2026-09-03T11:23:45.678Z");

    expect(formatTimestampedLogEntry(
      "[server] First line\r\nstack trace line\n",
      timestamp
    )).toBe([
      "[2026-09-03T11:23:45.678Z] [server] First line",
      "[2026-09-03T11:23:45.678Z] stack trace line",
      ""
    ].join("\n"));
  });
});
