import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const input = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, warmups = 3, samples = 7, preflightOnly = false } = input;
if (!new Set(["m15-control", "m15-candidate", "rfsg-current"]).has(runtimeId)) throw new Error(`Unknown runtime ${runtimeId}`);
if (!new Set(["useSignalValue", "deep-selector", "bare", "managed"]).has(kind)) throw new Error(`Unknown case ${kind}`);
if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error("iterations must be positive");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rootRequire = createRequire(pathToFileURL(resolve(repoRoot, "dist/index.js")).href);
const reactSpecifier = runtimeId === "rfsg-current" ? pathToFileURL(rootRequire.resolve("react")).href : "react";
const reactDomSpecifier = runtimeId === "rfsg-current" ? pathToFileURL(rootRequire.resolve("react-dom/client")).href : "react-dom/client";
const React = await import(reactSpecifier);
const { createRoot } = await import(reactDomSpecifier);
const control = runtimeId === "m15-control";
const candidate = runtimeId === "m15-candidate";
const api = runtimeId === "rfsg-current"
  ? await import(new URL("../../../dist/index.js", import.meta.url).href)
  : await import(new URL(`./bundled/${control ? "control/m15-control.js" : "candidate/m15-candidate.js"}`, import.meta.url).href);
const runtimeApi = runtimeId === "rfsg-current"
  ? await import(new URL("../../../dist/runtime.js", import.meta.url).href)
  : api;
const adapter = runtimeId === "rfsg-current"
  ? { useSignalTracking: api.useSignalTracking, useManagedSignals: runtimeApi.useManagedSignals }
  : api.createReactAdapter(api);
const hook = kind === "deep-selector"
  ? api.createDeepSelectorHook(api)
  : kind === "useSignalValue" ? (control ? api.createSignalValueHook(api) : api.useSignalValue ?? adapter.useSignalValue) : undefined;
const selector = (value) => value.user.name;

async function runOne(_timed) {
  const state = kind === "deep-selector"
    ? api.deepSignal({ user: { name: "0", age: 36 } })
    : control ? api.signalClassHelper(0) : candidate ? api.signalClassBrandHelper(0) : api.signal(0);
  let renders = 0;
  function Reader() {
    renders += 1;
    if (kind === "bare") adapter.useSignalTracking();
    const scope = kind === "managed" ? (adapter.useManagedSignals?.() ?? api.useManagedSignals?.()) : undefined;
    let value;
    try {
      value = kind === "deep-selector" ? hook(state, selector, [])
        : kind === "useSignalValue" ? hook(state)
          : state.value;
    } finally { scope?.finish(); }
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
