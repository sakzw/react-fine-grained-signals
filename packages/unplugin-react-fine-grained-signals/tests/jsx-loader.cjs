const { transformSync } = require("esbuild");

module.exports = function transformJsx(source) {
  const result = transformSync(source, {
    loader: "jsx",
    sourcefile: this.resourcePath,
    sourcemap: true,
    jsx: "automatic",
  });
  this.callback(null, result.code, result.map);
};
