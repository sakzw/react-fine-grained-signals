import { performance } from "node:perf_hooks";

const [{ runtime, workload, iterations, size = 1, warmups = 3, samples = 7 }] = process.argv.slice(2).map(JSON.parse);
if (!runtime || !["effect/create", "effect/dispose-only", "effect/dispose-empty", "effect/create-dispose", "effect/create-dispose-sentinel", "effect/observed-write", "effect/fanout", "computed/dirty-read"].includes(workload)
  || !Number.isSafeInteger(iterations) || iterations <= 0 || !Number.isSafeInteger(size) || size <= 0) {
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
    computed: (fn) => api.computed(fn),
    readComputed: (value) => value.value,
    dispose: (stop) => stop(),
  };
}

const api = await loadRuntime();

function makeCohort(count = iterations) {
  const source = api.source(1);
  let runs = 0;
  const stops = [];
  if (workload === "effect/observed-write") {
    const stop = api.effect(() => { api.read(source); runs += 1; });
    return { run() { for (let index = 0; index < count; index += 1) api.write(source, index + 2); }, verify() {
      if (runs !== count + 1) throw new Error(`expected ${count + 1} observed effect runs, got ${runs}`);
    }, cleanup() { api.dispose(stop); api.write(source, count + 3); if (runs !== count + 1) throw new Error("disposed observer reran"); } };
  }
  if (workload === "effect/fanout") {
    for (let index = 0; index < size; index += 1) stops.push(api.effect(() => { api.read(source); runs += 1; }));
    return { run() { for (let index = 0; index < count; index += 1) api.write(source, index + 2); }, verify() {
      if (runs !== size * (count + 1)) throw new Error(`expected ${size * (count + 1)} fanout runs, got ${runs}`);
    }, cleanup() { for (const stop of stops) api.dispose(stop); } };
  }
  if (workload === "computed/dirty-read") {
    const value = api.computed(() => api.read(source) * 2);
    let sum = 0;
    return { run() { for (let index = 0; index < count; index += 1) { api.write(source, index + 1); sum += api.readComputed(value); } }, verify() {
      if (api.readComputed(value) !== count * 2 || sum !== count * (count + 1)) throw new Error("computed dirty/read verification failed");
    } };
  }
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
  if (workload === "effect/create-dispose-sentinel") {
    let sentinelRuns = 0;
    const sentinelStop = api.effect(() => { api.read(source); sentinelRuns += 1; });
    return { run() {
      for (let index = 0; index < count; index += 1) {
        const stop = api.effect(() => { api.read(source); runs += 1; });
        api.dispose(stop);
      }
    }, verify() {
      if (runs !== count) throw new Error(`expected ${count} temporary effect runs, got ${runs}`);
      if (sentinelRuns !== 1) throw new Error(`sentinel should only have its initial run before verification, got ${sentinelRuns}`);
      api.write(source, 2);
      if (runs !== count) throw new Error("a temporary effect reran after disposal");
      if (sentinelRuns !== 2) throw new Error("sentinel did not remain subscribed through the timed loop");
    }, cleanup() {
      api.dispose(sentinelStop);
      api.write(source, 3);
      if (sentinelRuns !== 2) throw new Error("disposed sentinel reran after cleanup");
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
