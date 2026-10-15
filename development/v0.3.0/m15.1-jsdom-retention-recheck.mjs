// Replays M11's whole-root select mount/unmount/queueMicrotask/GC sequence.
// `M151_SNAPSHOT_PATH` may point to a temporary path; heap snapshots are not
// repository artifacts.
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { jsx, jsxs } from "../../dist/jsx-runtime.js";
import { signal } from "../../dist/index.js";
import { writeHeapSnapshot } from "node:v8";

if (typeof globalThis.gc !== "function") throw new Error("Run with --expose-gc");
const width = Number(process.env.M151_HEAP_WIDTH ?? 8);
const cycles = Number(process.env.M151_HEAP_CYCLES ?? 20);
const warmups = Number(process.env.M151_HEAP_WARMUPS ?? 3);
const samples = Number(process.env.M151_HEAP_SAMPLES ?? 5);
const modes = (process.env.M151_HEAP_ORDER ?? "react,rfsg").split(",");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  MutationObserver: dom.window.MutationObserver,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  Event: dom.window.Event,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const values = ["a", "b", "c"];
const refs = [];
let batchNumber = 0;
function optionChildren(mode) {
  return values.map((value) => mode === "rfsg"
    ? jsx("option", { value, children: value }, value)
    : React.createElement("option", { key: value, value }, value));
}

async function mountUnmountBatch(mode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const elements = Array.from({ length: width }, (_, index) => {
    if (mode === "rfsg") {
      return jsxs("select", {
        multiple: true,
        bindValue: signal(index % 2 === 0 ? ["a", "c"] : ["b"]),
        children: optionChildren(mode),
      }, `rfsg-${index}`);
    }
    function Controlled() {
      const [selected] = React.useState(index % 2 === 0 ? ["a", "c"] : ["b"]);
      return React.createElement(
        "select",
        { multiple: true, value: selected, onChange() {} },
        ...optionChildren(mode),
      );
    }
    return React.createElement(Controlled, { key: `react-${index}` });
  });
  act(() => root.render(React.createElement(React.Fragment, null, elements)));
  for (const [index, host] of Array.from(container.querySelectorAll("select")).entries()) {
    host.__m151RetentionProbe = `${mode}:${batchNumber}:${index}`;
    refs.push({ mode, batch: batchNumber, index, reference: new WeakRef(host) });
  }
  act(() => root.unmount());
  container.remove();
  batchNumber += 1;
  await new Promise((resolve) => queueMicrotask(resolve));
}

for (const mode of modes) {
  for (let index = 0; index < warmups; index += 1) await mountUnmountBatch(mode);
  for (let sample = 0; sample < samples; sample += 1) {
    for (let cycle = 0; cycle < cycles; cycle += 1) await mountUnmountBatch(mode);
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
}

async function countSurvivors() {
  return refs.flatMap(({ mode, batch, index, reference }) =>
    reference.deref() === undefined ? [] : [{ mode, batch, index }]
  );
}
const survivors = await countSurvivors();
for (let pass = 0; pass < 6; pass += 1) {
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.gc();
}
const remaining = await countSurvivors();
// WeakRef.deref() keeps its target alive until the current job completes.
// Cross another task boundary and collect once more before taking the heap
// snapshot so this diagnostic does not become the retaining path itself.
await new Promise((resolve) => setImmediate(resolve));
globalThis.gc();
console.log(JSON.stringify({ width, cycles, warmups, samples, trackedHosts: refs.length, survivors, remaining }));
const snapshotPath = process.env.M151_SNAPSHOT_PATH;
if (snapshotPath) console.log(`heapSnapshot: ${writeHeapSnapshot(snapshotPath)}`);
dom.window.close();
