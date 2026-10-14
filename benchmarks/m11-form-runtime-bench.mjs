import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
const nativeMutationObserver = dom.window.MutationObserver;
let mutationObserversCreated = 0;
let mutationObserversDisconnected = 0;
const mutationObserverRefs = [];
const selectNodeRefs = [];
globalThis.MutationObserver = class extends nativeMutationObserver {
  constructor(callback) {
    super(callback);
    mutationObserversCreated += 1;
    mutationObserverRefs.push(new WeakRef(this));
  }
  disconnect() {
    mutationObserversDisconnected += 1;
    super.disconnect();
  }
};
for (const name of ["MutationObserver", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Event", "MouseEvent", "InputEvent"]) {
  if (name !== "MutationObserver") globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* oxlint-disable react/no-children-prop, react/hooks, react/globals -- benchmark counters/setters live outside the measured component. */
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { jsx: signalJsx, jsxs: signalJsxs } = await import("../dist/jsx-runtime.js");
const { signal } = await import("../dist/index.js");

const warmups = Number(process.env.M11_FORM_WARMUPS ?? 2);
const samples = Number(process.env.M11_FORM_SAMPLES ?? 5);
const updates = Number(process.env.M11_FORM_UPDATES ?? 40);
const heapCycles = Number(process.env.M11_FORM_HEAP_CYCLES ?? 20);
const heapWidth = Number(process.env.M11_FORM_HEAP_WIDTH ?? 8);
const now = () => performance.now();
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const summarize = (values) => ({
  median: median(values),
  p25: percentile(values, 0.25),
  p75: percentile(values, 0.75),
  samples: values,
});

const options = ["a", "b", "c"];
const children = (factory, kind, value, setter) => {
  switch (kind) {
    case "text":
      return factory("input", { type: "text", value, onChange: (event) => setter(event.target.value) });
    case "checked":
      return factory("input", { type: "checkbox", checked: value, onChange: (event) => setter(event.target.checked) });
    case "select":
      return factory("select", { value, onChange: (event) => setter(event.target.value), children: options.map((item) => factory("option", { key: item, value: item, children: item })) });
    case "multiple":
      return factory("select", { multiple: true, value, onChange: (event) => setter(Array.from(event.target.selectedOptions, (option) => option.value)), children: options.map((item) => factory("option", { key: item, value: item, children: item })) });
    case "radio":
      return factory("fieldset", { children: options.map((item) => factory("input", { key: item, type: "radio", name: "choice", value: item, checked: value === item, onChange: () => setter(item) })) });
    case "checkbox-group":
      return factory("fieldset", { children: options.map((item) => factory("input", { key: item, type: "checkbox", name: "features", value: item, checked: value.includes(item), onChange: (event) => setter(event.target.checked ? [...value, item] : value.filter((entry) => entry !== item)) })) });
    default:
      throw new Error(`Unknown benchmark kind ${kind}`);
  }
};

const boundChildren = (kind, value) => {
  switch (kind) {
    case "text": return signalJsx("input", { type: "text", bindValue: value });
    case "checked": return signalJsx("input", { type: "checkbox", bindChecked: value });
    case "select": return signalJsx("select", { bindValue: value, children: options.map((item) => signalJsx("option", { value: item, children: item }, item)) });
    case "multiple": return signalJsx("select", { multiple: true, bindValue: value, children: options.map((item) => signalJsx("option", { value: item, children: item }, item)) });
    case "radio": return signalJsxs("fieldset", { children: options.map((item) => signalJsx("input", { type: "radio", name: "choice", value: item, bindValue: value }, item)) });
    case "checkbox-group": return signalJsxs("fieldset", { children: options.map((item) => signalJsx("input", { type: "checkbox", name: "features", value: item, bindValue: value }, item)) });
    default: throw new Error(`Unknown benchmark kind ${kind}`);
  }
};

function valueFor(kind, index) {
  switch (kind) {
    case "text": return String(index);
    case "checked": return index % 2 === 1;
    case "select":
    case "radio": return options[index % options.length];
    case "multiple": return index % 2 === 0 ? ["a", "c"] : ["b"];
    case "checkbox-group": return index % 2 === 0 ? ["a", "c"] : ["b"];
    default: throw new Error(`Unknown benchmark kind ${kind}`);
  }
}

function createHarness(kind, mode) {
  const initial = valueFor(kind, 0);
  const source = mode === "react" ? undefined : signal(initial);
  let setReactValue;
  let ownerRenders = 0;
  function Owner() {
    ownerRenders += 1;
    if (mode === "react") {
      const [value, setValue] = React.useState(initial);
      setReactValue = setValue;
      return children(React.createElement, kind, value, setValue);
    }
    return boundChildren(kind, source);
  }
  const element = React.createElement(Owner);
  const update = (index) => {
    const next = valueFor(kind, index + 1);
    if (mode === "react") setReactValue(next);
    else source.value = next;
  };
  const verify = (container, index) => {
    const expected = valueFor(kind, index);
    if (kind === "text" && container.querySelector("input")?.value !== expected) throw new Error(`${mode} text binding diverged`);
    if (kind === "checked" && container.querySelector("input")?.checked !== expected) throw new Error(`${mode} checked binding diverged`);
    if (kind === "select" && container.querySelector("select")?.value !== expected) throw new Error(`${mode} select binding diverged`);
    if (kind === "multiple") {
      const actual = Array.from(container.querySelector("select").selectedOptions, (option) => option.value);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${mode} multiple-select binding diverged`);
    }
    if (kind === "radio") {
      const actual = container.querySelector('input[type="radio"]:checked')?.value;
      if (actual !== expected) throw new Error(`${mode} radio binding diverged: ${actual} !== ${expected}`);
    }
    if (kind === "checkbox-group") {
      const actual = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'), (input) => input.value);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${mode} checkbox-group binding diverged`);
    }
  };
  return { element, update, verify, get ownerRenders() { return ownerRenders; } };
}

async function runSample(kind, mode) {
  const harness = createHarness(kind, mode);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mountStart = now();
  act(() => root.render(harness.element));
  const mountMs = now() - mountStart;
  const renderCountAfterMount = harness.ownerRenders;
  const updateTimes = [];
  for (let index = 0; index < updates; index += 1) {
    const start = now();
    act(() => harness.update(index));
    updateTimes.push(now() - start);
  }
  harness.verify(container, updates);
  const ownerRendersAfterUpdates = harness.ownerRenders;
  act(() => root.unmount());
  container.remove();
  await new Promise((resolve) => queueMicrotask(resolve));
  return {
    mountMs,
    updateMsPerOperation: updateTimes.reduce((sum, value) => sum + value, 0) / updates,
    ownerRendersAfterMount: renderCountAfterMount,
    ownerRendersAfterUpdates,
  };
}

async function measureCase(kind, mode) {
  const mounts = [];
  const updateCosts = [];
  const renders = [];
  for (let round = 0; round < warmups + samples; round += 1) {
    if (globalThis.gc) globalThis.gc();
    const result = await runSample(kind, mode);
    if (round >= warmups) {
      mounts.push(result.mountMs);
      updateCosts.push(result.updateMsPerOperation);
      renders.push(result.ownerRendersAfterUpdates - result.ownerRendersAfterMount);
    }
  }
  return {
    mountMs: summarize(mounts),
    updateMsPerOperation: summarize(updateCosts),
    ownerRendersDuringUpdates: renders,
  };
}

async function mountUnmountBatch(kind, mode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const elements = Array.from({ length: heapWidth }, (_, index) => {
    const initial = valueFor(kind, index);
    if (mode === "rfsg") return React.createElement(React.Fragment, { key: index }, boundChildren(kind, signal(initial)));
    function Controlled() {
      const [value] = React.useState(initial);
      return children(React.createElement, kind, value, () => {});
    }
    return React.createElement(Controlled, { key: index });
  });
  act(() => root.render(React.createElement(React.Fragment, null, elements)));
  if (kind === "select" || kind === "multiple") selectNodeRefs.push({ kind, mode, reference: new WeakRef(container.querySelector("select")) });
  act(() => root.unmount());
  container.remove();
  await new Promise((resolve) => queueMicrotask(resolve));
}

async function measureRetainedHeap(kind, mode) {
  if (typeof globalThis.gc !== "function") return { available: false };
  for (let warmup = 0; warmup < 3; warmup += 1) await mountUnmountBatch(kind, mode);
  const deltas = [];
  for (let sample = 0; sample < samples; sample += 1) {
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let cycle = 0; cycle < heapCycles; cycle += 1) await mountUnmountBatch(kind, mode);
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
    deltas.push(process.memoryUsage().heapUsed - before);
  }
  return { available: true, heapDeltaBytes: summarize(deltas), cycles: heapCycles, controlsPerCycle: heapWidth };
}

const cases = (process.env.M11_FORM_CASES ?? "text,checked,select,multiple,radio,checkbox-group").split(",");
const results = [];
for (const kind of cases) {
  const [react, rfsg] = await Promise.all([measureCase(kind, "react"), measureCase(kind, "rfsg")]);
  results.push({ kind, react, rfsg });
}

const retainedHeap = {};
for (const kind of cases) {
  retainedHeap[kind] = {
    react: await measureRetainedHeap(kind, "react"),
    rfsg: await measureRetainedHeap(kind, "rfsg"),
  };
}
if (globalThis.gc) {
  for (let pass = 0; pass < 5; pass += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
}

console.log(JSON.stringify({
  node: process.version,
  react: React.version,
  warmups,
  samples,
  updatesPerSample: updates,
  heapCycles,
  heapWidth,
  mutationObserversCreated,
  mutationObserversDisconnected,
  selectNodesAliveAfterGC: selectNodeRefs.filter(({ reference }) => reference.deref() !== undefined).map(({ kind, mode }) => ({ kind, mode })),
  mutationObserversAliveAfterGC: mutationObserverRefs.filter((reference) => reference.deref() !== undefined).length,
  methodology: "JSDOM + React act. Each sample mounts one fresh root, applies every update in its own act flush, verifies final DOM state, then unmounts. React-controlled hooks are compared to RFSG direct signal bindings; owner rerenders are counted. Heap deltas use --expose-gc around repeated whole-root mount/unmount and are noisy process-level diagnostics, not browser-retained-heap guarantees. Times are milliseconds; range is p25-p75.",
  results,
  retainedHeap,
}, null, 2));
