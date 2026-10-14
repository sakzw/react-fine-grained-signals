import os from "node:os";
import { readdir } from "node:fs/promises";
import * as publicApi from "../dist/index.js";
import { computed as alienComputed, effect as alienEffect, signal as alienSignal } from "alien-signals";

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "20000", 10);
const warmups = Number.parseInt(process.env.BENCH_WARMUPS ?? "3", 10);
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? "9", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("BENCH_ITERATIONS must be a positive integer");

const runtimeFile = (await readdir(new URL("../dist/", import.meta.url)))
  .find((entry) => /^core-runtime-.*\.js$/.test(entry));
if (!runtimeFile) throw new Error("Build the runtime before running computed-profile.mjs");
const internalModule = await import(new URL(`../dist/${runtimeFile}`, import.meta.url).href);
const internalRuntime = Object.values(internalModule).find((value) =>
  value !== null && typeof value === "object" && typeof value.computed === "function" && typeof value.signal === "function",
);
if (!internalRuntime) throw new Error("Could not locate the internal ReactiveRuntime export in the built runtime");

const adapters = [
  {
    name: "RFSG public API",
    supportsWritableComputed: true,
    signal: (value) => {
      const source = publicApi.signal(value);
      return { get: () => source.value, set: (next) => { source.value = next; } };
    },
    computed: (getter, setter) => setter === undefined
      ? publicApi.computed(getter)
      : publicApi.computed({ get: getter, set: setter }),
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    effect: publicApi.effect,
  },
  {
    name: "RFSG internal runtime",
    supportsWritableComputed: true,
    signal: (value) => {
      const source = internalRuntime.signal(value);
      return { get: () => source.value, set: (next) => { source.value = next; } };
    },
    computed: (getter, setter) => setter === undefined
      ? internalRuntime.computed(getter)
      : internalRuntime.computed(getter, setter),
    read: (value) => value.value,
    write: (value, next) => { value.value = next; },
    effect: internalRuntime.effect,
  },
  {
    name: "RFSG public + benchmark adapter",
    supportsWritableComputed: true,
    signal: (value) => {
      const source = publicApi.signal(value);
      return { get: () => source.value, set: (next) => { source.value = next; }, raw: source };
    },
    computed: (getter, setter) => {
      const readable = setter === undefined
        ? publicApi.computed(getter)
        : publicApi.computed({ get: getter, set: setter });
      return { get: () => readable.value, set: (next) => { readable.value = next; }, raw: readable };
    },
    read: (value) => value.get(),
    write: (value, next) => value.set(next),
    effect: (fn) => publicApi.effect(fn),
  },
  {
    name: "alien-signals raw",
    supportsWritableComputed: false,
    signal: (value) => {
      const source = alienSignal(value);
      return { get: () => source(), set: (next) => source(next) };
    },
    computed: (getter, setter) => {
      if (setter !== undefined) throw new TypeError("alien-signals computed is read-only");
      return alienComputed(getter);
    },
    read: (value) => value(),
    write: (value, next) => { value(next); },
    effect: alienEffect,
  },
];

const quantile = (values, fraction) => {
  const ordered = values.toSorted((a, b) => a - b);
  const index = (ordered.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return ordered[low] + (ordered[high] - ordered[low]) * (index - low);
};

function cases(adapter) {
  const allCases = [
    ["getter-only/create-discarded", (count) => {
      let last;
      for (let i = 0; i < count; i += 1) last = adapter.computed(() => 14);
      return adapter.read(last);
    }, () => 14],
    ["getter-only/create-retained", (count) => {
      const retained = Array.from({ length: count }, () => adapter.computed(() => 14));
      let sum = 0;
      for (const item of retained) sum += adapter.read(item);
      return sum;
    }, (count) => 14 * count],
    ["writable/create-discarded", (count) => {
      let last;
      for (let i = 0; i < count; i += 1) last = adapter.computed(() => 14, () => {});
      return adapter.read(last);
    }, () => 14],
    ["writable/create-retained", (count) => {
      const retained = Array.from({ length: count }, () => adapter.computed(() => 14, () => {}));
      let sum = 0;
      for (const item of retained) sum += adapter.read(item);
      return sum;
    }, (count) => 14 * count],
    ["writable/set+read", (count) => {
      const source = adapter.signal(0);
      const value = adapter.computed(() => source.get(), (next) => source.set(next));
      for (let i = 0; i < count; i += 1) adapter.write(value, i + 1);
      return adapter.read(value);
    }, (count) => count],
    ["create+first-read", (count) => {
      let sum = 0;
      for (let i = 0; i < count; i += 1) sum += adapter.read(adapter.computed(() => i * 2));
      return sum;
    }, (count) => count * (count - 1)],
    ["cached-read", (count) => {
      const value = adapter.computed(() => 14);
      let sum = 0;
      for (let i = 0; i < count; i += 1) sum += adapter.read(value);
      return sum;
    }, (count) => 14 * count],
    ["update+read", (count) => {
      const source = adapter.signal(0);
      const value = adapter.computed(() => source.get() * 2);
      let sum = 0;
      for (let i = 0; i < count; i += 1) { source.set(i + 1); sum += adapter.read(value); }
      return sum + adapter.read(value);
    }, (count) => count * (count + 3)],
    ["observed-update", (count) => {
      const source = adapter.signal(0);
      const value = adapter.computed(() => source.get() * 2);
      let observed = 0;
      const dispose = adapter.effect(() => { observed = adapter.read(value); });
      for (let i = 0; i < count; i += 1) source.set(i + 1);
      dispose();
      return observed;
    }, (count) => 2 * count],
  ];
  return adapter.supportsWritableComputed ? allCases : allCases.filter(([name]) => !name.startsWith("writable/"));
}

function assertChecksum(adapter, name, actual, expected) {
  if (!Number.isFinite(actual) || !Object.is(actual, expected)) {
    throw new Error(`${adapter.name} ${name} checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

const results = [];
const definitionsByAdapter = new Map(adapters.map((adapter) => [adapter, cases(adapter)]));
// Alternate adapter order on every sample to reduce clock/thermal-order bias.
for (let sample = 0; sample < samples + warmups; sample += 1) {
  const order = sample % 2 === 0 ? adapters : adapters.toReversed();
  for (const adapter of order) {
    for (const [name, run, expected] of definitionsByAdapter.get(adapter)) {
      if (sample < warmups) {
        const warmupCount = Math.min(iterations, 1_000);
        assertChecksum(adapter, name, run(warmupCount), expected(warmupCount));
        continue;
      }
      global.gc?.();
      const start = process.hrtime.bigint();
      const checksum = run(iterations);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assertChecksum(adapter, name, checksum, expected(iterations));
      results.push({ adapter: adapter.name, case: name, sample: sample - warmups, ms });
    }
  }
}

function retainedHeapDelta(adapter, retained, count) {
  if (global.gc === undefined) return undefined;
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  let live;
  if (retained) {
    live = Array.from({ length: count }, () => adapter.computed(() => 14));
  } else {
    for (let index = 0; index < count; index += 1) live = adapter.computed(() => 14);
  }
  // Read after collection so the live allocation is observable and not dead-code-eliminated.
  const checksum = retained ? live.reduce((sum, value) => sum + adapter.read(value), 0) : adapter.read(live);
  global.gc();
  const delta = process.memoryUsage().heapUsed - baseline;
  assertChecksum(adapter, "heap", checksum, retained ? 14 * count : 14);
  return delta;
}

console.log(`Node ${process.version}; ${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log(`${iterations} iterations, ${warmups} warmups, ${samples} samples; --expose-gc=${Boolean(global.gc)}`);
for (const adapter of adapters) {
  console.log(`\n${adapter.name}`);
  console.table(Array.from(new Set(results.filter((result) => result.adapter === adapter.name).map((result) => result.case)), (name) => {
    const times = results.filter((result) => result.adapter === adapter.name && result.case === name).map((result) => result.ms);
    const medianMs = quantile(times, 0.5);
    return {
      case: name,
      medianMs: Number(medianMs.toFixed(3)),
      p25Ms: Number(quantile(times, 0.25).toFixed(3)),
      p75Ms: Number(quantile(times, 0.75).toFixed(3)),
      opsPerSecond: Math.round(iterations / (medianMs / 1e3)),
    };
  }));
  if (global.gc !== undefined) {
    console.log(`retained heap delta after GC, ${iterations} getter-only computed objects (diagnostic bytes)`);
    console.table([{
      discarded: retainedHeapDelta(adapter, false, iterations),
      retained: retainedHeapDelta(adapter, true, iterations),
    }]);
  }
  if (!adapter.supportsWritableComputed) console.log("writable computed cases: unsupported (alien-signals computed is read-only)");
}
