const entries = ["vite", "rollup", "webpack", "rspack", "esbuild"];

for (const entry of entries) {
  const esm = await import(`../dist/${entry}.js`);

  if (typeof esm.default !== "function") {
    throw new TypeError(`${entry} must expose a callable ESM plugin factory`);
  }

  const esmPlugin = esm.default({ mode: "auto" });
  const isCompilerPlugin = entry === "webpack" || entry === "rspack";
  const hasExpectedShape = isCompilerPlugin
    ? typeof esmPlugin?.apply === "function"
    : esmPlugin?.name === "unplugin-react-fine-grained-signals";
  if (!hasExpectedShape) {
    throw new TypeError(`${entry} did not create the expected plugin`);
  }
}

// Every public entry exports exactly these runtime values. `src/unplugin.ts`
// also exports helpers for the adapters and the package's own tests
// (`canTransform`, `resolveEsbuildLoader`, `createBundlerPlugin`, `pluginName`,
// ...); a stray `export *` would quietly turn them into public API.
const expectedRuntimeExports = ["REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS", "default", "reactFineGrainedSignals"];
const expectedTypeExports = [
  "ReactFineGrainedSignalsDiagnosticId",
  "ReactFineGrainedSignalsDiagnosticsOptions",
  "ReactFineGrainedSignalsFilterPattern",
  "ReactFineGrainedSignalsMode",
  "ReactFineGrainedSignalsOptions",
  "ReactFineGrainedSignalsReactCompiler",
  "ReactFineGrainedSignalsTransform",
];
const adapterTypeExports = {
  index: [],
  vite: ["VitePlugin"],
  rollup: ["RollupPlugin"],
  webpack: ["WebpackPlugin"],
  rspack: ["RspackPlugin"],
  esbuild: ["EsbuildPlugin"],
};
const internalNames = [
  "canTransform",
  "createModuleFilter",
  "resolveEsbuildLoader",
  "createBundlerPlugin",
  "pluginName",
  "EsbuildLoaderName",
  "BundlerTransformOutput",
];
const { readFile: readDistFile } = await import("node:fs/promises");
for (const [entry, adapterTypes] of Object.entries(adapterTypeExports)) {
  const runtimeExports = Object.keys(await import(`../dist/${entry}.js`)).toSorted();
  if (JSON.stringify(runtimeExports) !== JSON.stringify(expectedRuntimeExports)) {
    throw new TypeError(
      `${entry}.js exports ${runtimeExports.join(", ")}; expected ${expectedRuntimeExports.join(", ")}`,
    );
  }
  const declaration = await readDistFile(new URL(`../dist/${entry}.d.ts`, import.meta.url), "utf8");
  if (/^export\s*\*/m.test(declaration)) {
    throw new TypeError(`${entry}.d.ts must not re-export a whole module`);
  }
  const exportedNames = [
    ...[...declaration.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)]
      .flatMap((match) => match[1].split(","))
      .map((specifier) => specifier.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((specifier) => specifier.split(/\s+as\s+/).at(-1)),
    ...[
      ...declaration.matchAll(
        /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([\w$]+)/gm,
      ),
    ].map((match) => match[1]),
  ].toSorted();
  const expectedNames = [...expectedRuntimeExports, ...expectedTypeExports, ...adapterTypes].toSorted();
  if (JSON.stringify(exportedNames) !== JSON.stringify(expectedNames)) {
    throw new TypeError(`${entry}.d.ts exports ${exportedNames.join(", ")}; expected ${expectedNames.join(", ")}`);
  }
  for (const name of internalNames) {
    if (exportedNames.includes(name)) throw new TypeError(`${entry}.d.ts must not export the internal ${name}`);
  }
}

// The webpack/rspack adapters hand this exact path to the compiler as a loader
// module, resolved relative to their own module URL, so a rename or a missing
// emit would only surface as a broken build in a consumer's project.
const loaderModule = await import("../dist/loader.js");
if (typeof loaderModule.default !== "function") {
  throw new TypeError("loader.js must expose the transform loader as its default export");
}

for (const entry of ["webpack", "rspack"]) {
  const declaration = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL(`../dist/${entry}.d.ts`, import.meta.url), "utf8"),
  );
  if (/\b(?:Webpack|Rspack)PluginInstance\b/.test(declaration)) {
    throw new TypeError(`${entry} declaration leaks an unresolved compiler-plugin type`);
  }
}

const artifacts = await import("node:fs/promises").then(({ readdir }) => readdir(new URL("../dist/", import.meta.url)));
if (artifacts.some((artifact) => artifact.endsWith(".cjs") || artifact.endsWith(".d.cts"))) {
  throw new TypeError("The ESM-only package must not emit CommonJS artifacts");
}

// A CommonJS build config (`webpack.config.js` / `next.config.js` without
// `"type": "module"`) loads this package with `require()`. There is no CJS
// build: the `default` export condition points `require` at the same ESM files,
// which Node's `require(esm)` loads (unflagged since 20.19 / 22.12, so within
// this package's `engines`). Resolved by the package's own name -- Node's
// self-reference -- so the `exports` map itself is what is under test, not a
// file path that would bypass it.
const { createRequire } = await import("node:module");
const requireFromPackage = createRequire(import.meta.url);
for (const entry of entries) {
  const required = requireFromPackage(`unplugin-react-fine-grained-signals/${entry}`);
  if (typeof required.default !== "function") {
    throw new TypeError(`require() of the ${entry} entry must expose the plugin factory as .default`);
  }
}
if (typeof requireFromPackage("unplugin-react-fine-grained-signals").reactFineGrainedSignals !== "object") {
  throw new TypeError("require() of the root entry must expose reactFineGrainedSignals");
}
