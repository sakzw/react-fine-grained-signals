import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entries = ["vite", "rollup", "webpack", "rspack", "esbuild"];

for (const entry of entries) {
  const esm = await import(`../dist/${entry}.js`);
  const commonJs = require(`../dist/${entry}.cjs`);
  const cjsDefault = commonJs.default ?? commonJs;

  if (typeof esm.default !== "function" || typeof cjsDefault !== "function") {
    throw new TypeError(`${entry} must expose callable ESM and CommonJS plugin factories`);
  }

  const esmPlugin = esm.default({ mode: "auto" });
  const cjsPlugin = cjsDefault({ mode: "auto" });
  const isCompilerPlugin = entry === "webpack" || entry === "rspack";
  const hasExpectedShape = isCompilerPlugin
    ? typeof esmPlugin?.apply === "function" && typeof cjsPlugin?.apply === "function"
    : esmPlugin?.name === "unplugin-react-alien-signals" && cjsPlugin?.name === "unplugin-react-alien-signals";
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
