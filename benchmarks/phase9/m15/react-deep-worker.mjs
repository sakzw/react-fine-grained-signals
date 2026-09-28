import { JSDOM } from "jsdom";
import { performance } from "node:perf_hooks";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
if (!new Set(["m15-control", "m15-candidate"]).has(runtimeId)) throw new Error(`Unknown runtime ${runtimeId}`);
if (!new Set(["useSignalValue", "deep-selector"]).has(kind)) throw new Error(`Unknown case ${kind}`);
if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error("iterations must be positive");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const bundlePath = new URL(`./bundled/${runtimeId === "m15-control" ? "control/m15-control.js" : "candidate/m15-candidate.js"}`, import.meta.url);
const api = await import(bundlePath.href);
const control = runtimeId === "m15-control";
const hook = kind === "deep-selector"
  ? api.createDeepSelectorHook(api)
  : control ? api.createSignalValueHook(api) : api.createReactAdapter(api).useSignalValue;
const selector = (value) => value.user.name;

async function runOne(_timed) {
  const state = kind === "deep-selector"
    ? api.deepSignal({ user: { name: "0", age: 36 } })
    : (control ? api.signalClassHelper(0) : api.signalClassBrandHelper(0));
  let renders = 0;
  function Reader() {
    renders += 1;
    const value = kind === "deep-selector" ? hook(state, selector, []) : hook(state);
    return React.createElement("output", { "aria-label": "result" }, String(value));
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(() => root.render(React.createElement(Reader)));
    const start = performance.now();
    for (let index = 1; index <= iterations; index += 1) {
      await React.act(() => {
        if (kind === "deep-selector") state.value.user.name = String(index);
        else state.value = index;
      });
    }
    const durationNs = Math.round((performance.now() - start) * 1e6);
    const output = container.querySelector("output");
    if (output?.textContent !== String(iterations)) throw new Error(`Expected ${iterations}, got ${output?.textContent}`);
    if (renders !== iterations + 1) throw new Error(`Expected ${iterations + 1} renders, got ${renders}`);
    return { durationNs, renders, value: output.textContent };
  } finally {
    await React.act(() => root.unmount());
    container.remove();
  }
}

try {
  await runOne(false);
  if (preflightOnly) {
    process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, kind, iterations }));
  } else {
    for (let i = 0; i < warmups; i += 1) { global.gc?.(); await runOne(false); }
    const durationsNs = [];
    for (let i = 0; i < samples; i += 1) { global.gc?.(); durationsNs.push((await runOne(true)).durationNs); }
    process.stdout.write(JSON.stringify({ status: "ok", preflight: "passed", runtimeId, kind, iterations, durationsNs }));
  }
} finally {
  dom.window.close();
}
