import os from "node:os";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const dist = resolve(process.argv[2] ?? "dist");
const iterations = Number.parseInt(process.env.M18_ITERATIONS ?? "10000", 10);
const warmups = Number.parseInt(process.env.M18_WARMUPS ?? "3", 10);
const samples = Number.parseInt(process.env.M18_SAMPLES ?? "9", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("M18_ITERATIONS must be positive");

const publicApi = await import(pathToFileURL(resolve(dist, "index.js")).href);
const runtimeFile = (await readdir(dist)).find((entry) => /^plain-result-iterators-.*\.js$/.test(entry));
if (!runtimeFile) throw new Error(`No internal runtime chunk in ${dist}; build the runtime first`);
const runtimeUrl = pathToFileURL(resolve(dist, runtimeFile)).href;
const [copyA, copyB] = await Promise.all([
  import(runtimeUrl),
  import(`${runtimeUrl}?m18-22-copy=2`),
]);
function internalRuntime(module) {
  return Object.values(module).find((value) =>
    value !== null && typeof value === "object"
      && typeof value.signal === "function" && typeof value.computed === "function" && typeof value.effect === "function",
  );
}
const runtimeA = internalRuntime(copyA);
const runtimeB = internalRuntime(copyB);
if (!runtimeA || !runtimeB || runtimeA === runtimeB) throw new Error("Could not load two independent runtime copies");

const cases = [
  {
    name: "signal/create-discard",
    count: iterations * 3,
    run(count) {
      let last;
      for (let index = 0; index < count; index += 1) last = publicApi.signal(index);
      return last.peek();
    },
    expected(count) { return count - 1; },
  },
  {
    name: "signal/create-retain",
    count: iterations,
    run(count) {
      const values = Array.from({ length: count });
      let checksum = 0;
      for (let index = 0; index < count; index += 1) values[index] = publicApi.signal(index);
      for (const value of values) checksum += value.peek();
      return checksum;
    },
    expected(count) { return count * (count - 1) / 2; },
  },
  {
    name: "computed/readonly-create-discard",
    count: iterations,
    run(count) {
      let last;
      for (let index = 0; index < count; index += 1) last = publicApi.computed(() => index * 2);
      return last.value;
    },
    expected(count) { return (count - 1) * 2; },
  },
  {
    name: "computed/writable-create-discard",
    count: iterations,
    run(count) {
      let last;
      for (let index = 0; index < count; index += 1) {
        last = publicApi.computed({ get: () => index * 2, set: () => {} });
      }
      return last.value;
    },
    expected(count) { return (count - 1) * 2; },
  },
  {
    name: "computed/first-evaluation",
    count: iterations,
    run(count) {
      let checksum = 0;
      for (let index = 0; index < count; index += 1) checksum += publicApi.computed(() => index * 2).value;
      return checksum;
    },
    expected(count) { return count * (count - 1); },
  },
  {
    name: "computed/cached-read",
    count: iterations * 10,
    run(count) {
      const value = publicApi.computed(() => 7 * 2);
      let checksum = 0;
      for (let index = 0; index < count; index += 1) checksum += value.value;
      return checksum;
    },
    expected(count) { return count * 14; },
  },
  {
    name: "computed/dependency-update-read",
    count: iterations,
    run(count) {
      const source = publicApi.signal(0);
      const value = publicApi.computed(() => source.value * 2);
      let checksum = 0;
      for (let index = 0; index < count; index += 1) {
        source.value = index + 1;
        checksum += value.value;
      }
      return checksum + value.value;
    },
    expected(count) { return count * (count + 3); },
  },
  {
    name: "effect-graph/create-discard",
    count: Math.max(500, Math.floor(iterations / 2)),
    run(count) {
      let checksum = 0;
      for (let index = 0; index < count; index += 1) {
        const source = publicApi.signal(index);
        const value = publicApi.computed(() => source.value + 1);
        let seen = 0;
        const dispose = publicApi.effect(() => { seen = value.value; });
        checksum += seen;
        dispose();
      }
      return checksum;
    },
    expected(count) { return count * (count + 1) / 2; },
  },
  {
    name: "cross-copy/acquire-subscribe-dispose",
    count: Math.max(300, Math.floor(iterations / 4)),
    run(count) {
      const source = runtimeA.signal(0);
      let checksum = 0;
      for (let index = 0; index < count; index += 1) {
        const value = runtimeA.computed(() => source.value + 1);
        let seen = -1;
        const dispose = runtimeB.effect(() => { seen = value.value; });
        if (seen !== index + 1) throw new Error(`cross-copy initial read mismatch: ${seen}`);
        source.value = index + 1;
        if (seen !== index + 2) throw new Error(`cross-copy update mismatch: ${seen}`);
        checksum += seen;
        dispose();
      }
      return checksum;
    },
    expected(count) { return count * (count + 3) / 2; },
  },
  {
    name: "consumer/computed-fanout-update-unsubscribe",
    count: Number.parseInt(process.env.M18_CONSUMER_COUNT ?? "500", 10),
    run(count) {
      const cycles = 10;
      let checksum = 0;
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        const source = publicApi.signal(0);
        const values = Array.from({ length: count }, (_, index) => publicApi.computed(() => source.value + index));
        let runs = 0;
        const disposers = values.map((value) => publicApi.effect(() => {
          checksum += value.value;
          runs += 1;
        }));
        for (let update = 1; update <= 3; update += 1) source.value = update;
        if (runs !== count * 4) throw new Error(`consumer effects ran ${runs}, expected ${count * 4}`);
        for (const dispose of disposers) dispose();
        source.value = 4;
        if (runs !== count * 4) throw new Error("disposed consumer effects remained subscribed");
      }
      return checksum;
    },
    expected(count) { return 10 * (2 * count * (count - 1) + 6 * count); },
  },
];

function quantile(values, p) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

const selectedCases = process.env.M18_CASE === undefined
  ? cases
  : cases.filter((test) => test.name === process.env.M18_CASE);
if (!selectedCases.length) throw new Error(`Unknown M18_CASE: ${process.env.M18_CASE}`);
const result = [];
for (const test of process.env.M18_HEAP_ONLY === "1" ? [] : selectedCases) {
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    const actual = test.run(Math.min(test.count, 1000));
    if (!Object.is(actual, test.expected(Math.min(test.count, 1000)))) throw new Error(`${test.name} warmup checksum mismatch`);
  }
  const times = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const start = process.hrtime.bigint();
    const actual = test.run(test.count);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (!Object.is(actual, test.expected(test.count))) throw new Error(`${test.name} checksum mismatch: ${actual}`);
    times.push(ms);
  }
  result.push({
    case: test.name,
    iterations: test.count,
    medianMs: quantile(times, 0.5),
    p25Ms: quantile(times, 0.25),
    p75Ms: quantile(times, 0.75),
    samplesMs: times,
  });
}

function retainedHeap(makeValues) {
  if (global.gc === undefined) return undefined;
  const retainedSamples = [];
  const releaseSamples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const live = makeValues();
    global.gc();
    retainedSamples.push(process.memoryUsage().heapUsed - before);
    live.length = 0;
    global.gc();
    releaseSamples.push(process.memoryUsage().heapUsed - before);
  }
  return {
    retainedMedianBytes: quantile(retainedSamples, 0.5),
    retainedSamplesBytes: retainedSamples,
    afterReleaseMedianBytes: quantile(releaseSamples, 0.5),
    afterReleaseSamplesBytes: releaseSamples,
  };
}

const heapCount = iterations;
const signalHeap = process.env.M18_CASE === undefined
  ? retainedHeap(() => Array.from({ length: heapCount }, (_, index) => publicApi.signal(index)))
  : undefined;
const readonlyComputedHeap = process.env.M18_CASE === undefined
  ? retainedHeap(() => Array.from({ length: heapCount }, (_, index) => publicApi.computed(() => index)))
  : undefined;
const writableComputedHeap = process.env.M18_CASE === undefined
  ? retainedHeap(() => Array.from({ length: heapCount }, (_, index) => publicApi.computed({ get: () => index, set: () => {} })))
  : undefined;

const report = JSON.stringify({
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  iterations,
  warmups,
  samples,
  heapOnly: process.env.M18_HEAP_ONLY === "1",
  gcExposed: typeof global.gc === "function",
  results: result,
  retainedHeap: { objectsPerCase: heapCount, repeats: process.env.M18_HEAP_ONLY === "1" || process.env.M18_HEAP_ONLY === undefined ? 5 : 0, signal: signalHeap, readonlyComputed: readonlyComputedHeap, writableComputed: writableComputedHeap },
}, null, 2);
if (process.env.M18_QUIET !== "1") console.log(report);
if (process.argv[3]) writeFileSync(resolve(process.argv[3]), `${report}\n`);
