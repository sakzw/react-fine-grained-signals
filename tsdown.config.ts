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
    // A .d.ts.map would point at `../src/*.ts`, which the published package
    // does not ship (`files: ["dist"]`), so every jump to definition through
    // it would resolve to a path that is not there. Must be set explicitly:
    // omitting it (or `dts: true`) still leaves a dangling sourceMappingURL
    // comment in each .d.ts. The .js.map files stay -- those embed
    // `sourcesContent`, so they work standalone in the published package.
    sourcemap: false,
  },
});
