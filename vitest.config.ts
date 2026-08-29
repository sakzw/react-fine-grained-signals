import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Vitest 4 defaults to Oxc; disable it so the explicit esbuild JSX settings
  // below are used for test transforms.
  oxc: false,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react-fine-grained-signals",
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
    environmentMatchGlobs: [["tests/**/*.test.tsx", "jsdom"]],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
    },
  },
});
