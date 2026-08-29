import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "tools/**/*.test.ts",
      "tools/**/*.test.mjs"
    ],
    coverage: {
      reporter: [
        "text",
        "html"
      ]
    }
  }
});
