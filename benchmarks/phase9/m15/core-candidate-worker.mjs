import { performance } from "node:perf_hooks";
import * as bare from "./alien-derived-runtime-brand-candidates.mjs";
import * as core from "./alien-derived-runtime-core.mjs";
import { createWorkload } from "../workloads.mjs";
const input = JSON.parse(process.argv[2] ?? "{}");
const { variant, kind, caseId, size, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
const chosen = variant === "core-errors" ? core : bare;
const api = { signal: chosen.signalClassBrandHelper, read: (x) => x.value, write: (x, v) => { x.value = v; }, computed: chosen.computedClassBrandHelper, readComputed: (x) => x.value, effect: chosen.effect, dispose: (stop) => stop(), batch: chosen.batch, supportsBatch: true };
function execute(timed) {
  const workload = createWorkload(kind, api, iterations, size);
  if (workload.notApplicable) throw new Error(`${caseId}: ${workload.notApplicable}`);
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return null; }
    const started = performance.now(); workload.run(state);
    const duration = Math.round((performance.now() - started) * 1e6);
    workload.verify(state); return duration;
  } finally { workload.dispose?.(state); }
}
execute(false);
if (preflightOnly) process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations }));
else {
  for (let i = 0; i < warmups; i += 1) { global.gc?.(); execute(false); }
  const durationsNs = [];
  for (let i = 0; i < samples; i += 1) { global.gc?.(); durationsNs.push(execute(true)); }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations, durationsNs }));
}
