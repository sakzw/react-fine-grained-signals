import os from "node:os";
import { effect, deepCollectionSignal } from "../dist/index.js";

const quick = process.argv.includes("--quick");
const trackedCounts = quick ? [10, 1_000, 10_000] : [0, 10, 1_000, 10_000];
const cleanupCounts = quick ? [10, 1_000, 10_000] : [0, 10, 1_000, 10_000];
const samples = quick ? 3 : 7;
const cleanupSamples = quick ? 2 : 5;
// Own-data weak keys intentionally exercise graph validation, so keep the
// smoke-sized quick run bounded while full mode retains stronger samples.
const weakIterations = quick ? 300 : 2_000;
const weakWarmups = quick ? 1 : 2;
const candidateChecksPerSample = quick ? 20_000 : 500_000;

function summarize(rawSamples) {
  const sorted = [...rawSamples].sort((left, right) => left - right);
  const mean = rawSamples.reduce((sum, value) => sum + value, 0) / rawSamples.length;
  const variance = rawSamples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rawSamples.length;
  return {
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    mean: Math.round(mean),
    variance: Math.round(variance),
    standardDeviation: Math.round(Math.sqrt(variance)),
    minimum: Math.round(sorted[0]),
    maximum: Math.round(sorted.at(-1)),
    rawSamples: rawSamples.map(Math.round),
  };
}

function measureTracked(kind, subscribedKeys, name, operation, prepare = () => {}) {
  const iterations = Math.min(1_000, Math.max(25, Math.floor(candidateChecksPerSample / Math.max(1, subscribedKeys))));
  const warmupIterations = Math.min(100, iterations);
  const measuredMutations = iterations * samples;
  const raw = kind === "Map" ? new Map([ ["churn", 0] ]) : new Set(["churn"]);
  const collection = deepCollectionSignal(raw).value;
  prepare(collection, measuredMutations + warmupIterations + 100);
  const dispose = effect(() => {
    for (let index = 0; index < subscribedKeys; index += 1) {
      const key = `subscribed-${index}`;
      if (kind === "Map") collection.get(key);
      else collection.has(key);
    }
  });
  for (let index = 0; index < warmupIterations; index += 1) operation(collection, measuredMutations + index);
  const rawSamples = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index += 1) operation(collection, index + sample * iterations);
    rawSamples.push(Number(process.hrtime.bigint() - start) / iterations);
  }
  dispose();
  return {
    kind,
    name,
    subscribedKeys,
    iterationsPerSample: iterations,
    unit: "ns/op",
    ...summarize(rawSamples),
  };
}

const trackedScenarios = [
  ["Map", "update", (collection, index) => collection.set("churn", index)],
  ["Map", "add", (collection, index) => collection.set(`insert-${index}`, index)],
  ["Map", "delete", (collection, index) => collection.delete(`delete-${index}`), (collection, count) => {
    for (let index = 0; index < count; index += 1) collection.set(`delete-${index}`, index);
  }],
  ["Set", "duplicate-add", (collection) => collection.add("churn")],
  ["Set", "add", (collection, index) => collection.add(`insert-${index}`)],
  ["Set", "delete", (collection, index) => collection.delete(`delete-${index}`), (collection, count) => {
    for (let index = 0; index < count; index += 1) collection.add(`delete-${index}`);
  }],
];

function createObjectKey(index, shape) {
  return shape === "empty" ? {} : { id: index, payload: { count: index, label: `key-${index}` } };
}

function runWeakCase(kind, mode, shape, name, operation) {
  const raw = kind === "WeakMap" ? new WeakMap() : new WeakSet();
  const collection = mode === "reactive" ? deepCollectionSignal(raw).value : raw;
  const keys = Array.from({ length: weakIterations }, (_, index) => createObjectKey(index, shape));
  let sum = 0;
  for (let index = 0; index < weakIterations; index += 1) sum += operation(collection, keys, index);
  const expected = kind === "WeakMap" ? weakIterations * (weakIterations - 1) / 2 : weakIterations;
  if (sum !== expected) throw new Error("weak collection benchmark checksum failed");
}

function measureWeak(kind, mode, shape, name, operation) {
  const rawSamples = [];
  for (let warmup = 0; warmup < weakWarmups; warmup += 1) {
    runWeakCase(kind, mode, shape, name, operation);
  }
  for (let sample = 0; sample < samples; sample += 1) {
    const raw = kind === "WeakMap" ? new WeakMap() : new WeakSet();
    const collection = mode === "reactive" ? deepCollectionSignal(raw).value : raw;
    const keys = Array.from({ length: weakIterations }, (_, index) => createObjectKey(index, shape));
    let sum = 0;
    const start = process.hrtime.bigint();
    for (let index = 0; index < weakIterations; index += 1) sum += operation(collection, keys, index);
    rawSamples.push(Number(process.hrtime.bigint() - start) / weakIterations);
    const expected = kind === "WeakMap" ? weakIterations * (weakIterations - 1) / 2 : weakIterations;
    if (sum !== expected) throw new Error("weak collection benchmark checksum failed");
  }
  return {
    kind,
    mode,
    keyShape: shape,
    name,
    iterationsPerSample: weakIterations,
    unit: "ns/op-sequence",
    ...summarize(rawSamples),
  };
}

const weakScenarios = [
  ["WeakMap", "set-get", (collection, keys, index) => {
    const key = keys[index];
    collection.set(key, index);
    return collection.get(key);
  }],
  ["WeakMap", "update-get", (collection, keys, index) => {
    const key = keys[index % 1_000];
    collection.set(key, index);
    return collection.get(key);
  }],
  ["WeakMap", "delete-set-get", (collection, keys, index) => {
    const key = keys[index];
    collection.delete(key);
    collection.set(key, index);
    return collection.get(key);
  }],
  ["WeakSet", "add-has", (collection, keys, index) => {
    const key = keys[index];
    collection.add(key);
    return Number(collection.has(key));
  }],
  ["WeakSet", "duplicate-add-has", (collection, keys, index) => {
    const key = keys[index % 1_000];
    collection.add(key);
    return Number(collection.has(key));
  }],
  ["WeakSet", "delete-add-has", (collection, keys, index) => {
    const key = keys[index];
    collection.delete(key);
    collection.add(key);
    return Number(collection.has(key));
  }],
];

async function measureCleanup(kind, keyCount) {
  const rawSamples = { trackedHeapDeltaBytes: [], afterSweepHeapDeltaBytes: [], unsubscribeMs: [], sweepWallMs: [] };
  for (let sample = 0; sample < cleanupSamples; sample += 1) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const raw = kind === "Map" ? new Map() : new Set();
    const collection = deepCollectionSignal(raw).value;
    const dispose = effect(() => {
      for (let index = 0; index < keyCount; index += 1) {
        const key = `cleanup-${index}`;
        if (kind === "Map") collection.get(key);
        else collection.has(key);
      }
    });
    global.gc();
    rawSamples.trackedHeapDeltaBytes.push(process.memoryUsage().heapUsed - before);
    const unsubscribeStart = process.hrtime.bigint();
    dispose();
    rawSamples.unsubscribeMs.push(Number(process.hrtime.bigint() - unsubscribeStart) / 1e6);
    const sweepStart = process.hrtime.bigint();
    if (kind === "Map") collection.set("cleanup-trigger", 1);
    else collection.add("cleanup-trigger");
    for (let chunk = 0; chunk <= Math.ceil(keyCount / 128); chunk += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    rawSamples.sweepWallMs.push(Number(process.hrtime.bigint() - sweepStart) / 1e6);
    global.gc();
    rawSamples.afterSweepHeapDeltaBytes.push(process.memoryUsage().heapUsed - before);
  }
  return Object.fromEntries(Object.entries(rawSamples).map(([name, values]) => [name, summarize(values)]));
}

const tracked = [];
for (const subscribedKeys of trackedCounts) {
  for (const [kind, name, operation, prepare = () => {}] of trackedScenarios) {
    tracked.push(measureTracked(kind, subscribedKeys, name, operation, prepare));
  }
}

const weak = [];
for (const shape of ["empty", "with-own-data"]) {
  for (const [kind, name, operation] of weakScenarios) {
    for (const mode of ["native", "reactive"]) weak.push(measureWeak(kind, mode, shape, name, operation));
  }
}

const cleanup = [];
for (const kind of ["Map", "Set"]) {
  for (const keyCount of cleanupCounts) cleanup.push({ kind, keyCount, samples: await measureCleanup(kind, keyCount) });
}

console.log(JSON.stringify({
  runtime: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  trackedSamples: samples,
  trackedCandidateBudgetPerSample: candidateChecksPerSample,
  weakSamples: samples,
  weakIterationsPerSample: weakIterations,
  weakWarmups,
  cleanupSamples,
  tracked,
  weak,
  cleanup,
}, null, 2));
