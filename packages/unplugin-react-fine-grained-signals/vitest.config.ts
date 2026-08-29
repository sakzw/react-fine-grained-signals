import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      // Measured baseline (2026-08-30): statements 94.97%, branches 93.22%,
      // functions 95.23%, lines 97.25%. Thresholds sit a modest margin below
      // that so CI catches real regressions without flaking on minor diffs.
      thresholds: {
        statements: 92,
        branches: 90,
        functions: 92,
        lines: 95,
      },
    },
  },
});
