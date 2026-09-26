import { computed as alienComputed, effect as alienEffect, endBatch, signal as alienSignal, startBatch } from "alien-signals";
import * as current from "../../dist/index.js";
import { createLeanRuntime } from "../../node_modules/.cache/prototype-a/lean-entry.mjs";
import { createHybridRuntime } from "../../node_modules/.cache/phase5-architecture/hybrid-entry.mjs";

const [runtimeName = "lean", caseName = "observed", iterationsArg = "100000"] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const samples = 9;
const warmups = 3;

function adapter(name) {
  if (name === "lean") {
    const runtime = createLeanRuntime(() => undefined);
    return {
      signal(value) { const source = runtime.signal(value); return { get: () => source.value, set: next => { source.value = next; }, subscribe: source.subscribeRender.bind(source) }; },
      computed(getter) { const source = runtime.computed(getter); return { get: () => source.value, subscribe: source.subscribeRender.bind(source) }; },
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
  write(a) { const source = a.signal(0); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (source.get() !== n) throw Error("bad write"); } }; },
  observed(a) { const source = a.signal(0); let runs = 0; const dispose = a.effect(() => { source.get(); runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (runs !== n + 1) throw Error(`bad observed runs: ${runs}`); }, dispose }; },
  computed(a) { const source = a.signal(0), doubled = a.computed(() => source.get() * 2); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.set(i + 1); sum += doubled.get(); } if (sum !== n * (n + 1)) throw Error("bad computed"); } }; },
  batch(a) { const left = a.signal(0), right = a.signal(0), total = a.computed(() => left.get() + right.get()); let runs = 0; const dispose = a.effect(() => { total.get(); runs++; }); return { run(n) { for (let i = 0; i < n; i++) a.batch(() => { left.set(i + 1); right.set(i + 1); }); if (total.get() !== 2 * n || runs !== n + 1) throw Error("bad batch"); }, dispose }; },
  renderObserved(a) { const source = a.signal(0); let runs = 0; const unsubscribe = source.subscribe(() => { runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (runs !== n) throw Error(`bad render watcher runs: ${runs}`); }, dispose: unsubscribe }; },
  renderComputed(a) { const source = a.signal(0), doubled = a.computed(() => source.get() * 2); let runs = 0; const unsubscribe = doubled.subscribe(() => { runs++; }); return { run(n) { for (let i = 0; i < n; i++) source.set(i + 1); if (doubled.get() !== n * 2 || runs !== n) throw Error(`bad computed render watcher: ${runs}`); }, dispose: unsubscribe }; },
  speculative(a) { if (!a.speculate) throw new Error("speculative case requires lean"); const source = a.signal(0), doubled = a.computed(() => source.get() * 2); return { run(n) { let sum = 0; for (let i = 0; i < n; i++) { source.set(i + 1); sum += a.speculate(() => doubled.get()).value; } if (sum !== n * (n + 1)) throw Error("bad speculative read"); } }; },
};

const selected = cases[caseName];
if (!selected || !Number.isSafeInteger(iterations) || iterations < 1) throw new Error("Invalid benchmark arguments");
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
const median = times[4];
console.log(JSON.stringify({ runtime: runtimeName, case: caseName, iterations, warmups, samples, node: process.version, ops_s: Math.round(iterations / (median / 1000)), p25_ms: +times[2].toFixed(2), p75_ms: +times[6].toFixed(2) }));
