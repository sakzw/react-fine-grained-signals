import { createRequire } from "node:module";
import transform from "../dist/index.js";

const require = createRequire(import.meta.url);
const commonJs = require("../dist/index.cjs");
const commonJsTransform = commonJs.default ?? commonJs;

if (typeof transform !== "function" || typeof commonJsTransform !== "function") {
  throw new TypeError("The transform must expose callable ESM and CommonJS entries");
}
