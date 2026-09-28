import { performance } from "node:perf_hooks";
import { loadAdapter } from "../adapters.mjs";
import { createWorkload } from "../workloads.mjs";
import * as core from "./alien-derived-runtime-core.mjs";
import * as owner from "./alien-derived-runtime-owner-core.mjs";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, size, warmups = 3, samples = 7, preflightOnly = false } = input;
let api;
if (runtimeId === "m15-core") {
  api = { signal: core.signalClassBrandHelper, read: (x) => x.value, write: (x, v) => { x.value = v; }, computed: core.computedClassBrandHelper, readComputed: (x) => x.value, effect: core.effect, dispose: (stop) => stop(), batch: core.batch, supportsBatch: true };
} else if (runtimeId === "m151-integrated") {
  api = { signal: owner.signalClassBrandHelper, read: (x) => x.value, write: (x, v) => { x.value = v; }, computed: owner.computedClassBrandHelper, readComputed: (x) => x.value, effect: owner.effect, dispose: (stop) => stop(), batch: owner.batch, supportsBatch: true };
} else api = await loadAdapter(runtimeId);

function execute(count, timed) {
  const workload = createWorkload(kind, api, count, size);
  if (workload.notApplicable) return { status: "na", reason: workload.notApplicable };
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return { status: "ok" }; }
    const start = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - start) * 1e6);
    workload.verify(state);
    return { status: "ok", durationNs };
  } finally { workload.dispose?.(state); }
}
const preflight = execute(Math.min(iterations, 4), false);
if (preflight.status === "na" || preflightOnly) {
  process.stdout.write(JSON.stringify({ ...preflight, preflight: preflight.status === "na" ? "not_applicable" : "passed", runtimeId, kind, size }));
} else {
  for (let index = 0; index < warmups; index += 1) { global.gc?.(); execute(iterations, false); }
  const durationsNs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    durationsNs.push(execute(iterations, true).durationNs);
  }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, kind, size, durationsNs }));
}
