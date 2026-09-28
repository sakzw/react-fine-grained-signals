import { performance } from "node:perf_hooks";
import { loadAdapter } from "../adapters.mjs";
import { createWorkload } from "../workloads.mjs";
import * as prototype from "./alien-derived-runtime.mjs";

const { runtimeId, kind, iterations, warmups, samples } = JSON.parse(process.argv[2] ?? "{}");
let api;
if (runtimeId.startsWith("m15-")) {
  let signal;
  let runtime;
  if (runtimeId.startsWith("m15-bundle-")) {
    const variant = runtimeId.slice("m15-bundle-".length);
    const entry = variant === "class-helper"
      ? "entry-class-helper.mjs"
      : variant === "class-inline"
        ? "entry-class-inline.mjs"
        : "entry-bound-descriptor.mjs";
    runtime = await import(`./bundled/${entry}`);
    signal = runtime.signal;
  } else {
    signal = prototype.signal;
    if (runtimeId.endsWith("-bound")) signal = prototype.signalBoundAccessor;
    else if (runtimeId.endsWith("-class-helper")) signal = prototype.signalClassHelper;
    else if (runtimeId.endsWith("-class-inline")) signal = prototype.signalClassInline;
    else if (runtimeId.endsWith("-inline")) signal = prototype.signalInlineAccessor;
  }
  api = {
    signal,
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    computed: runtime?.computed ?? prototype.computed,
    readComputed: (value) => value.value,
    effect: runtime?.effect ?? prototype.effect,
    dispose: (stop) => stop(),
    batch: runtime?.batch ?? prototype.batch,
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
  };
} else {
  api = await loadAdapter(runtimeId);
}

function execute(timed) {
  const workload = createWorkload(kind, api, iterations, 1);
  const state = workload.setup();
  try {
    if (!timed) {
      workload.run(state);
      workload.verify(state);
      return;
    }
    const started = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - started) * 1e6);
    workload.verify(state);
    return durationNs;
  } finally {
    workload.dispose?.(state);
  }
}

execute(false);
for (let index = 0; index < warmups; index += 1) {
  global.gc?.();
  execute(false);
}
const durationsNs = [];
for (let index = 0; index < samples; index += 1) {
  global.gc?.();
  durationsNs.push(execute(true));
}
process.stdout.write(JSON.stringify({ durationsNs }));
