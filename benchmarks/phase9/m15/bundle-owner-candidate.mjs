import { build } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
for (const variant of [
  { id: "control", entry: "bundle-render-control-entry.mjs" },
  { id: "candidate", entry: "bundle-owner-candidate-entry.mjs" },
]) {
  const outDir = fileURLToPath(new URL(`./bundled/${variant.id}`, import.meta.url));
  const entry = fileURLToPath(new URL(`./${variant.entry}`, import.meta.url));
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
  process.stdout.write(`Built M1.5 ${variant.id} bundle: ${outDir}\n`);
}
