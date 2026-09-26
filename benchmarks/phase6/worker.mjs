import { pathToFileURL } from "node:url";

const [, , bundlePath, caseName, targetMsArg = "120", samplesArg = "3", warmupsArg = "3"] = process.argv;
if (!bundlePath || !caseName) throw new Error("Usage: worker.mjs <bundle> <case> [target-ms] [samples] [warmups]");
const targetMs = Number(targetMsArg);
const samples = Number(samplesArg);
const warmups = Number(warmupsArg);
const { create } = await import(pathToFileURL(bundlePath));
const api = create();

if (caseName === "heap-signal" || caseName === "heap-computed") {
  const count = Number(process.env.PHASE6_HEAP_COUNT ?? 50_000);
  if (!global.gc) throw new Error("Run heap workers with --expose-gc");
  const deltas = [];
  for (let sample = 0; sample < samples; sample++) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let held = caseName === "heap-signal"
      ? Array.from({ length: count }, (_, index) => api.signal(index))
      : Array.from({ length: count }, (_, index) => api.computed(() => index));
    if (held.length !== count) throw new Error("heap sample instance count mismatch");
    global.gc();
    deltas.push((process.memoryUsage().heapUsed - before) / count);
    held = [];
    global.gc();
  }
  const sorted = deltas.toSorted((a, b) => a - b);
  console.log(JSON.stringify({
    candidate: bundlePath.split(/[\\/]/).at(-1).replace(".js", ""),
    case: caseName,
    node: process.version,
    os: `${process.platform}/${process.arch}`,
    cpu: process.env.PROCESSOR_IDENTIFIER ?? "unknown",
    iterations: count,
    warmups: 0,
    samples: sorted.length,
    bytesPerInstance: sorted,
    medianBytesPerInstance: sorted[Math.floor(sorted.length / 2)],
    minBytesPerInstance: sorted[0],
    maxBytesPerInstance: sorted.at(-1),
  }));
  process.exit(0);
}

const cases = {
  "signal-read": (n) => { const signal = api.signal(1); let total = 0; for (let i = 0; i < n; i++) total += signal.value; if (total !== n) throw new Error("read mismatch"); },
  "unobserved-write": (n) => { const signal = api.signal(0); for (let i = 0; i < n; i++) signal.value = i + 1; if (signal.value !== n) throw new Error("write mismatch"); },
  "observed-write": (n) => { const signal = api.signal(0); let runs = 0; const dispose = api.effect(() => { signal.value; runs++; }); for (let i = 0; i < n; i++) signal.value = i + 1; dispose(); if (runs !== n + 1) throw new Error("observed write mismatch"); },
  "computed-update-read": (n) => { const signal = api.signal(0); const computed = api.computed(() => signal.value * 2); let total = 0; for (let i = 0; i < n; i++) { signal.value = i + 1; total += computed.value; } if (total !== n * (n + 1)) throw new Error("computed mismatch"); },
  "hot-computed-read": (n) => { const computed = api.computed(() => 1); let total = 0; for (let i = 0; i < n; i++) total += computed.value; if (total !== n) throw new Error("hot computed mismatch"); },
  batch: (n) => { const left = api.signal(0); const right = api.signal(0); const sum = api.computed(() => left.value + right.value); let runs = 0; const dispose = api.effect(() => { sum.value; runs++; }); for (let i = 0; i < n; i++) api.batch(() => { left.value = i + 1; right.value = i + 1; }); dispose(); if (runs !== n + 1) throw new Error("batch mismatch"); },
  "effect-create-dispose": (n) => { const signal = api.signal(0); for (let i = 0; i < n; i++) api.effect(() => { signal.value; })(); },
  "signal-create": (n) => { const values = Array.from({ length: n }, (_, i) => api.signal(i)); if (values.length !== n) throw new Error("signal create mismatch"); },
  "computed-create": (n) => { const values = Array.from({ length: n }, (_, i) => api.computed(() => i)); if (values.length !== n) throw new Error("computed create mismatch"); },
  "signal-create-discard": (n) => { for (let i = 0; i < n; i++) api.signal(i); },
  "computed-create-discard": (n) => { for (let i = 0; i < n; i++) api.computed(() => i); },
};

const run = cases[caseName];
if (run === undefined) throw new Error(`Unknown case: ${caseName}`);

function time(runCount) {
  const start = process.hrtime.bigint();
  run(runCount);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

let iterations = 256;
for (;;) {
  global.gc?.();
  const elapsed = time(iterations);
  if (elapsed >= targetMs || iterations >= 50_000_000) break;
  iterations *= Math.min(10, Math.max(2, Math.ceil(targetMs / Math.max(elapsed, 0.05))));
}

for (let i = 0; i < warmups; i++) time(iterations);
const samplesMs = [];
for (let i = 0; i < samples; i++) {
  global.gc?.();
  samplesMs.push(time(iterations));
}
const sorted = samplesMs.toSorted((a, b) => a - b);
console.log(JSON.stringify({
  candidate: bundlePath.split(/[\\/]/).at(-1).replace(".js", ""),
  case: caseName,
  node: process.version,
  os: `${process.platform}/${process.arch}`,
  cpu: process.env.PROCESSOR_IDENTIFIER ?? "unknown",
  iterations,
  targetMs,
  warmups,
  samples: sorted.length,
  samplesMs: sorted,
  medianMs: sorted[Math.floor(sorted.length / 2)],
  p25Ms: sorted[Math.floor((sorted.length - 1) * 0.25)],
  p75Ms: sorted[Math.ceil((sorted.length - 1) * 0.75)],
  minMs: sorted[0],
  maxMs: sorted.at(-1),
  opsPerSecond: Math.round(iterations / (sorted[Math.floor(sorted.length / 2)] / 1000)),
}));
