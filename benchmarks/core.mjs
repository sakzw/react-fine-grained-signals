import os from "node:os";
import { computed as rawComputed, effect as rawEffect, endBatch, signal as rawSignal, startBatch } from "alien-signals";
import * as current from "../dist/index.js";

const iterations = Number.parseInt(process.argv[2] ?? process.env.BENCH_ITERATIONS ?? "100000", 10);
const warmups = 3;
const samples = 9;
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("BENCH_ITERATIONS must be a positive integer");

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const percentile = (values, ratio) => {
  const index = (values.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
};

function rawAdapter() {
  return {
    name: "alien-signals (raw)",
    signal(value) { const source = rawSignal(value); return { get: () => source(), set: (next) => source(next) }; },
    computed(read) { const source = rawComputed(read); return { get: () => source() }; },
    effect: rawEffect,
    batch(callback) { startBatch(); try { return callback(); } finally { endBatch(); } },
  };
}

function currentAdapter() {
  return {
    name: "react-alien-signals",
    signal(value) { const source = current.signal(value); return { get: () => source.value, set: (next) => { source.value = next; } }; },
    computed(read) { const source = current.computed(read); return { get: () => source.value }; },
    effect: current.effect,
    batch: current.batch,
  };
}

async function preactAdapter() {
  try {
    const preact = await import("@preact/signals-core");
    return {
      name: "@preact/signals-core",
      signal(value) { const source = preact.signal(value); return { get: () => source.value, set: (next) => { source.value = next; } }; },
      computed(read) { const source = preact.computed(read); return { get: () => source.value }; },
      effect: preact.effect,
      batch: preact.batch,
    };
  } catch (error) {
    console.log(`@preact/signals-core: skipped (${error.code ?? "not installed"})`);
  }
}

const cases = [
  {
    name: "signal/read",
    create(adapter) { return { source: adapter.signal(7), sum: 0 }; },
    run(state, count) { let sum = 0; for (let index = 0; index < count; index += 1) sum += state.source.get(); state.sum = sum; },
    check(state, count) { assert(state.sum === count * 7, "read result is incorrect"); },
  },
  {
    name: "signal/write",
    create(adapter) { return { source: adapter.signal(0) }; },
    run(state, count) { for (let index = 0; index < count; index += 1) state.source.set(index + 1); },
    check(state, count) { assert(state.source.get() === count, "write lost the final value"); },
  },
  {
    name: "signal/observed-write",
    create(adapter) {
      const source = adapter.signal(0); let runs = 0;
      const dispose = adapter.effect(() => { source.get(); runs += 1; });
      return { source, get runs() { return runs; }, dispose };
    },
    run(state, count) { for (let index = 0; index < count; index += 1) state.source.set(index + 1); },
    check(state, count) { assert(state.runs === count + 1, "observed write did not notify once per change"); },
  },
  {
    name: "computed/update-and-read",
    create(adapter) {
      const source = adapter.signal(0); const doubled = adapter.computed(() => source.get() * 2);
      return { source, doubled, sum: 0 };
    },
    run(state, count) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) { state.source.set(index + 1); sum += state.doubled.get(); }
      state.sum = sum;
    },
    check(state, count) {
      assert(state.doubled.get() === count * 2, "computed final value is incorrect");
      assert(state.sum === count * (count + 1), "computed result is incorrect");
    },
  },
  {
    name: "batch/two-observed-writes",
    create(adapter) {
      const left = adapter.signal(0); const right = adapter.signal(0); const total = adapter.computed(() => left.get() + right.get()); let runs = 0;
      const dispose = adapter.effect(() => { total.get(); runs += 1; });
      return { left, right, total, adapter, get runs() { return runs; }, dispose };
    },
    run(state, count) {
      for (let index = 0; index < count; index += 1) state.adapter.batch(() => { state.left.set(index + 1); state.right.set(index + 1); });
    },
    check(state, count) {
      assert(state.total.get() === count * 2, "batch computed value is incorrect");
      assert(state.runs === count + 1, "batch did not coalesce updates");
    },
  },
];

function benchmark(adapter, definition) {
  // Every semantic assertion is kept outside timing to prevent an invalid fast path.
  const checked = definition.create(adapter); definition.run(checked, Math.min(iterations, 1_000)); definition.check(checked, Math.min(iterations, 1_000)); checked.dispose?.();
  for (let round = 0; round < warmups; round += 1) { const state = definition.create(adapter); definition.run(state, iterations); state.dispose?.(); }
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const state = definition.create(adapter); const start = process.hrtime.bigint(); definition.run(state, iterations);
    timings.push(Number(process.hrtime.bigint() - start) / 1e9); definition.check(state, iterations); state.dispose?.();
  }
  timings.sort((left, right) => left - right);
  const median = percentile(timings, 0.5);
  return { case: definition.name, "median ops/s": (iterations / median).toLocaleString("en-US", { maximumFractionDigits: 0 }), "p25 ms": (percentile(timings, 0.25) * 1e3).toFixed(3), "p75 ms": (percentile(timings, 0.75) * 1e3).toFixed(3) };
}

const adapters = [rawAdapter(), currentAdapter()];
const preact = await preactAdapter();
if (preact) adapters.push(preact);
console.log(`Node ${process.version}; ${iterations.toLocaleString()} operations; ${samples} samples after ${warmups} warmups`);
console.log(`${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log("Manual diagnostics only: compare results only on identical Node versions and hardware.");
for (const adapter of adapters) { console.log(`\n${adapter.name}`); console.table(cases.map((definition) => benchmark(adapter, definition))); }
