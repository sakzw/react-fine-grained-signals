import { JSDOM } from "jsdom";
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const payload = JSON.parse(process.argv[2] ?? "{}");
const { runtimeId, kind, iterations, warmups, samples } = payload;
if (!runtimeId || !["rfsg-v0.1.1", "rfsg-current"].includes(runtimeId)) {
  throw new Error("React workload requires an RFSG historical or current runtime.");
}
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("React worker needs positive iterations.");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootEntryUrl = pathToFileURL(resolve(repoRoot, "dist/index.js")).href;
const rootRequire = createRequire(rootEntryUrl);
const reactUrl = pathToFileURL(rootRequire.resolve("react")).href;
const reactDomClientUrl = pathToFileURL(rootRequire.resolve("react-dom/client")).href;
const oldEntryPath = fileURLToPath(import.meta.resolve("react-fine-grained-signals"));
const oldPackageRoot = dirname(dirname(oldEntryPath));
const rootNodeModules = resolve(repoRoot, "node_modules");
const legacyCopyPath = resolve(rootNodeModules, `.phase9-rfsg-v011-${process.pid}`);
if (!legacyCopyPath.startsWith(`${rootNodeModules}${sep}`)) throw new Error("Refusing an out-of-workspace historical package copy.");
await cp(oldPackageRoot, legacyCopyPath, { recursive: true, errorOnExist: true, force: false });

const React = await import(reactUrl);
const { act, createElement } = React;
const { createRoot } = await import(reactDomClientUrl);
const api = runtimeId === "rfsg-v0.1.1"
  ? await import(pathToFileURL(resolve(legacyCopyPath, "dist/index.js")).href)
  : await import("../../dist/index.js");
const runtimeApi = runtimeId === "rfsg-v0.1.1"
  ? await import(pathToFileURL(resolve(legacyCopyPath, "dist/runtime.js")).href)
  : await import("../../dist/runtime.js");
const jsxApi = runtimeId === "rfsg-v0.1.1"
  ? await import(pathToFileURL(resolve(legacyCopyPath, "dist/jsx-runtime.js")).href)
  : await import("../../dist/jsx-runtime.js");

function buildApp(state) {
  if (kind === "bare") {
    const track = runtimeId === "rfsg-v0.1.1" ? api.useSignals : api.useSignalTracking;
    return function BareApp() {
      track();
      state.renders += 1;
      return createElement("output", { "data-value": state.source.value }, String(state.source.value));
    };
  }
  if (kind === "managed") {
    const begin = runtimeId === "rfsg-v0.1.1" ? runtimeApi.useSignals : runtimeApi.useManagedSignals;
    return function ManagedApp() {
      const store = begin();
      try {
        state.renders += 1;
        return createElement("output", { "data-value": state.source.value }, String(state.source.value));
      } finally {
        store.finish();
      }
    };
  }
  if (kind === "useSignalValue") {
    return function SignalValueApp() {
      const value = api.useSignalValue(state.source);
      state.renders += 1;
      return createElement("output", { "data-value": value }, String(value));
    };
  }
  if (kind === "jsx-binding") {
    return function JsxBindingApp() {
      state.renders += 1;
      return jsxApi.jsx("output", { title: state.source, children: "bound" });
    };
  }
  throw new Error(`Unknown React workload: ${kind}`);
}

async function runOne(timed) {
  const state = { source: api.signal(0), renders: 0 };
  const App = buildApp(state);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let durationNs = 0;
  try {
    await act(() => root.render(createElement(App)));
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      await act(() => { state.source.value = index + 1; });
    }
    if (timed) durationNs = Math.round((performance.now() - startedAt) * 1e6);

    const output = container.querySelector("output");
    if (!output) throw new Error("React workload did not mount an output element.");
    if (kind === "jsx-binding") {
      if (output.getAttribute("title") !== String(iterations)) {
        throw new Error(`JSX direct binding expected title=${iterations}, found ${output.getAttribute("title")}`);
      }
      if (state.renders !== 1) throw new Error(`Direct binding unexpectedly rendered ${state.renders} times.`);
    } else {
      if (output.textContent !== String(iterations)) {
        throw new Error(`React output expected ${iterations}, found ${output.textContent}`);
      }
      if (state.renders !== iterations + 1) {
        throw new Error(`Expected ${iterations + 1} component renders, got ${state.renders}.`);
      }
    }
    return { durationNs, renders: state.renders, domValue: kind === "jsx-binding" ? output.getAttribute("title") : output.textContent };
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

const writeJson = (value) => new Promise((finish, reject) => {
  process.stdout.write(JSON.stringify(value), (error) => error ? reject(error) : finish());
});

try {
  await runOne(false);
  for (let index = 0; index < warmups; index += 1) {
    global.gc?.();
    await runOne(false);
  }
  const results = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const result = await runOne(true);
    results.push({ sample, ...result });
  }
  await writeJson({ status: "ok", preflight: "passed", gcExposed: typeof global.gc === "function", samples: results });
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  dom.window.close();
  await rm(legacyCopyPath, { recursive: true, force: true });
}
