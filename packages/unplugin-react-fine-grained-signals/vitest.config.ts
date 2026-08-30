import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      // Measured baseline (2026-08-30): statements 93.66%, branches 91.38%,
      // functions 97.89%, lines 98.20%. Thresholds sit a modest margin below
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
