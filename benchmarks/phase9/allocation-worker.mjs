import { loadAdapter } from "./adapters.mjs";
import { allocationWorkloadIds } from "./config.mjs";

const payload = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, count, kind } = payload;
if (!runtimeId || !Number.isSafeInteger(count) || count < 1) {
  throw new Error("Allocation worker needs runtimeId and a positive count.");
}
if (!allocationWorkloadIds.includes(kind)) {
  throw new Error(`Unknown allocation workload: ${String(kind)}`);
}
if (typeof global.gc !== "function") throw new Error("Allocation sanity requires --expose-gc.");

const api = await loadAdapter(runtimeId);
const collect = () => { global.gc(); global.gc(); };
const writeJson = (value) => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(value), (error) => error ? reject(error) : resolve());
});

if (kind === "signal-computed-effect-graph") {
  collect();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  let sources = Array.from({ length: count }, (_, index) => api.signal(index));
  let computeds = sources.map((source) => api.computed(() => api.read(source) * 2));
  let runs = 0;
  let stops = computeds.map((value) => api.effect(() => { api.readComputed(value); runs += 1; }));
  collect();
  const heapLiveBytes = process.memoryUsage().heapUsed;
  if (runs !== count) throw new Error(`Expected ${count} initial graph effect runs, got ${runs}.`);

  for (const stop of stops) api.dispose(stop);
  api.write(sources[0], -1);
  if (runs !== count) throw new Error("Disposed graph effects still reacted to a source write.");
  stops = null;
  computeds = null;
  sources = null;
  collect();
  const heapAfterDisposeBytes = process.memoryUsage().heapUsed;
  await writeJson({
    status: "ok",
    sanity: "directional_only",
    kind,
    graphCount: count,
    graphShape: {
      sourceSignals: count,
      computedSignals: count,
      effects: count,
      deepSignalRoots: 0,
      watchedLeaves: 0,
      subscribersToSingleSource: 0,
    },
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

if (kind === "one-source-many-effects") {
  collect();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  let source = api.signal(0);
  let runs = 0;
  let stops = Array.from({ length: count }, () => api.effect(() => { api.read(source); runs += 1; }));
  collect();
  const heapLiveBytes = process.memoryUsage().heapUsed;
  if (runs !== count) throw new Error(`Expected ${count} initial fan-out effects, got ${runs}.`);

  for (const stop of stops) api.dispose(stop);
  api.write(source, 1);
  if (runs !== count) throw new Error("Disposed fan-out effects still reacted to the source write.");
  stops = null;
  source = null;
  collect();
  const heapAfterDisposeBytes = process.memoryUsage().heapUsed;
  await writeJson({
    status: "ok",
    sanity: "directional_only",
    kind,
    graphCount: count,
    graphShape: {
      sourceSignals: 1,
      computedSignals: 0,
      effects: count,
      deepSignalRoots: 0,
      watchedLeaves: 0,
      subscribersToSingleSource: count,
    },
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

if (kind === "deep-watched-leaves") {
  if (typeof api.deepSignal !== "function") throw new Error(`${runtimeId} does not provide RFSG deepSignal.`);
  collect();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  let state = api.deepSignal({ leaves: Array.from({ length: count }, () => ({ value: 0 })) });
  let runs = 0;
  let stops = Array.from({ length: count }, (_, index) => api.effect(() => {
    state.value.leaves[index].value;
    runs += 1;
  }));
  collect();
  const heapLiveBytes = process.memoryUsage().heapUsed;
  if (runs !== count) throw new Error(`Expected ${count} watched leaf effects, got ${runs}.`);

  for (const stop of stops) api.dispose(stop);
  state.value.leaves[0].value = 1;
  if (runs !== count) throw new Error("Disposed watched-leaf effects still reacted to a leaf write.");
  stops = null;
  state = null;
  collect();
  const heapAfterDisposeBytes = process.memoryUsage().heapUsed;
  await writeJson({
    status: "ok",
    sanity: "directional_only",
    kind,
    graphCount: count,
    graphShape: {
      sourceSignals: 0,
      computedSignals: 0,
      effects: count,
      deepSignalRoots: 1,
      watchedLeaves: count,
      subscribersToSingleSource: 0,
    },
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

throw new Error(`Allocation workload dispatch is incomplete for: ${kind}`);
