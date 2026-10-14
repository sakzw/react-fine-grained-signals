import { effect, deepSignal } from "../dist/index.js";

const quick = process.argv.includes("--quick");
const counts = quick ? [10, 1_000, 10_000] : [0, 10, 1_000, 10_000];
const samples = quick ? 5 : 7;
const targetCandidateChecksPerSample = quick ? 100_000 : 500_000;

function measure(keyCount, operation, prepare = () => {}) {
  const iterations = Math.min(1_000, Math.max(25, Math.floor(targetCandidateChecksPerSample / Math.max(1, keyCount))));
  const warmupIterations = Math.min(100, iterations);
  const measuredMutations = iterations * samples;
  const state = deepSignal(new Map([["churn", 0]]));
  prepare(state.value, measuredMutations + warmupIterations + 100);
  const dispose = effect(() => {
    for (let i = 0; i < keyCount; i += 1) state.value.get(`subscribed-${i}`);
  });

  // Warm up the exact mutation shape before timing it.
  for (let i = 0; i < warmupIterations; i += 1) operation(state.value, measuredMutations + i);
  const durations = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) operation(state.value, i + sample * iterations);
    durations.push((performance.now() - start) * 1e6 / iterations);
  }
  dispose();
  durations.sort((a, b) => a - b);
  return { medianNsPerOp: Math.round(durations[Math.floor(durations.length / 2)]), iterationsPerSample: iterations };
}

async function measureHeap(keyCount) {
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const state = deepSignal(new Map());
  let dispose = effect(() => {
    for (let i = 0; i < keyCount; i += 1) state.value.get(`heap-${i}`);
  });
  global.gc();
  const whileSubscribed = process.memoryUsage().heapUsed;
  dispose();
  dispose = undefined;
  state.value.set("sweep", 1);
  for (let chunk = 0; chunk <= Math.ceil(keyCount / 128); chunk += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  global.gc();
  const afterCleanup = process.memoryUsage().heapUsed;
  return {
    trackedDeltaBytes: whileSubscribed - before,
    afterUnsubscribeAndSweepDeltaBytes: afterCleanup - before,
  };
}

const scenarios = [
  ["update", (map, i) => map.set("churn", i)],
  ["add", (map, i) => map.set(`insert-${i}`, i)],
  ["delete", (map, i) => map.delete(`delete-${i}`), (map, count) => {
    for (let i = 0; i < count; i += 1) map.set(`delete-${i}`, i);
  }],
];

const memoryOnly = process.argv.includes("--memory-only");
const results = [];
for (const subscribedKeys of counts) {
  const operations = {};
  if (!memoryOnly) {
    for (const [name, operation, prepare] of scenarios) operations[name] = measure(subscribedKeys, operation, prepare);
  }
  results.push({
    subscribedKeys,
    ...(!memoryOnly && { operations }),
    heap: await measureHeap(subscribedKeys),
  });
}
console.log(JSON.stringify({ node: process.version, samples, targetCandidateChecksPerSample, unit: "ns/op", results }, null, 2));
