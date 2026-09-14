import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/index-roslyn/test/*.integration.mjs"],
    testTimeout: 120_000
  }
});
