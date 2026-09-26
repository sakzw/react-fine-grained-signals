import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildConsumer } from "vite";
import { build as buildPackage } from "tsdown";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productionDist = join(repositoryRoot, "dist");
if (!existsSync(join(productionDist, "index.js"))) throw new Error("Run pnpm build before the package-faithful comparison");
const temporary = mkdtempSync(join(tmpdir(), "rfgs-phase6-package-size-"));
const candidateDist = join(temporary, "candidate-c1-dist");
const sizeRoot = join(temporary, "consumers");

const entries = {
  index: "src/index.ts",
  "jsx-runtime": "src/jsx-runtime.ts",
  "jsx-dev-runtime": "src/jsx-dev-runtime.ts",
  runtime: "src/runtime.ts",
  utils: "src/utils.tsx",
};
const fixture = (name) => join(repositoryRoot, "tests/phase6/fixtures", name);
const scenarioEntries = [
  ["signal-only", `import { signal } from "DIST/index.js"; export default [signal];`],
  ["core", `import { signal, computed, effect, batch, untracked } from "DIST/index.js"; export default [signal, computed, effect, batch, untracked];`],
  ["core+hooks", `import { signal, computed, effect, useSignal, useSignalValue, useSignalTracking, useComputed, useSignalEffect } from "DIST/index.js"; export default [signal, computed, effect, useSignal, useSignalValue, useSignalTracking, useComputed, useSignalEffect];`],
  ["deep", `import { deepSignal, useDeepSignal, useDeepSignalValue } from "DIST/index.js"; export default [deepSignal, useDeepSignal, useDeepSignalValue];`],
  ["index-full", `import * as everything from "DIST/index.js"; export default everything;`],
  ["jsx-runtime", `import * as runtime from "DIST/jsx-runtime.js"; export default runtime;`],
  ["utils", `import { Show, Switch, Match, For, Index } from "DIST/utils.js"; export default [Show, Switch, Match, For, Index];`],
];
const deepMarker = "deepSignal() only accepts a plain object or array root";
const reactMarker = "useSyncExternalStore";
const external = ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"];

async function measureScenarios(label, dist) {
  console.log(`\n${label}`);
  for (const [name, source] of scenarioEntries) {
    const entryDir = join(sizeRoot, label, name);
    mkdirSync(entryDir, { recursive: true });
    const entry = join(entryDir, "entry.js");
    writeFileSync(entry, source.replaceAll("DIST", dist.replaceAll("\\", "/")));
    const outDir = join(entryDir, "out");
    await buildConsumer({
      logLevel: "silent",
      configFile: false,
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        lib: { entry, formats: ["es"], fileName: () => "bundle.js" },
        rollupOptions: { external },
      },
    });
    const bytes = readFileSync(join(outDir, "bundle.js"));
    const text = bytes.toString("utf8");
    const sizes = {
      raw: bytes.byteLength,
      gzip: gzipSync(bytes, { level: 9 }).byteLength,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    };
    const deepPresent = text.includes(deepMarker);
    const reactPresent = text.includes(reactMarker);
    console.log(`  controls: deep=${deepPresent ? "present" : "absent"}, React=${reactPresent ? "present" : "absent"}`);
    console.log(`${name.padEnd(12)} raw ${(sizes.raw / 1024).toFixed(2)} kB, gzip ${(sizes.gzip / 1024).toFixed(2)} kB, br ${(sizes.brotli / 1024).toFixed(2)} kB`);
  }
}

try {
  mkdirSync(sizeRoot, { recursive: true });
  await buildPackage({
    config: false,
    entry: entries,
    outDir: candidateDist,
    format: "esm",
    platform: "neutral",
    sourcemap: true,
    dts: false,
    clean: true,
    deps: {
      alwaysBundle: [/^alien-signals(?:\/|$)/],
      neverBundle: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/],
    },
    alias: {
      "./base.js": fixture("candidate-c1-base.ts"),
      "./deep-signal.js": fixture("candidate-c1-deep-signal.ts"),
    },
  });
  await measureScenarios("A-production-dist", productionDist);
  await measureScenarios("C1-tsdown-dist", candidateDist);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
