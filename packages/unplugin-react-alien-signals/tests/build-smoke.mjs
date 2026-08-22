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
    : esmPlugin?.name === "unplugin-react-alien-signals";
  if (!hasExpectedShape) {
    throw new TypeError(`${entry} did not create the expected plugin`);
  }
}

for (const entry of ["webpack", "rspack"]) {
  const declaration = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL(`../dist/${entry}.d.ts`, import.meta.url), "utf8"),
  );
  if (/=> (Webpack|Rspack)PluginInstance\b/.test(declaration)) {
    throw new TypeError(`${entry} declaration leaks an unresolved compiler-plugin type`);
  }
}

const artifacts = await import("node:fs/promises").then(({ readdir }) =>
  readdir(new URL("../dist/", import.meta.url)),
);
if (artifacts.some((artifact) => artifact.endsWith(".cjs") || artifact.endsWith(".d.cts"))) {
  throw new TypeError("The ESM-only package must not emit CommonJS artifacts");
}
