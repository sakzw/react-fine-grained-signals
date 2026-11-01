import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";
import { adapterEntriesOf } from "./tests/public-api.mjs";

// One bundle per bundler adapter, named after its subpath in package.json
// `exports`, so the export map and the emitted files cannot drift apart.
const adapterEntries = adapterEntriesOf(
  JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")).exports,
);

export default defineConfig({
  entry: {
    index: "src/index.ts",
    ...Object.fromEntries(adapterEntries.map((entry) => [entry, `src/${entry}.ts`])),
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
