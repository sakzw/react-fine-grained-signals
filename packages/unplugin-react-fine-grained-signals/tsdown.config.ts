import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "src/vite.ts",
    rollup: "src/rollup.ts",
    webpack: "src/webpack.ts",
    rspack: "src/rspack.ts",
    esbuild: "src/esbuild.ts",
    // Not a public entry point: the webpack/rspack adapters hand this file's
    // path to the compiler as a loader module, so it has to be emitted next to
    // them under exactly this name (`src/unplugin.ts` resolves `./loader.js`
    // relative to its own module URL).
    loader: "src/loader.ts",
  },
  format: "esm",
  platform: "neutral",
  // The webpack/rspack adapters need `node:url` to turn this bundle's own
  // module URL into the loader path a compiler can resolve. Node's builtins are
  // external at runtime regardless; saying so explicitly stops the "neutral"
  // platform from trying to resolve them as packages and warning about it.
  deps: { neverBundle: [/^node:/] },
  // Keep the declaration program to this package's own sources: the tests
  // import the library's TypeScript sources directly, and including them would
  // emit stray .d.ts files next to those sources.
  dts: { tsconfig: "tsconfig.build.json" },
});
