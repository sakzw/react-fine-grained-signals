import { performance } from "node:perf_hooks";
import { createWorkload } from "../workloads.mjs";
import * as noRender from "./alien-derived-runtime-objectis.mjs";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
const renderURL = new URL("./alien-derived-runtime-render.mjs", import.meta.url);
let api;
let foreignCopy;

if (runtimeId === "m15-objectis") {
  api = {
    signal: noRender.signalClassHelper,
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    computed: noRender.computed,
    readComputed: (value) => value.value,
    effect: noRender.effect,
    dispose: (stop) => stop(),
    batch: noRender.batch,
    supportsBatch: true,
  };
} else {
  const query = `?worker=${process.pid}-local`;
  const local = await import(new URL(`${renderURL.href}${query}`));
  const signal = runtimeId === "m15-render-helper-call" ? local.signalClassBrandHelperCalls : local.signalClassBrandHelper;
  api = {
    signal,
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    computed: local.computedClassBrandHelper,
    readComputed: (value) => value.value,
    effect: local.effect,
    dispose: (stop) => stop(),
    batch: local.batch,
    supportsBatch: true,
  };
  if (runtimeId === "m15-render-foreign") {
    foreignCopy = await import(new URL(`${renderURL.href}?worker=${process.pid}-foreign`));
    api.signal = foreignCopy.signalClassBrandHelper;
  }
}

function execute(timed) {
  const workload = createWorkload(kind, api, iterations, 1);
  const state = workload.setup();
  try {
    if (!timed) { workload.run(state); workload.verify(state); return; }
    const started = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - started) * 1e6);
    workload.verify(state);
    return durationNs;
  } finally { workload.dispose?.(state); }
}

execute(false);
if (preflightOnly) {
  process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, kind, iterations }));
  process.exit(0);
}
for (let index = 0; index < warmups; index += 1) { global.gc?.(); execute(false); }
const durationsNs = [];
for (let sample = 0; sample < samples; sample += 1) { global.gc?.(); durationsNs.push(execute(true)); }
process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, kind, iterations, durationsNs }));
