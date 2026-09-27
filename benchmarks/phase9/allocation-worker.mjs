import { loadAdapter } from "./adapters.mjs";

const payload = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, count, kind = "graph" } = payload;
if (!runtimeId || !Number.isSafeInteger(count) || count < 1) {
  throw new Error("Allocation worker needs runtimeId and a positive count.");
}
if (typeof global.gc !== "function") throw new Error("Allocation sanity requires --expose-gc.");

const api = await loadAdapter(runtimeId);
const collect = () => { global.gc(); global.gc(); };
const writeJson = (value) => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(value), (error) => error ? reject(error) : resolve());
});
if (kind === "fanout") {
  collect();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  let source = api.signal(0);
  let runs = 0;
  let stops = [];
  for (let index = 0; index < count; index += 1) {
    stops.push(api.effect(() => { api.read(source); runs += 1; }));
  }
  collect();
  const heapLiveBytes = process.memoryUsage().heapUsed;
  if (runs !== count) throw new Error(`Expected ${count} initial fan-out effects, got ${runs}.`);
  for (const stop of stops) api.dispose(stop);
  api.write(source, 1);
  if (runs !== count) throw new Error("Disposed fan-out effects still reacted.");
  stops = null;
  source = null;
  collect();
  const heapAfterDisposeBytes = process.memoryUsage().heapUsed;
  await writeJson({
    status: "ok",
    sanity: "directional_only",
    kind,
    graphCount: count,
    sourcesCreated: 1,
    computedsCreated: 0,
    effectsCreated: count,
    heapBeforeBytes,
    heapLiveBytes,
    heapAfterDisposeBytes,
    liveDeltaBytes: heapLiveBytes - heapBeforeBytes,
    retainedDeltaBytes: heapAfterDisposeBytes - heapBeforeBytes,
    disposedEffectsStopped: true,
    gcExposed: true,
  });
  process.exit(0);
}
if (kind === "deep-leaves") {
  if (typeof api.deepSignal !== "function") {
    await writeJson({ status: "na", reason: "deepSignal is an RFSG-specific API." });
    process.exit(0);
  }
  collect();
  const deepHeapBeforeBytes = process.memoryUsage().heapUsed;
  let state = api.deepSignal({ leaves: Array.from({ length: count }, () => ({ value: 0 })) });
  let runs = 0;
  let deepStops = [];
  for (let index = 0; index < count; index += 1) {
    deepStops.push(api.effect(() => {
      state.value.leaves[index].value;
      runs += 1;
    }));
  }
  collect();
  const deepHeapLiveBytes = process.memoryUsage().heapUsed;
  if (runs !== count) throw new Error(`Expected ${count} watched leaf effects, got ${runs}.`);
  for (const stop of deepStops) api.dispose(stop);
  const beforeWrite = runs;
  state.value.leaves[0].value = 1;
  if (runs !== beforeWrite) throw new Error("Disposed watched leaf effects still reacted.");
  deepStops = null;
  state = null;
  collect();
  const deepHeapAfterDisposeBytes = process.memoryUsage().heapUsed;
  await writeJson({
    status: "ok",
    sanity: "directional_only",
    kind,
    leafCount: count,
    effectsCreated: count,
    heapBeforeBytes: deepHeapBeforeBytes,
    heapLiveBytes: deepHeapLiveBytes,
    heapAfterDisposeBytes: deepHeapAfterDisposeBytes,
    liveDeltaBytes: deepHeapLiveBytes - deepHeapBeforeBytes,
    retainedDeltaBytes: deepHeapAfterDisposeBytes - deepHeapBeforeBytes,
    disposedEffectsStopped: true,
    gcExposed: true,
  });
  process.exit(0);
}
collect();
const heapBeforeBytes = process.memoryUsage().heapUsed;

let sources = Array.from({ length: count }, (_, index) => api.signal(index));
let computeds = sources.map((source) => api.computed(() => api.read(source) * 2));
let runs = 0;
let stops = computeds.map((value) => api.effect(() => { api.readComputed(value); runs += 1; }));
collect();
const heapLiveBytes = process.memoryUsage().heapUsed;
const initialRuns = runs;
if (initialRuns !== count) throw new Error(`Expected ${count} initial effect runs, got ${initialRuns}.`);

for (const stop of stops) api.dispose(stop);
api.write(sources[0], -1);
if (runs !== initialRuns) throw new Error("Disposed graph still reacted to a source write.");
stops = null;
computeds = null;
sources = null;
collect();
const heapAfterDisposeBytes = process.memoryUsage().heapUsed;

process.stdout.write(JSON.stringify({
  status: "ok",
  sanity: "directional_only",
  graphCount: count,
  sourcesCreated: count,
  computedsCreated: count,
  effectsCreated: count,
  heapBeforeBytes,
  heapLiveBytes,
  heapAfterDisposeBytes,
  liveDeltaBytes: heapLiveBytes - heapBeforeBytes,
  retainedDeltaBytes: heapAfterDisposeBytes - heapBeforeBytes,
  disposedEffectsStopped: true,
  gcExposed: true,
}));
