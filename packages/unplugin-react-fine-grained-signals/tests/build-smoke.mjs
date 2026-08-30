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
