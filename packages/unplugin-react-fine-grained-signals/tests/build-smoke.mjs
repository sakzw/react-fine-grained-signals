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

const artifacts = await import("node:fs/promises").then(({ readdir }) =>
  readdir(new URL("../dist/", import.meta.url)),
);
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
