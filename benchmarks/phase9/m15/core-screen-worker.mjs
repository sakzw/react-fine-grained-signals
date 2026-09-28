import { performance } from "node:perf_hooks";
import { loadAdapter } from "../adapters.mjs";
import { createWorkload } from "../workloads.mjs";
import * as prototype from "./alien-derived-runtime.mjs";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, caseId, iterations, size, warmups = 3, samples = 7, preflightOnly = false } = input;
let api;
if (runtimeId === "m15-inline-class") {
  api = {
    signal: prototype.signalClassInline,
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    computed: prototype.computed,
    readComputed: (value) => value.value,
    effect: prototype.effect,
    dispose: (stop) => stop(),
    batch: prototype.batch,
    supportsBatch: true,
  };
} else if (runtimeId === "rfsg-current") {
  const current = await import("./current-dist/index.js");
  api = {
    signal: current.signal,
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    computed: current.computed,
    readComputed: (value) => value.value,
    effect: current.effect,
    dispose: (stop) => stop(),
    batch: current.batch,
    supportsBatch: true,
    directReadLoop: (source, count) => { let sum = 0; for (let index = 0; index < count; index += 1) sum += source.value; return sum; },
    adapterReadLoop: (source, count) => { let sum = 0; for (let index = 0; index < count; index += 1) sum += source.value; return sum; },
    deepSignal: current.deepSignal,
  };
} else {
  api = await loadAdapter(runtimeId);
}

function execute(iterationCount, timed) {
  const workload = createWorkload(kind, api, iterationCount, size);
  if (workload.notApplicable) return { status: "na", reason: workload.notApplicable };
  const state = workload.setup();
  try {
    if (!timed) {
      workload.run(state);
      workload.verify(state);
      return { status: "ok" };
    }
    const started = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - started) * 1e6);
    workload.verify(state);
    return { status: "ok", durationNs };
  } finally {
    workload.dispose?.(state);
  }
}

const smallIterations = Math.min(iterations, 4);
const preflight = execute(smallIterations, false);
if (preflight.status === "na") {
  process.stdout.write(JSON.stringify({ ...preflight, preflight: "not_applicable", runtimeId, caseId, size }));
} else if (preflightOnly) {
  process.stdout.write(JSON.stringify({ ...preflight, preflight: "passed", runtimeId, caseId, size }));
} else {
  for (let index = 0; index < warmups; index += 1) {
    global.gc?.();
    const warmup = execute(iterations, false);
    if (warmup.status === "na") {
      process.stdout.write(JSON.stringify({ ...warmup, preflight: "not_applicable", runtimeId, caseId, size }));
      process.exit(0);
    }
  }
  const durationsNs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const result = execute(iterations, true);
    if (result.status === "na") {
      process.stdout.write(JSON.stringify({ ...result, preflight: "not_applicable", runtimeId, caseId, size }));
      process.exit(0);
    }
    durationsNs.push(result.durationNs);
  }
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, caseId, size, durationsNs }));
}
