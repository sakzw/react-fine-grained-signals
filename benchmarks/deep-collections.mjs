import os from "node:os";
import { appendFileSync } from "node:fs";
import { deepSignal } from "../dist/index.js";

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "10000", 10);
const warmups = Number.parseInt(process.env.BENCH_WARMUPS ?? "2", 10);
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? "7", 10);
if (![iterations, warmups, samples].every(Number.isSafeInteger) || iterations < 1 || warmups < 0 || samples < 1) {
  throw new Error("Invalid collection benchmark iteration counts");
}
const collectionValue = (value) => process.env.BENCH_COLLECTIONS_REACTIVE === "true"
  ? deepSignal(value).value
  : value;

const cases = [
  {
    name: "Map/set-get-size",
    create() { return { collection: collectionValue(new Map()), sum: 0 }; },
    run(state, count) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) {
        state.collection.set(index, index);
        sum += state.collection.get(index) + state.collection.size;
      }
      state.sum = sum;
    },
    check(state, count) { if (state.collection.size !== count || state.sum !== count * count) throw new Error("Map result mismatch"); },
  },
  {
    name: "Map/iteration",
    iterations: Math.max(1, Math.floor(iterations / 100)),
    create() { return { collection: collectionValue(new Map(Array.from({ length: 1000 }, (_, index) => [index, index]))), sum: 0 }; },
    run(state, count) {
      let sum = 0;
      for (let round = 0; round < count; round += 1) for (const [key, value] of state.collection) sum += key + value;
      state.sum = sum;
    },
    check(state, count) { if (state.collection.size !== 1000 || state.sum !== count * 999000) throw new Error("Map iteration result mismatch"); },
  },
  {
    name: "Set/add-has-size",
    create() { return { collection: collectionValue(new Set()), sum: 0 }; },
    run(state, count) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) { state.collection.add(index); sum += Number(state.collection.has(index)) + state.collection.size; }
      state.sum = sum;
    },
    check(state, count) { if (state.collection.size !== count || state.sum !== count * (count + 3) / 2) throw new Error("Set result mismatch"); },
  },
  {
    name: "WeakMap/set-get",
    create() { return { collection: collectionValue(new WeakMap()), keys: Array.from({ length: 1000 }, () => ({})), sum: 0 }; },
    run(state, count) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) { const key = state.keys[index % state.keys.length]; state.collection.set(key, index); sum += state.collection.get(key); }
      state.sum = sum;
    },
    check(state, count) {
      const expected = Array.from({ length: count }, (_, index) => index).reduce((sum, value) => sum + value, 0);
      if (state.sum !== expected) throw new Error("WeakMap result mismatch");
    },
  },
  {
    name: "WeakSet/add-has",
    create() { return { collection: collectionValue(new WeakSet()), keys: Array.from({ length: 1000 }, () => ({})), sum: 0 }; },
    run(state, count) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) { const key = state.keys[index % state.keys.length]; state.collection.add(key); sum += Number(state.collection.has(key)); }
      state.sum = sum;
    },
    check(state, count) { if (state.sum !== count) throw new Error("WeakSet result mismatch"); },
  },
];

const percentile = (values, ratio) => {
  const index = (values.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
};

const results = cases.map((definition) => {
  const caseIterations = definition.iterations ?? iterations;
  const checked = definition.create();
  definition.run(checked, Math.min(caseIterations, 100));
  definition.check(checked, Math.min(caseIterations, 100));
  for (let warmup = 0; warmup < warmups; warmup += 1) definition.run(definition.create(), caseIterations);
  const rawSeconds = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const state = definition.create();
    const start = process.hrtime.bigint();
    definition.run(state, caseIterations);
    rawSeconds.push(Number(process.hrtime.bigint() - start) / 1e9);
    definition.check(state, caseIterations);
  }
  rawSeconds.sort((left, right) => left - right);
  return { case: definition.name, iterations: caseIterations, medianOpsPerSecond: Math.round(caseIterations / percentile(rawSeconds, 0.5)), rawSeconds };
});

console.log(`Node ${process.version}; ${iterations} collection operations; ${samples} samples after ${warmups} warmups`);
console.log(`${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
for (const result of results) console.log(JSON.stringify(result));
if (process.env.BENCH_OUTPUT) {
  const metadata = {
    kind: "collection-sample", date: process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10),
    commit: process.env.BENCH_COMMIT ?? "working-tree", workingTree: process.env.BENCH_WORKING_TREE ?? undefined,
    round: Number.parseInt(process.env.BENCH_ROUND ?? "0", 10), order: process.env.BENCH_ORDER ?? "",
    node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
    iterations, warmups, samples,
  };
  for (const result of results) appendFileSync(process.env.BENCH_OUTPUT, `${JSON.stringify({ ...metadata, ...result })}\n`);
}
