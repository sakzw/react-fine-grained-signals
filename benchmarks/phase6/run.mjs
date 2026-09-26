import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(join(tmpdir(), "rfgs-phase6-"));
const outDir = join(temporary, "bundle");
mkdirSync(outDir, { recursive: true });

try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      lib: { entry: join(root, "tests/phase6/fixtures/benchmark-entry.ts"), formats: ["es"], fileName: () => "candidates.js" },
    },
  });
  const source = readFileSync(join(outDir, "candidates.js"));
  console.log("Fixture bundle (all three candidates loaded):", {
    raw: source.byteLength,
    gzip: gzipSync(source, { level: 9 }).byteLength,
    brotli: brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  });
  const { createCandidateA, createCandidateB, createCandidateC } = await import(pathToFileURL(join(outDir, "candidates.js")));
  const iterations = Number.parseInt(process.env.PHASE6_ITERATIONS ?? "100000", 10);
  const samples = Number.parseInt(process.env.PHASE6_SAMPLES ?? "5", 10);
  const warmups = 2;
  const packageRevision = process.env.PHASE6_REVISION ?? "not supplied (use git rev-parse HEAD)";
  const factories = [["A", createCandidateA], ["B", createCandidateB], ["C", createCandidateC]];
  const cases = [
    ["signal raw read", (api, n) => { const s = api.signal(1); let sum = 0; for (let i = 0; i < n; i++) sum += s.value; if (sum !== n) throw Error("read mismatch"); }],
    ["unobserved write", (api, n) => { const s = api.signal(0); for (let i = 0; i < n; i++) s.value = i + 1; if (s.value !== n) throw Error("write mismatch"); }],
    ["computed update/read", (api, n) => { const s = api.signal(0); const d = api.computed(() => s.value * 2); let sum = 0; for (let i = 0; i < n; i++) { s.value = i + 1; sum += d.value; } if (sum !== n * (n + 1)) throw Error("computed mismatch"); }],
    ["observed write", (api, n) => { const s = api.signal(0); let runs = 0; const stop = api.effect(() => { s.value; runs++; }); for (let i = 0; i < n; i++) s.value = i + 1; stop(); if (runs !== n + 1) throw Error("effect mismatch"); }],
    ["hot computed read", (api, n) => { const d = api.computed(() => 2); if (d.value !== 2) throw Error("computed mismatch"); let sum = 0; for (let i = 0; i < n; i++) sum += d.value; if (sum !== 2 * n) throw Error("hot read mismatch"); }],
    ["batch two writes", (api, n) => { const a = api.signal(0); const b = api.signal(0); const sum = api.computed(() => a.value + b.value); let runs = 0; const stop = api.effect(() => { sum.value; runs++; }); for (let i = 0; i < n; i++) api.batch(() => { a.value = i + 1; b.value = i + 1; }); stop(); if (runs !== n + 1) throw Error("batch mismatch"); }],
    ["effect create/dispose", (api, n) => { const s = api.signal(0); for (let i = 0; i < n; i++) api.effect(() => { s.value; })(); }],
    ["signal create", (api, n) => { const all = Array.from({ length: n }, (_, i) => api.signal(i)); if (all.length !== n) throw Error("create mismatch"); }],
    ["computed create", (api, n) => { const all = Array.from({ length: n }, (_, i) => api.computed(() => i)); if (all.length !== n) throw Error("computed create mismatch"); }],
    ["signal create + discard", (api, n) => { for (let i = 0; i < n; i++) api.signal(i); }],
    ["computed create + discard", (api, n) => { for (let i = 0; i < n; i++) api.computed(() => i); }],
  ];
  const rows = [];
  for (const [label, make] of factories) {
    const api = make();
    for (const [name, run] of cases) {
      const count = name === "batch two writes" || name === "observed write" || name === "effect create/dispose" ? Math.max(1, Math.floor(iterations / 10)) : iterations;
      for (let i = 0; i < warmups; i++) run(api, Math.min(1_000, count));
      const timings = [];
      for (let i = 0; i < samples; i++) {
        global.gc?.();
        const start = process.hrtime.bigint();
        run(api, count);
        timings.push(Number(process.hrtime.bigint() - start) / 1e9);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)];
      rows.push({ candidate: label, case: name, operations: count, medianMs: +(median * 1000).toFixed(3), opsPerSecond: Math.round(count / median) });
    }

    if (global.gc) {
      for (const [shape, create] of [["signal", (i) => api.signal(i)], ["computed", (i) => api.computed(() => i)]]) {
        const heap = [];
        for (let sample = 0; sample < samples; sample++) {
          global.gc();
          const before = process.memoryUsage().heapUsed;
          const held = Array.from({ length: iterations }, (_, i) => create(i));
          global.gc();
          heap.push((process.memoryUsage().heapUsed - before) / iterations);
          held.length = 0;
          global.gc();
        }
        const median = heap.toSorted((a, b) => a - b)[Math.floor(heap.length / 2)];
        console.log(`${label} retained ${shape} heap median bytes/instance: ${Math.round(median)}`);
      }
    }
  }
  console.log(`Node ${process.version}; ${iterations} iterations; ${warmups} warmups; ${samples} samples; ${process.platform}/${process.arch}; ${process.env.PROCESSOR_IDENTIFIER ?? "CPU not reported"}; revision ${packageRevision}`);
  console.table(rows);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
