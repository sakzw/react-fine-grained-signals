import * as current from "../../dist/index.js";
import { createLeanRuntime } from "../../node_modules/.cache/prototype-a/lean-entry.js";

const [runtimeName = "lean", caseName = "tracked-update", iterationsArg = "10000"] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const samples = Number(process.env.BENCH_SAMPLES ?? 9);
const warmups = Number(process.env.BENCH_WARMUPS ?? 3);

function adapter(name) {
  if (name === "lean") {
    const runtime = createLeanRuntime(() => undefined);
    return { deepSignal: runtime.deepSignal, effect: runtime.effect, computed: runtime.computed };
  }
  if (name === "current") return { deepSignal: current.deepSignal, effect: current.effect, computed: current.computed };
  throw new Error(`Unknown runtime ${name}`);
}

const cases = {
  untrackedRead(a) {
    const state = a.deepSignal({ user: { name: "Ada" } });
    return { run(n) { let result = ""; for (let i = 0; i < n; i += 1) result = state.value.user.name; if (result !== "Ada") throw Error("bad read"); } };
  },
  trackedUpdate(a) {
    const state = a.deepSignal({ user: { name: 0, age: 0 } });
    let runs = 0;
    const dispose = a.effect(() => { state.value.user.name; runs += 1; });
    return { run(n) { for (let i = 1; i <= n; i += 1) state.value.user.name = i; if (runs !== n + 1) throw Error(`bad tracked updates ${runs}`); }, dispose };
  },
  siblingUpdate(a) {
    const state = a.deepSignal({ user: { name: 0, age: 0 } });
    let runs = 0;
    const dispose = a.effect(() => { state.value.user.name; runs += 1; });
    return { run(n) { for (let i = 1; i <= n; i += 1) state.value.user.age = i; if (runs !== 1) throw Error(`bad sibling isolation ${runs}`); }, dispose };
  },
  computedUpdate(a) {
    const state = a.deepSignal({ user: { name: 0 } });
    const doubled = a.computed(() => state.value.user.name * 2);
    let value = 0;
    const dispose = a.effect(() => { value = doubled.value; });
    return { run(n) { for (let i = 1; i <= n; i += 1) state.value.user.name = i; if (value !== n * 2) throw Error("bad computed update"); }, dispose };
  },
  arrayIndex(a) {
    const state = a.deepSignal({ items: Array.from({ length: 64 }, (_, index) => index) });
    let value = 0;
    const dispose = a.effect(() => { value = state.value.items[31]; });
    return { run(n) { for (let i = 1; i <= n; i += 1) state.value.items[31] = i; if (value !== n) throw Error("bad array index update"); }, dispose };
  },
};

const selected = cases[caseName];
if (!selected || !Number.isSafeInteger(iterations) || iterations < 1 || !Number.isSafeInteger(samples) || samples < 3 || !Number.isSafeInteger(warmups) || warmups < 1) throw new Error("Invalid benchmark arguments");
const a = adapter(runtimeName);
for (let i = 0; i < warmups; i += 1) { const state = selected(a); state.run(iterations); state.dispose?.(); }
const times = [];
for (let i = 0; i < samples; i += 1) {
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
console.log(JSON.stringify({ runtime: runtimeName, case: caseName, iterations, warmups, samples, node: process.version, platform: process.platform, arch: process.arch, cpu: (await import("node:os")).cpus()[0]?.model, ops_s: Math.round(iterations / (median / 1000)), p25_ms: +times[Math.floor((samples - 1) * 0.25)].toFixed(2), p75_ms: +times[Math.ceil((samples - 1) * 0.75)].toFixed(2) }));
