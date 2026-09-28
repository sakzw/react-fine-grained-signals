import { performance } from "node:perf_hooks";
import * as bare from "./alien-derived-runtime-objectis.mjs";
import * as publicApi from "./alien-derived-runtime-public.mjs";
import { createWorkload } from "../workloads.mjs";
const input = JSON.parse(process.argv[2] ?? "{}");
const { variant, caseId, kind, size, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
const runtime = variant === "public" ? publicApi : bare;
const api = {
  signal: variant === "public" ? publicApi.signal : bare.signalClassInline,
  read: (value) => value.value,
  write: (value, next) => { value.value = next; },
  computed: runtime.computed,
  readComputed: (value) => value.value,
  effect: runtime.effect,
  dispose: (stop) => stop(),
  batch: runtime.batch,
  supportsBatch: true,
};
function execute(timed) {
  const workload = createWorkload(kind, api, iterations, size);
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return null; }
    const start = performance.now(); workload.run(state);
    const durationNs = Math.round((performance.now() - start) * 1e6);
    workload.verify(state); return durationNs;
  } finally { workload.dispose?.(state); }
}
execute(false);
if (preflightOnly) process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations }));
else {
  for (let index = 0; index < warmups; index += 1) { global.gc?.(); execute(false); }
  const durationsNs = [];
  for (let sample = 0; sample < samples; sample += 1) { global.gc?.(); durationsNs.push(execute(true)); }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", variant, caseId, iterations, durationsNs }));
}
