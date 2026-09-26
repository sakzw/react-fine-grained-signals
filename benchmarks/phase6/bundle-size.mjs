import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "rfgs-phase6-size-"));
const source = `
  { name: "signal-only", source: 'import { signal } from "react-fine-grained-signals"; export default signal;' },
  { name: "core", source: 'import { signal, computed, effect, batch, untracked } from "react-fine-grained-signals"; export default [signal, computed, effect, batch, untracked];' },
  { name: "core+hooks", source: 'import { signal, computed, effect, useSignal, useSignalValue, useSignalTracking, useComputed, useSignalEffect } from "react-fine-grained-signals"; export default [signal, computed, effect, useSignal, useSignalValue, useSignalTracking, useComputed, useSignalEffect];' },
  { name: "deep", source: 'import { deepSignal, useDeepSignal, useDeepSignalValue } from "react-fine-grained-signals"; export default [deepSignal, useDeepSignal, useDeepSignalValue];' },
  { name: "index-full", source: 'import * as everything from "react-fine-grained-signals"; export default everything;' },
  { name: "jsx-runtime", source: 'import * as runtime from "react-fine-grained-signals/jsx-runtime"; export default runtime;' },
  { name: "utils", source: 'import { Show, Switch, Match, For, Index } from "react-fine-grained-signals/utils"; export default [Show, Switch, Match, For, Index];' },
`;
const scenarios = new Function(`return [${source}]`)();
const candidates = [
  { name: "A", aliases: [] },
  { name: "B", aliases: [
    ["./base.js", "tests/phase6/fixtures/candidate-b-base.ts"],
    ["./deep-signal.js", "tests/phase6/fixtures/candidate-b-deep-signal.ts"],
  ] },
  { name: "C", aliases: [
    ["./base.js", "tests/phase6/fixtures/candidate-c-base.ts"],
    ["./deep-signal.js", "tests/phase6/fixtures/candidate-c-deep-signal.ts"],
  ] },
];
const deepMarker = "deepSignal() only accepts a plain object or array root";
const reactMarker = "useSyncExternalStore";
const external = ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"];

try {
  for (const candidate of candidates) {
    console.log(`\nCandidate ${candidate.name}`);
    for (const scenario of scenarios) {
      const scenarioDir = join(temporary, candidate.name, scenario.name);
      mkdirSync(scenarioDir, { recursive: true });
      const entry = join(scenarioDir, "entry.js");
      writeFileSync(entry, scenario.source);
      const outDir = join(scenarioDir, "out");
      const aliases = [
        { find: "react-fine-grained-signals/jsx-runtime", replacement: join(root, "src/jsx-runtime.ts") },
        { find: "react-fine-grained-signals/jsx-dev-runtime", replacement: join(root, "src/jsx-dev-runtime.ts") },
        { find: "react-fine-grained-signals/utils", replacement: join(root, "src/utils.tsx") },
        { find: "react-fine-grained-signals", replacement: join(root, "src/index.ts") },
        ...candidate.aliases.map(([suffix, file]) => ({
          find: new RegExp(`${suffix.replaceAll(".", "\\.")}$`),
          replacement: join(root, file),
        })),
      ];
      await build({
        configFile: false,
        logLevel: "silent",
        resolve: { alias: aliases },
        build: {
          outDir,
          emptyOutDir: true,
          minify: true,
          lib: { entry, formats: ["es"], fileName: () => "bundle.js" },
          rollupOptions: { external },
        },
      });
      const code = readFileSync(join(outDir, "bundle.js"));
      const text = code.toString("utf8");
      const gzip = gzipSync(code, { level: 9 }).byteLength;
      const brotli = brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength;
      const raw = code.byteLength;
      console.log(`${scenario.name.padEnd(12)} ${(gzip / 1024).toFixed(2).padStart(8)} kB gzip ${(brotli / 1024).toFixed(2).padStart(8)} kB br ${(raw / 1024).toFixed(2).padStart(8)} kB raw`);
      if (["signal-only", "core", "core+hooks"].includes(scenario.name) && text.includes(deepMarker)) {
        throw new Error(`${candidate.name}/${scenario.name}: deepSignal did not tree-shake`);
      }
      if (["signal-only", "core"].includes(scenario.name) && text.includes(reactMarker)) {
        throw new Error(`${candidate.name}/${scenario.name}: React hook code did not tree-shake`);
      }
      if (["core+hooks", "index-full"].includes(scenario.name) && !text.includes(reactMarker)) {
        throw new Error(`${candidate.name}/${scenario.name}: React marker positive control failed`);
      }
      if (scenario.name === "deep" && !text.includes(deepMarker)) {
        throw new Error(`${candidate.name}/deep: deepSignal positive control failed`);
      }
      if (scenario.name === "index-full" && !text.includes(deepMarker)) {
        throw new Error(`${candidate.name}/index-full: deepSignal marker positive control failed`);
      }
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
