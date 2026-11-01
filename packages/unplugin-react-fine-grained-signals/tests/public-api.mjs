// The plugin's public surface, written once for the two smokes that check it:
// this package's `tests/build-smoke.mjs` (against `dist`) and the repository's
// `tests/consumer-smoke.mjs` (against the packed, installed tarball).

/**
 * The bundler adapter entries (`vite`, `rollup`, ...), derived from an
 * `exports` map: every subpath except the root and `./package.json`.
 */
export function adapterEntriesOf(exportsMap) {
  return Object.keys(exportsMap)
    .filter((subpath) => subpath !== "." && subpath !== "./package.json")
    .map((subpath) => subpath.replace(/^\.\//, ""));
}

// Every public entry exports exactly these runtime values.
export const expectedRuntimeExports = [
  "REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS",
  "default",
  "reactFineGrainedSignals",
];

// ...and exactly these types, plus its own adapter type below.
export const expectedTypeExports = [
  "ReactFineGrainedSignalsDiagnosticId",
  "ReactFineGrainedSignalsDiagnosticsOptions",
  "ReactFineGrainedSignalsFilterPattern",
  "ReactFineGrainedSignalsMode",
  "ReactFineGrainedSignalsOptions",
  "ReactFineGrainedSignalsReactCompiler",
  "ReactFineGrainedSignalsTransform",
];

/** The adapter type each entry adds; `index` is the root entry. */
export const adapterTypeExports = {
  index: [],
  vite: ["VitePlugin"],
  rollup: ["RollupPlugin"],
  webpack: ["WebpackPlugin"],
  rspack: ["RspackPlugin"],
  esbuild: ["EsbuildPlugin"],
};

// `src/unplugin.ts` also exports helpers for the adapters and the package's
// own tests; a stray `export *` would quietly turn them into public API.
export const internalNames = [
  "canTransform",
  "createModuleFilter",
  "resolveEsbuildLoader",
  "createBundlerPlugin",
  "pluginName",
  "EsbuildLoaderName",
  "BundlerTransformOutput",
];
