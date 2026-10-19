import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";

process.env.NODE_ENV = "production";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const {
  computed,
  effect,
  signal,
  useComputed,
  useSignalEffect,
} = await import("../../dist/index.js");
const { createElement, Fragment, useEffect, useMemo, useRef } = React;

const rowCount = Number(process.argv[2] ?? 500);
const updateCount = Number(process.argv[3] ?? 12);
const warmups = 2;
const samples = 9;
if (!Number.isSafeInteger(rowCount) || rowCount < 1) throw new Error("rowCount must be positive");
if (!Number.isSafeInteger(updateCount) || updateCount < 1) throw new Error("updateCount must be positive");
if (typeof globalThis.gc !== "function") throw new Error("Run with node --expose-gc");

function useComputedBefore(getter, dependencies) {
  // Keep the baseline Hook count without reproducing its render-time ref writes.
  void useRef(undefined);
  void useRef(undefined);
  void useRef(undefined);
  // The benchmark passes the same dynamic dependency argument as the public API.
  // oxlint-disable react-hooks/exhaustive-deps
  const dependencyComputed = useMemo(
    () => dependencies === undefined ? undefined : computed(getter),
    dependencies ?? [],
  );
  // oxlint-enable react-hooks/exhaustive-deps
  return dependencyComputed;
}

function useSignalEffectBefore(callback, dependencies) {
  // This is the pre-guard public behavior under measurement.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => effect(callback), dependencies ?? []);
}

const source = signal(1);
const counters = {
  baselineRenders: 0,
  baselineSetups: 0,
  baselineCleanups: 0,
  candidateRenders: 0,
  candidateSetups: 0,
  candidateCleanups: 0,
};

function BaselineRow({ version }) {
  counters.baselineRenders += 1;
  const value = useComputedBefore(() => source.value + version, [version]);
  useSignalEffectBefore(() => {
    void source.value;
    counters.baselineSetups += 1;
    return () => { counters.baselineCleanups += 1; };
  }, [version]);
  return createElement("span", null, value.value);
}

function CandidateRow({ version }) {
  counters.candidateRenders += 1;
  const value = useComputed(() => source.value + version, [version]);
  useSignalEffect(() => {
    void source.value;
    counters.candidateSetups += 1;
    return () => { counters.candidateCleanups += 1; };
  }, [version]);
  return createElement("span", null, value.value);
}

function App({ Row, version }) {
  return createElement(
    Fragment,
    null,
    ...Array.from({ length: rowCount }, (_, index) => createElement(Row, { key: index, version })),
  );
}

function stats(values, unit) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    [`median${unit}`]: sorted[Math.floor(sorted.length / 2)],
    [`min${unit}`]: sorted[0],
    [`max${unit}`]: sorted.at(-1),
    [`samples${unit}`]: values,
  };
}

function run(label) {
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Row = label === "baseline" ? BaselineRow : CandidateRow;
  const mountStart = performance.now();
  flushSync(() => root.render(createElement(App, { Row, version: 0 })));
  const mountMs = performance.now() - mountStart;
  const updateStart = performance.now();
  for (let version = 1; version <= updateCount; version += 1) {
    flushSync(() => root.render(createElement(App, { Row, version })));
  }
  const updateMs = performance.now() - updateStart;
  globalThis.gc();
  const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
  flushSync(() => root.unmount());
  container.remove();
  globalThis.gc();
  const postUnmountBytes = process.memoryUsage().heapUsed - heapBefore;
  return { mountMs, updateMsPerCommit: updateMs / updateCount, retainedBytes, postUnmountBytes };
}

const results = {
  baseline: { mount: [], update: [], retained: [], postUnmount: [] },
  candidate: { mount: [], update: [], retained: [], postUnmount: [] },
};
for (let round = 0; round < warmups + samples; round += 1) {
  const order = round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  for (const label of order) {
    counters[`${label}Renders`] = 0;
    counters[`${label}Setups`] = 0;
    counters[`${label}Cleanups`] = 0;
    const measured = run(label);
    if (round >= warmups) {
      results[label].mount.push(measured.mountMs);
      results[label].update.push(measured.updateMsPerCommit);
      results[label].retained.push(measured.retainedBytes);
      results[label].postUnmount.push(measured.postUnmountBytes);
    }
    const expected = rowCount * (updateCount + 1);
    if (counters[`${label}Renders`] !== expected) {
      throw new Error(`${label}: component render count differs from ${expected}`);
    }
    if (counters[`${label}Setups`] !== expected || counters[`${label}Cleanups`] !== expected) {
      throw new Error(`${label}: effect/cleanup counts differ from ${expected}`);
    }
  }
}

console.log(JSON.stringify({
  node: process.version,
  react: React.version,
  rowCount,
  updateCount,
  warmups,
  samples,
  baseline: {
    mount: stats(results.baseline.mount, "Ms"),
    updateMsPerCommit: stats(results.baseline.update, "Ms"),
    retainedBytes: stats(results.baseline.retained, "Bytes"),
    postUnmountBytes: stats(results.baseline.postUnmount, "Bytes"),
    rowRenderCountPerSample: rowCount * (updateCount + 1),
  },
  candidate: {
    mount: stats(results.candidate.mount, "Ms"),
    updateMsPerCommit: stats(results.candidate.update, "Ms"),
    retainedBytes: stats(results.candidate.retained, "Bytes"),
    postUnmountBytes: stats(results.candidate.postUnmount, "Bytes"),
    rowRenderCountPerSample: rowCount * (updateCount + 1),
  },
}, null, 2));
