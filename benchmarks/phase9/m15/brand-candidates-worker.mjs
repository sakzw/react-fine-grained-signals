import { performance } from "node:perf_hooks";
import * as bare from "./alien-derived-runtime-objectis.mjs";
import * as variants from "./alien-derived-runtime-brand-candidates.mjs";
import { createWorkload } from "../workloads.mjs";
const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, caseId, size, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
const mapping = runtimeId === "bare" ? [bare.signalClassInline, bare.computed] : ({
  "weakset-brand": [variants.signalClassBrandWeakSet, variants.computedClassBrandWeakSet],
  "helper-brand": [variants.signalClassBrandHelper, variants.computedClassBrandHelper],
  "direct-brand": [variants.signalClassBrandDirect, variants.computedClassBrandDirect],
})[runtimeId];
if (!mapping) throw new Error(`Unknown runtime ${runtimeId}`);
const api = { signal: mapping[0], read: (x) => x.value, write: (x, v) => { x.value = v; }, computed: mapping[1], readComputed: (x) => x.value, effect: variants.effect, dispose: (stop) => stop(), batch: variants.batch, supportsBatch: true };
function execute(count, timed) {
  const workload = createWorkload(kind, api, count, size);
  if (workload.notApplicable) throw new Error(`${caseId}: not applicable: ${workload.notApplicable}`);
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return null; }
    const start = performance.now(); workload.run(state);
    const elapsed = Math.round((performance.now() - start) * 1e6);
    workload.verify(state); return elapsed;
  } finally { workload.dispose?.(state); }
}
execute(Math.min(iterations, 4), false);
if (preflightOnly) process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, caseId }));
else {
  for (let i = 0; i < warmups; i += 1) { global.gc?.(); execute(iterations, false); }
  const durationsNs = [];
  for (let i = 0; i < samples; i += 1) { global.gc?.(); durationsNs.push(execute(iterations, true)); }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, caseId, durationsNs }));
}
