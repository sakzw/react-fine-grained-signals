import { performance } from "node:perf_hooks";

const [{ runtime, workload, iterations, warmups = 3, samples = 7 }] = process.argv.slice(2).map(JSON.parse);
if (!runtime || !["effect/create", "effect/dispose-only", "effect/dispose-empty", "effect/create-dispose"].includes(workload)
  || !Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error("worker requires a runtime, supported disposal workload, and positive iterations");
}

async function loadRuntime() {
  let api;
  let alien = false;
  if (runtime === "v011") {
    api = await import(new URL("../../node_modules/react-fine-grained-signals/dist/index.js", import.meta.url));
  } else if (runtime === "alien") {
    api = await import(new URL("../../node_modules/alien-signals/esm/index.mjs", import.meta.url));
    alien = true;
  } else {
    const modulePath = runtime === "current"
      ? "../../../../dist/index.js"
      : `./variants/${runtime}/dist/index.js`;
    api = await import(new URL(modulePath, import.meta.url));
  }
  return {
    source: (value) => alien ? api.signal(value) : api.signal(value),
    read: (source) => alien ? source() : source.value,
    write(source, value) { if (alien) source(value); else source.value = value; },
    effect: (fn) => api.effect(fn),
    dispose: (stop) => stop(),
  };
}

const api = await loadRuntime();

function makeCohort(count = iterations) {
  const source = api.source(1);
  let runs = 0;
  const stops = [];
  if (workload === "effect/create-dispose") {
    return { run() {
      for (let index = 0; index < count; index += 1) {
        const stop = api.effect(() => { api.read(source); runs += 1; });
        api.dispose(stop);
      }
    }, verify() {
      if (runs !== count) throw new Error(`expected ${count} effect runs, got ${runs}`);
      const before = runs;
      api.write(source, 2);
      if (runs !== before) throw new Error("disposed effect reran after source write");
    } };
  }
  if (workload === "effect/create") {
    return { run() {
      for (let index = 0; index < count; index += 1) {
        stops.push(api.effect(() => { api.read(source); runs += 1; }));
      }
    }, verify() {
      if (runs !== count) throw new Error(`expected ${count} effect runs, got ${runs}`);
    }, cleanup() { for (const stop of stops) api.dispose(stop); } };
  }
  for (let index = 0; index < count; index += 1) {
    stops[index] = workload === "effect/dispose-only"
      ? api.effect(() => { api.read(source); runs += 1; })
      : api.effect(() => { runs += 1; });
  }
  if (runs !== count) throw new Error(`expected ${count} setup runs, got ${runs}`);
  return { run() { for (const stop of stops) api.dispose(stop); }, verify() {
    const before = runs;
    api.write(source, 2);
    if (runs !== before) throw new Error("disposed effect reran after source write");
  } };
}

const preflight = makeCohort(Math.min(iterations, 4));
preflight.run(); preflight.verify(); preflight.cleanup?.();
for (let index = 0; index < warmups; index += 1) {
  global.gc?.();
  const cohort = makeCohort(); cohort.run(); cohort.verify(); cohort.cleanup?.();
}
const results = [];
for (let sample = 0; sample < samples; sample += 1) {
  global.gc?.();
  const cohort = makeCohort();
  const startedAt = performance.now();
  cohort.run();
  const durationNs = Math.round((performance.now() - startedAt) * 1e6);
  cohort.verify();
  cohort.cleanup?.();
  results.push({ sample, durationNs });
}
process.stdout.write(JSON.stringify({ runtime, workload, iterations, status: "ok", preflight: "passed", samples: results }));
