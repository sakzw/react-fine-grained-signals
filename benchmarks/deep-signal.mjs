import os from "node:os";
import { deepSignal, effect } from "../dist/index.js";

const iterations = Number.parseInt(process.argv[2] ?? process.env.BENCH_ITERATIONS ?? "50000", 10);
const warmups = 3;
const samples = 9;
if (typeof deepSignal !== "function") throw new Error("deepSignal is absent from dist; build after adding the public API");
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("BENCH_ITERATIONS must be a positive integer");

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const percentile = (values, ratio) => {
  const index = (values.length - 1) * ratio; const low = Math.floor(index); const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
};

const cases = [
  {
    name: "deep/nested-read",
    create() { return { state: deepSignal({ a: { b: { value: 7 } } }), sum: 0 }; },
    run(context, count) { let sum = 0; for (let index = 0; index < count; index += 1) sum += context.state.value.a.b.value; context.sum = sum; },
    check(context, count) { assert(context.sum === count * 7, "nested read result is incorrect"); },
  },
  {
    name: "deep/observed-leaf-write",
    create() {
      const state = deepSignal({ a: { b: 0 } }); let runs = 0;
      const dispose = effect(() => { state.value.a.b; runs += 1; });
      return { state, get runs() { return runs; }, dispose };
    },
    run(context, count) { for (let index = 0; index < count; index += 1) context.state.value.a.b = index + 1; },
    check(context, count) { assert(context.state.value.a.b === count, "leaf write lost the final value"); assert(context.runs === count + 1, "leaf subscriber did not run once per write"); },
  },
  {
    name: "deep/sibling-isolation",
    create() {
      const state = deepSignal({ left: { value: 1 }, right: { value: 0 } }); let leftRuns = 0;
      const dispose = effect(() => { state.value.left.value; leftRuns += 1; });
      return { state, get leftRuns() { return leftRuns; }, dispose };
    },
    run(context, count) { for (let index = 0; index < count; index += 1) context.state.value.right.value = index + 1; },
    check(context, count) { assert(context.state.value.right.value === count, "sibling write lost the final value"); assert(context.leftRuns === 1, "unrelated sibling notified the leaf subscriber"); },
  },
  {
    name: "deep/parent-replacement",
    create() {
      const state = deepSignal({ a: { b: 0 } }); let runs = 0;
      const dispose = effect(() => { state.value.a.b; runs += 1; });
      return { state, get runs() { return runs; }, dispose };
    },
    run(context, count) { for (let index = 0; index < count; index += 1) context.state.value.a = { b: index + 1 }; },
    check(context, count) { assert(context.state.value.a.b === count, "parent replacement lost the new child"); assert(context.runs === count + 1, "parent replacement did not notify the child reader"); },
  },
  {
    name: "deep/array-push",
    create() {
      const state = deepSignal({ items: [] }); let runs = 0;
      const dispose = effect(() => { state.value.items.length; runs += 1; });
      return { state, get runs() { return runs; }, dispose };
    },
    run(context, count) { for (let index = 0; index < count; index += 1) context.state.value.items.push(index); },
    check(context, count) { assert(context.state.value.items.length === count, "array push lost an item"); assert(context.runs === count + 1, "array length subscriber did not run once per push"); },
  },
];

function benchmark(definition) {
  // Correctness is deliberately outside the measured region.
  const checked = definition.create(); definition.run(checked, Math.min(iterations, 1_000)); definition.check(checked, Math.min(iterations, 1_000)); checked.dispose?.();
  for (let round = 0; round < warmups; round += 1) { const state = definition.create(); definition.run(state, iterations); state.dispose?.(); }
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const state = definition.create(); const start = process.hrtime.bigint(); definition.run(state, iterations);
    timings.push(Number(process.hrtime.bigint() - start) / 1e9); definition.check(state, iterations); state.dispose?.();
  }
  timings.sort((left, right) => left - right); const median = percentile(timings, 0.5);
  return { case: definition.name, "median ops/s": (iterations / median).toLocaleString("en-US", { maximumFractionDigits: 0 }), "p25 ms": (percentile(timings, 0.25) * 1e3).toFixed(3), "p75 ms": (percentile(timings, 0.75) * 1e3).toFixed(3) };
}

console.log(`Node ${process.version}; ${iterations.toLocaleString()} operations; ${samples} samples after ${warmups} warmups`);
console.log(`${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log("Manual diagnostics only: compare results only on identical Node versions and hardware.");
console.table(cases.map(benchmark));
