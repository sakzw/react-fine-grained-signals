import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    jsx: "src/jsx.ts",
    "jsx/jsx-runtime": "src/jsx/jsx-runtime.ts",
    "jsx/jsx-dev-runtime": "src/jsx/jsx-dev-runtime.ts",
    "jsx/lite": "src/jsx/lite.ts",
    "jsx/lite/jsx-runtime": "src/jsx/lite/jsx-runtime.ts",
    "jsx/lite/jsx-dev-runtime": "src/jsx/lite/jsx-dev-runtime.ts",
    internal: "src/internal.ts",
    utils: "src/utils.tsx",
  },
  format: "esm",
  platform: "neutral",
  sourcemap: true,
  dts: {
    // A .d.ts.map would point at `../src/*.ts`, which the published package
    // does not ship (`files: ["dist"]`), so every jump to definition through
    // it would resolve to a path that is not there. Must be set explicitly:
    // omitting it (or `dts: true`) still leaves a dangling sourceMappingURL
    // comment in each .d.ts. The .js.map files stay -- those embed
    // `sourcesContent`, so they work standalone in the published package.
    sourcemap: false,
  },
});
