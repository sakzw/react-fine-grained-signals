import { performance } from "node:perf_hooks";
import * as baseline from "./alien-derived-runtime.mjs";
import * as objectis from "./alien-derived-runtime-objectis.mjs";
import { createWorkload } from "../workloads.mjs";

const input = JSON.parse(process.argv[2] ?? "{}");
const { variant, caseId, kind, size, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
const selected = variant === "objectis" ? objectis : baseline;
const api = {
  signal: selected.signalClassInline,
  read: (value) => value.value,
  write: (value, next) => { value.value = next; },
  computed: selected.computed,
  readComputed: (value) => value.value,
  effect: selected.effect,
  dispose: (stop) => stop(),
  batch: selected.batch,
  supportsBatch: true,
};
function execute(timed) {
  const workload = createWorkload(kind, api, iterations, size);
  if (workload.notApplicable) throw new Error(`${caseId} not applicable: ${workload.notApplicable}`);
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return null; }
    const start = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - start) * 1e6);
    workload.verify(state);
    return durationNs;
  } finally { workload.dispose?.(state); }
}
execute(false);
if (preflightOnly) {
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations }));
} else {
  for (let index = 0; index < warmups; index += 1) { global.gc?.(); execute(false); }
  const durationsNs = [];
  for (let sample = 0; sample < samples; sample += 1) { global.gc?.(); durationsNs.push(execute(true)); }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations, durationsNs }));
}
