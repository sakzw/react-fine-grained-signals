import { gzipSync } from "node:zlib";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const variants = [
  { id: "candidate", entry: "./bundle-candidate-entry.mjs" },
  { id: "control", entry: "./alien-derived-deep-signal-control-entry.mjs" },
];
const outputs = [];
for (const variant of variants) {
  const outDir = fileURLToPath(new URL(`./bundled/${variant.id}`, import.meta.url));
  const entry = fileURLToPath(new URL(variant.entry, import.meta.url));
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    build: {
      lib: { entry, formats: ["es"], fileName: `m15-${variant.id}` },
      outDir,
      emptyOutDir: true,
      minify: true,
      rollupOptions: { external: ["react"] },
    },
  });
  const bundle = new URL(`./bundled/${variant.id}/m15-${variant.id}.js`, import.meta.url);
  const source = readFileSync(bundle);
  const text = source.toString("utf8");
  outputs.push({
    id: variant.id,
    file: fileURLToPath(bundle),
    rawBytes: statSync(bundle).size,
    gzipBytes: gzipSync(source, { level: 9 }).byteLength,
    alienSignalsExternalImport: /from\s*["']alien-signals\/system["']/.test(text),
    reactExternalImport: /from\s*["']react["']/.test(text),
    buildShape: "minified ESM; React remains external; other imports bundled",
  });
}
writeFileSync(new URL("./package-topology-results.json", import.meta.url), `${JSON.stringify(outputs, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(outputs)}\n`);
