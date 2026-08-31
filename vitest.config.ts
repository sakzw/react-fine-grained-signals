import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Tests compile JSX through this library's runtime rather than React's.
  // These settings live on Oxc, which Vitest 4 uses by default: esbuild is an
  // optional Vite peer that nothing in this workspace pulls in any more, so
  // configuring `esbuild` here would be silently inert.
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react-fine-grained-signals",
    },
  },
  resolve: {
    alias: [
      {
        find: /^react-fine-grained-signals\/runtime$/,
        replacement: source("./src/runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals\/utils$/,
        replacement: source("./src/utils.tsx"),
      },
      {
        find: /^react-fine-grained-signals\/jsx-runtime$/,
        replacement: source("./src/jsx-runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals\/jsx-dev-runtime$/,
        replacement: source("./src/jsx-dev-runtime.ts"),
      },
      {
        find: /^react-fine-grained-signals$/,
        replacement: source("./src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      // Measured baseline (2026-08-30): statements 94.67%, branches 86.38%,
      // functions 98.97%, lines 96.26%. Thresholds sit a modest margin below
      // that so CI catches real regressions without flaking on minor diffs.
      thresholds: {
        statements: 92,
        branches: 83,
        functions: 96,
        lines: 94,
      },
    },
  },
});
