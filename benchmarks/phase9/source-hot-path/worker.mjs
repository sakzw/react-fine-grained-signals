import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWorkload } from "../workloads.mjs";
import { loadAdapter } from "../adapters.mjs";

const payload = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, size = 1, warmups, samples } = payload;
if (!runtimeId || !kind || !Number.isSafeInteger(iterations) || iterations < 1) throw new Error("Worker needs runtimeId, workload, and a positive iteration count.");
if (typeof global.gc !== "function") throw new Error("Run with --expose-gc.");

let api;
if (/^rfsg-(?:R[1-5]|W[0-4]|P[0-2])$/.test(runtimeId)) {
  const name = runtimeId.slice("rfsg-".length);
  const variant = await import(pathToFileURL(resolve(import.meta.dirname, `variants/${name}/dist/index.js`)));
  api = {
    runtimeId,
    signal: variant.signal,
    read: (source) => source.value,
    write: (source, value) => { source.value = value; },
    computed: variant.computed,
    readComputed: (value) => value.value,
    effect: variant.effect,
    dispose: (stop) => stop(),
    batch: variant.batch,
    supportsBatch: true,
  };
} else {
  api = await loadAdapter(runtimeId);
}

async function execute(count, timed) {
  const workload = createWorkload(kind, api, count, size);
  const state = workload.setup();
  try {
    if (!timed) {
      workload.run(state);
      workload.verify(state);
      return;
    }
    const startedAt = performance.now();
    workload.run(state);
    const durationNs = Math.round((performance.now() - startedAt) * 1e6);
    workload.verify(state);
    return { durationNs };
  } finally { workload.dispose?.(state); }
}

// A cheap semantic preflight catches a malformed diagnostic artifact before timing.
await execute(Math.min(iterations, 4), false);
for (let i = 0; i < warmups; i += 1) { global.gc(); await execute(iterations, false); }
const measured = [];
for (let i = 0; i < samples; i += 1) { global.gc(); measured.push(await execute(iterations, true)); }
process.stdout.write(JSON.stringify({ status: "ok", measured, warmups, samples, iterations, runtimeId, kind }));

