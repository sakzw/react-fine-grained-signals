import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "src/vite.ts",
    rollup: "src/rollup.ts",
    webpack: "src/webpack.ts",
    rspack: "src/rspack.ts",
    esbuild: "src/esbuild.ts",
  },
  format: "esm",
  platform: "neutral",
  // Keep the declaration program to this package's own sources: the tests
  // import the library's TypeScript sources directly, and including them would
  // emit stray .d.ts files next to those sources.
  dts: { tsconfig: "tsconfig.build.json" },
});
