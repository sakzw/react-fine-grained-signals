import os from "node:os";
import { appendFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, useMemo } = React;
const { createRoot } = await import("react-dom/client");
const { signal } = await import("../dist/index.js");
const { useManagedSignals, useSignalCapture } = await import("../dist/internal.js");

const rows = Number.parseInt(process.env.BENCH_ROWS ?? "100", 10);
const cycles = Number.parseInt(process.env.BENCH_CYCLES ?? "10", 10);
const samples = Number.parseInt(process.env.BENCH_SAMPLES ?? "7", 10);
const warmups = Number.parseInt(process.env.BENCH_WARMUPS ?? "2", 10);
const managedImpl = process.env.BENCH_MANAGED_IMPL ?? "capture";
if (![rows, cycles, samples, warmups].every(Number.isSafeInteger) || rows < 1 || cycles < 1 || samples < 1 || warmups < 0) {
  throw new Error("BENCH_ROWS, BENCH_CYCLES, BENCH_SAMPLES, and BENCH_WARMUPS must be valid positive counts");
}

function TrackedRow({ source }) {
  if (managedImpl === "try-finally") {
    const store = useManagedSignals();
    try { return React.createElement("span", null, source.value); }
    finally { store.finish(); }
  }
  const capture = useSignalCapture();
  return React.createElement("span", null, capture.capture(() => source.value));
}

function App() {
  const sources = useMemo(() => Array.from({ length: rows }, (_, index) => signal(index)), []);
  return React.createElement("div", null, sources.map((source, index) => React.createElement(TrackedRow, { key: index, source })));
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  global.gc?.();
  await new Promise((resolve) => setImmediate(resolve));
  global.gc?.();
}

async function cycle() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); });
  if (container.querySelectorAll("span").length !== rows) throw new Error("mount output did not contain all tracked rows");
  await act(async () => { root.unmount(); });
  container.remove();
}

for (let warmup = 0; warmup < warmups; warmup += 1) {
  for (let index = 0; index < cycles; index += 1) await cycle();
  await settle();
}

const retainedBytes = [];
for (let sample = 0; sample < samples; sample += 1) {
  await settle();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < cycles; index += 1) await cycle();
  await settle();
  const after = process.memoryUsage().heapUsed;
  retainedBytes.push(after - before);
}
retainedBytes.sort((left, right) => left - right);
const median = retainedBytes[Math.floor(retainedBytes.length / 2)];
const result = {
  kind: "react-retained-heap-sample",
  date: process.env.BENCH_DATE ?? new Date().toISOString().slice(0, 10),
  commit: process.env.BENCH_COMMIT ?? "working-tree",
  workingTree: process.env.BENCH_WORKING_TREE ?? undefined,
  round: Number.parseInt(process.env.BENCH_ROUND ?? "0", 10),
  order: process.env.BENCH_ORDER ?? "",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()[0]?.model,
  react: React.version,
  rows,
  cycles,
  warmups,
  samples,
  managedImpl,
  medianRetainedBytesAfterGc: median,
  rawRetainedBytesAfterGc: retainedBytes,
};
console.log(JSON.stringify(result));
if (process.env.BENCH_OUTPUT) appendFileSync(process.env.BENCH_OUTPUT, `${JSON.stringify(result)}\n`);
