import { resolve } from "node:path";
import { build } from "tsdown";

await build({
  config: false,
  entry: { "lean-entry": resolve(import.meta.dirname, "lean-entry.ts") },
  outDir: resolve(import.meta.dirname, "../../node_modules/.cache/prototype-a"),
  format: "esm",
  platform: "neutral",
  dts: false,
  sourcemap: false,
  clean: true,
});
