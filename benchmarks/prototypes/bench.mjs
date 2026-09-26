import { computed as alienComputed, effect as alienEffect, endBatch, signal as alienSignal, startBatch } from "alien-signals";
import * as current from "../../dist/index.js";
import { createLeanRuntime } from "../../node_modules/.cache/prototype-a/lean-entry.js";
import { createHybridRuntime } from "../../node_modules/.cache/phase5-architecture/hybrid-entry.mjs";

const [runtimeName = "lean", caseName = "observed", iterationsArg = "100000"] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const samples = Number(process.env.BENCH_SAMPLES ?? 9);
const warmups = Number(process.env.BENCH_WARMUPS ?? 3);

function adapter(name) {
  if (name === "lean" || name === "lean-wrapped") {
    const runtime = createLeanRuntime(() => undefined);
    return {
      createForeignRuntime: () => createLeanRuntime(() => undefined),
      signal(value) {
        const source = runtime.signal(value);
        const publicLike = { get value() { return source.value; }, set value(next) { source.value = next; }, peek: () => source.peek() };
        return name === "lean" ? { get: () => source.value, set: next => { source.value = next; }, subscribe: source.subscribeRender.bind(source) } : {
          get: () => publicLike.value, set: next => { publicLike.value = next; }, peek: () => publicLike.peek(), subscribe: source.subscribeRender.bind(source),
        };
      },
      computed(getter) {
        const source = runtime.computed(getter);
        const publicLike = { get value() { return source.value; }, peek: () => source.peek() };
        return name === "lean" ? { get: () => source.value, subscribe: source.subscribeRender.bind(source) } : {
          get: () => publicLike.value, peek: () => publicLike.peek(), subscribe: source.subscribeRender.bind(source),
        };
      },
      effect: runtime.effect,
      batch: runtime.batch,
      speculate: runtime.speculate,
    };
  }
  if (name === "current") return {
    signal(value) { const source = current.signal(value); return { get: () => source.value, set: next => { source.value = next; } }; },
    computed(getter) { const source = current.computed(getter); return { get: () => source.value }; },
    effect: current.effect,
    batch: current.batch,
  };
  if (name === "hybrid") {
    const runtime = createHybridRuntime(() => undefined);
    return {
      signal(value) { const source = runtime.signal(value); return { get: () => source.value, set: next => { source.value = next; } }; },
      computed(getter) { const source = runtime.computed(getter); return { get: () => source.value }; },
      effect: runtime.effect,
      batch: runtime.batch,
    };
  }
  if (name === "alien") return {
    signal(value) { const source = alienSignal(value); return { get: () => source(), set: next => source(next) }; },
    computed(getter) { const source = alienComputed(getter); return { get: () => source() }; },
    effect: alienEffect,
    batch(fn) { startBatch(); try { return fn(); } finally { endBatch(); } },
  };
  throw new Error(`Unknown runtime ${name}`);
}

const cases = {
  read(a) { const source = a.signal(7); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) sum += source.get(); if (sum !== n * 7) throw Error("bad read"); } }; },
  unobservedWrite(a) { const source = a.signal(0); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (source.get() !== n) throw Error("bad write"); } }; },
  write(a) { const source = a.signal(0); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (source.get() !== n) throw Error("bad write"); } }; },
  observed(a) { const source = a.signal(0); let runs = 0; const dispose = a.effect(() => { source.get(); runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (runs !== n + 1) throw Error(`bad observed runs: ${runs}`); }, dispose }; },
  computed(a) { const source = a.signal(0), doubled = a.computed(() => source.get() * 2); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.set(i + 1); sum += doubled.get(); } if (sum !== n * (n + 1)) throw Error("bad computed"); } }; },
  batch(a) { const left = a.signal(0), right = a.signal(0), total = a.computed(() => left.get() + right.get()); let runs = 0; const dispose = a.effect(() => { total.get(); runs++; }); return { run(n) { for (let i = 0; i < n; i++) a.batch(() => { left.set(i + 1); right.set(i + 1); }); if (total.get() !== 2 * n || runs !== n + 1) throw Error("bad batch"); }, dispose }; },
  dynamic(a) { const choose = a.signal(true), left = a.signal(1), right = a.signal(2); let seen = 0; const dispose = a.effect(() => { seen += choose.get() ? left.get() : right.get(); }); return { run(n) { for (let i = 0; i < n; i++) { choose.set((i & 1) === 0); left.set(i + 3); right.set(i + 4); } if (seen <= 0) throw Error("bad dynamic dependencies"); }, dispose }; },
  effectCreateDispose(a) { const source = a.signal(0); return { run(n) { for (let i = 0; i < n; i++) { const stop = a.effect(() => source.get()); stop(); } } }; },
  computedCold(a) { const source = a.signal(7); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) sum += a.computed(() => source.get() + i).get(); if (sum !== n * 7 + n * (n - 1) / 2) throw Error("bad cold computed"); } }; },
  computedHot(a) { const source = a.signal(7), derived = a.computed(() => source.get() + 1); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) sum += derived.get(); if (sum !== n * 8) throw Error("bad hot computed"); } }; },
  renderObserved(a) { const source = a.signal(0); let runs = 0; const unsubscribe = source.subscribe(() => { runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (runs !== n) throw Error(`bad render watcher runs: ${runs}`); }, dispose: unsubscribe }; },
  renderComputed(a) { const source = a.signal(0), doubled = a.computed(() => source.get() * 2); let runs = 0; const unsubscribe = doubled.subscribe(() => { runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (doubled.get() !== n * 2 || runs !== n) throw Error(`bad computed render watcher: ${runs}`); }, dispose: unsubscribe }; },
  speculative(a) { if (!a.speculate) throw new Error("speculative case requires lean"); const source = a.signal(0), doubled = a.computed(() => source.get() * 2); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.set(i + 1); sum += a.speculate(() => doubled.get()).value; } if (sum !== n * (n + 1)) throw Error("bad speculative read"); } }; },
  foreignEffect(a) { if (!a.createForeignRuntime) throw new Error("foreign case requires lean"); const foreign = a.createForeignRuntime(), source = foreign.signal(0); let runs = 0; const dispose = a.effect(() => { source.value; runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.value = i + 1; if (runs !== n + 1) throw Error(`bad foreign effect: ${runs}`); }, dispose }; },
  foreignComputed(a) { if (!a.createForeignRuntime) throw new Error("foreign case requires lean"); const foreign = a.createForeignRuntime(), source = foreign.signal(0), doubled = a.computed(() => source.value * 2); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.value = i + 1; sum += doubled.get(); } if (sum !== n * (n + 1)) throw Error("bad foreign computed"); } }; },
  foreignEffectComputed(a) { if (!a.createForeignRuntime) throw new Error("foreign case requires lean"); const foreign = a.createForeignRuntime(), source = foreign.signal(0), doubled = foreign.computed(() => source.value * 2); let runs = 0; const dispose = a.effect(() => { doubled.value; runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.value = i + 1; if (runs !== n + 1) throw Error(`bad foreign effect computed: ${runs}`); }, dispose }; },
  foreignComputedComputed(a) { if (!a.createForeignRuntime) throw new Error("foreign case requires lean"); const foreign = a.createForeignRuntime(), source = foreign.signal(0), doubled = foreign.computed(() => source.value * 2), outer = a.computed(() => doubled.value + 1); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.value = i + 1; sum += outer.get(); } if (sum !== n * n + 2 * n) throw Error("bad nested foreign computed"); } }; },
  foreignDynamic(a) { if (!a.createForeignRuntime) throw new Error("foreign case requires lean"); const foreignB = a.createForeignRuntime(), foreignC = a.createForeignRuntime(), choose = a.signal(true), left = foreignB.signal(1), right = foreignC.signal(2); let sum = 0; const dispose = a.effect(() => { sum += choose.get() ? left.value : right.value; }); return { run(n) { for (let i = 0; i < n; i++) { choose.set((i & 1) === 0); left.value = i + 3; right.value = i + 4; } if (sum <= 0) throw Error("bad dynamic foreign branch"); }, dispose }; },
};

const selected = cases[caseName];
if (!selected || !Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(samples) || samples < 3 || !Number.isSafeInteger(warmups) || warmups < 1) throw new Error("Invalid benchmark arguments");
const a = adapter(runtimeName);
for (let i = 0; i < warmups; i++) { const state = selected(a); state.run(iterations); state.dispose?.(); }
const times = [];
for (let i = 0; i < samples; i++) {
  global.gc?.();
  const state = selected(a), start = performance.now();
  state.run(iterations);
  times.push(performance.now() - start);
  state.dispose?.();
}
times.sort((left, right) => left - right);
const quantile = ratio => {
  const position = (times.length - 1) * ratio;
  const low = Math.floor(position), high = Math.ceil(position);
  return times[low] + (times[high] - times[low]) * (position - low);
};
const median = quantile(0.5);
console.log(JSON.stringify({ runtime: runtimeName, case: caseName, iterations, warmups, samples, node: process.version, platform: process.platform, arch: process.arch, cpu: (await import("node:os")).cpus()[0]?.model, ops_s: Math.round(iterations / (median / 1000)), p25_ms: +quantile(0.25).toFixed(2), p75_ms: +quantile(0.75).toFixed(2) }));
