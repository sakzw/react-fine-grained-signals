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
  format: ["esm", "cjs"],
  platform: "neutral",
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
  outputOptions: {
    exports: "named",
  },
});
