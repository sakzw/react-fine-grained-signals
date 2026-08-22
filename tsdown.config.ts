import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "jsx-runtime": "src/jsx-runtime.ts",
    "jsx-dev-runtime": "src/jsx-dev-runtime.ts",
    runtime: "src/runtime.ts",
    utils: "src/utils.tsx",
  },
  format: "esm",
  platform: "neutral",
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
});
