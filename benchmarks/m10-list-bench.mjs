import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* oxlint-disable react/no-children-prop, react/hooks -- this benchmark compares JSX element props directly, and each harness fixes its kind for its lifetime. */
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { isSignal, signal, useSignalTracking } = await import("../dist/index.js");
const { useManagedSignals } = await import("../dist/runtime.js");
const { For, Index } = await import("../dist/utils.js");

const sizes = (process.env.M10_LIST_SIZES ?? "100,1000,10000").split(",").map(Number);
const warmups = Number(process.env.M10_LIST_WARMUPS ?? 2);
const samples = Number(process.env.M10_LIST_SAMPLES ?? 5);
const largeWarmups = Number(process.env.M10_LIST_LARGE_WARMUPS ?? 0);
const largeSamples = Number(process.env.M10_LIST_LARGE_SAMPLES ?? 1);
const kinds = (process.env.M10_LIST_KINDS ?? "baseline-for,candidate-for,index").split(",");
const operations = ["singleUpdate", "append", "prepend", "middleDelete", "move", "replaceAll"];
const selectedOperations = (process.env.M10_LIST_OPERATIONS ?? operations.join(",")).split(",");
const now = () => performance.now();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const makeRows = (count) => Array.from({ length: count }, (_, id) => ({ id: `row-${id}`, value: `value-${id}` }));
const read = (each) => isSignal(each) ? each.value : each;

function BaselineFor({ each, by, children }) {
  const store = useManagedSignals();
  try {
    const collection = read(each);
    if (collection == null) return null;
    const items = Array.isArray(collection) ? collection : Array.from(collection);
    return items.length === 0 ? null : items.map((item, index) =>
      React.createElement(React.Fragment, { key: by(item, index) }, children(item, index)));
  } finally {
    store.finish();
  }
}

function BaselineIndex({ each, children }) {
  const store = useManagedSignals();
  try {
    const items = read(each);
    if (items == null || items.length === 0) return null;
    const readAt = (index) => (read(each) ?? items)[index];
    return items.map((_item, index) =>
      React.createElement(React.Fragment, { key: index }, children(() => readAt(index), index)));
  } finally {
    store.finish();
  }
}

const CandidateRow = React.memo(function CandidateRow({ item, index, children }) {
  const store = useManagedSignals();
  try { return children(item, index); }
  finally { store.finish(); }
}, (previous, next) => {
  if (previous.index !== next.index || previous.children !== next.children || previous.mapEntry !== next.mapEntry) return false;
  if (previous.mapEntry) return previous.item[0] === next.item[0] && Object.is(previous.item[1], next.item[1]);
  return Object.is(previous.item, next.item);
});

function CandidateFor({ each, fallback = null, by, children }) {
  const store = useManagedSignals();
  try {
    const collection = read(each);
    if (collection == null) return fallback;
    const items = Array.isArray(collection) ? collection : Array.from(collection);
    if (!items.length) return fallback;
    const mapEntry = collection instanceof Map;
    return items.map((item, index) => React.createElement(CandidateRow, {
      key: by(item, index), item, index, children, mapEntry,
    }));
  } finally { store.finish(); }
}

function createHarness(kind, count) {
  const rows = signal(makeRows(count));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stats = { parent: 0, callback: 0, row: 0 };
  function Row({ value, index }) {
    stats.row += 1;
    return React.createElement("li", null, `${index}:${value}`);
  }
  const childrenFor = (item, index) => {
    stats.callback += 1;
    return React.createElement(Row, { value: item.value, index });
  };
  const childrenIndex = (item, index) => {
    stats.callback += 1;
    return React.createElement(Row, { value: item(), index });
  };
  const by = (item) => item.id;
  function List() {
    stats.parent += 1;
    if (kind === "for") return React.createElement(For, { each: rows, by, children: childrenFor });
    if (kind === "candidate-for") return React.createElement(CandidateFor, { each: rows, by, children: childrenFor });
    if (kind === "baseline-for") return React.createElement(BaselineFor, { each: rows, by, children: childrenFor });
    if (kind === "index") return React.createElement(Index, { each: rows, children: childrenIndex });
    if (kind === "baseline-index") return React.createElement(BaselineIndex, { each: rows, children: childrenIndex });
    useSignalTracking();
    return read(rows).map((item, index) => {
      stats.callback += 1;
      return React.createElement(Row, { key: item.id, value: item.value, index });
    });
  }
  const mount = () => act(() => root.render(React.createElement(List)));
  const update = (operation) => {
    const before = rows.value;
    switch (operation) {
      case "singleUpdate": rows.value = before.map((item, index) => index === Math.floor(count / 2)
        ? { ...item, value: item.value === "changed" ? `value-${index}` : "changed" }
        : item); break;
      case "append": rows.value = before.at(-1)?.id === "added" ? before.slice(0, -1) : [...before, { id: "added", value: "added" }]; break;
      case "prepend": rows.value = before[0]?.id === "added" ? before.slice(1) : [{ id: "added", value: "added" }, ...before]; break;
      case "middleDelete": {
        const middle = Math.floor(count / 2);
        if (before.length === count) rows.value = before.filter((_, index) => index !== middle);
        else rows.value = [...before.slice(0, middle), { id: `row-${middle}`, value: `value-${middle}` }, ...before.slice(middle)];
        break;
      }
      case "move": rows.value = before[0]?.id === "row-0"
        ? [...before.slice(1), before[0]]
        : [before.at(-1), ...before.slice(0, -1)]; break;
      case "replaceAll": rows.value = before.map((item, index) => {
        const original = `value-${index}`;
        return { ...item, value: item.value.endsWith("-new") ? original : `${original}-new` };
      }); break;
      default: throw new Error(`Unknown operation ${operation}`);
    }
  };
  const clearStats = () => { stats.parent = 0; stats.callback = 0; stats.row = 0; };
  const snapshotStats = () => ({ ...stats });
  const verify = (expectedCount) => {
    const rendered = container.querySelectorAll("li");
    if (rendered.length !== expectedCount) throw new Error(`${kind}: expected ${expectedCount} rows, got ${rendered.length}`);
    if (expectedCount && !rendered[0].textContent?.startsWith("0:")) throw new Error(`${kind}: incorrect first row`);
  };
  const unmount = () => act(() => root.unmount());
  return { rows, container, mount, update, clearStats, snapshotStats, verify, unmount };
}

const results = [];
const writePartial = async () => {
  if (!process.env.M10_LIST_OUTPUT) return;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.M10_LIST_OUTPUT, `${JSON.stringify({
    node: process.version,
    react: React.version,
    sizes,
    warmups,
    samples,
    largeWarmups,
    largeSamples,
    gcExposed: typeof globalThis.gc === "function",
    results,
  }, null, 2)}\n`);
};
for (const size of sizes) {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error(`Invalid size: ${size}`);
  const sizeWarmups = size >= 10000 ? largeWarmups : warmups;
  const sizeSamples = size >= 10000 ? largeSamples : samples;
  for (const kind of kinds) {
    const mountTimes = [];
    const mountCallbackCalls = [];
    const memoryDeltas = [];
    for (let round = 0; round < sizeWarmups + sizeSamples; round += 1) {
      if (globalThis.gc) globalThis.gc();
      const beforeHeap = process.memoryUsage().heapUsed;
      const harness = createHarness(kind, size);
      const started = now();
      await harness.mount();
      const elapsed = now() - started;
      if (globalThis.gc) globalThis.gc();
      const delta = process.memoryUsage().heapUsed - beforeHeap;
      harness.verify(size);
      const stats = harness.snapshotStats();
      await harness.unmount();
      harness.container.remove();
      if (round >= sizeWarmups) {
        mountTimes.push(elapsed);
        mountCallbackCalls.push(stats.callback);
        memoryDeltas.push(delta);
      }
    }

    const mounted = createHarness(kind, size);
    await mounted.mount();
    mounted.verify(size);
    const updates = {};
    for (const operation of selectedOperations) {
      const times = [];
      const callbackCalls = [];
      const rowRenders = [];
      for (let round = 0; round < sizeWarmups + sizeSamples; round += 1) {
        mounted.clearStats();
        const started = now();
        await act(() => mounted.update(operation));
        const elapsed = now() - started;
        mounted.verify(mounted.rows.value.length);
        const stats = mounted.snapshotStats();
        if (round >= sizeWarmups) {
          times.push(elapsed);
          callbackCalls.push(stats.callback);
          rowRenders.push(stats.row);
        }
        await act(() => mounted.update(operation));
      }
      updates[operation] = {
        medianMs: median(times),
        p25Ms: percentile(times, 0.25),
        p75Ms: percentile(times, 0.75),
        medianCallbackCalls: median(callbackCalls),
        medianRowRenders: median(rowRenders),
        samplesMs: times,
        callbackSamples: callbackCalls,
        rowRenderSamples: rowRenders,
      };
    }
    const beforeUnmount = now();
    await mounted.unmount();
    const unmountMs = now() - beforeUnmount;
    mounted.container.remove();
    results.push({
      size,
      kind,
      warmups: sizeWarmups,
      samples: sizeSamples,
      mount: {
        medianMs: median(mountTimes),
        p25Ms: percentile(mountTimes, 0.25),
        p75Ms: percentile(mountTimes, 0.75),
        callbackCalls: median(mountCallbackCalls),
        heapDeltaBytes: median(memoryDeltas),
        samplesMs: mountTimes,
        callbackSamples: mountCallbackCalls,
        heapDeltaSamplesBytes: memoryDeltas,
      },
      updates,
      unmountMs,
    });
    await writePartial();
    console.error(`m10-list benchmark complete: ${size} rows, ${kind}`);
  }
}

const report = {
  node: process.version,
  react: React.version,
  sizes,
  warmups,
  samples,
    largeWarmups,
    largeSamples,
  gcExposed: typeof globalThis.gc === "function",
  results,
};
const serialized = JSON.stringify(report, null, 2);
await writePartial();
console.log(serialized);
