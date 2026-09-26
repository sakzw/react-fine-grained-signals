import os from "node:os";
import { JSDOM } from "jsdom";
import { appendFileSync } from "node:fs";
import {
  createLeanRuntime,
  useManagedSignals as useLeanManagedSignals,
  useSignalTracking as useLeanSignalTracking,
} from "../node_modules/.cache/prototype-a/lean-entry.js";

// A plain `node` process has no DOM. Stand one up with jsdom before anything
// that touches `window`/`document` is imported (dynamic `import()` is used
// below specifically so react/react-dom/dist evaluate *after* these globals
// exist -- static imports are hoisted ahead of this file's own top-level
// code and would see `window` as undefined).
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node >=21 defines its own read-only `navigator` getter, so plain
// assignment throws; redefine the property instead.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactModule = await import("react");
const React = ReactModule;
const { useState, act } = ReactModule;
const { createRoot } = await import("react-dom/client");
const { signal, computed, useSignalTracking } = await import("../dist/index.js");
// The bundler plugin's shipped default (`transform: "managed"`, since commit
// 57f824e) never calls the bare `useSignalTracking()` above -- it rewrites call
// sites to this runtime entry point's managed boundary instead. Imported
// under an alias so both variants can be benchmarked side by side.
const { useManagedSignals } = await import("../dist/runtime.js");
// The JSX pragma a compiled `.tsx` file actually calls -- `jsx`/`jsxs` wrap
// `react/jsx-runtime`'s own factories with `createJsxWrapper` (src/runtime/jsx.ts),
// which runs `transformProps`-style work on *every* element, custom
// components and host elements alike. Every case above builds elements with
// `React.createElement` directly and so never touches this module at all;
// the cases below (`jsx-component`, `jsx-host-element`) close that gap.
const { jsx: signalsJsx, jsxs: signalsJsxs } = await import("../dist/jsx-runtime.js");

const rows = Number.parseInt(process.argv[2] ?? process.env.BENCH_ROWS ?? "500", 10);
const updates = Number.parseInt(process.argv[3] ?? process.env.BENCH_UPDATES ?? "300", 10);
const warmups = Number(process.env.BENCH_WARMUPS ?? 2);
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
if (!Number.isSafeInteger(rows) || rows < 1) throw new Error("BENCH_ROWS must be a positive integer");
if (!Number.isSafeInteger(updates) || updates < 1) throw new Error("BENCH_UPDATES must be a positive integer");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Builds `count` `<Component index={i} />` elements, keyed by index. */
const buildSiblingElements = (Component, count) =>
  Array.from({ length: count }, (_, index) => React.createElement(Component, { key: index, index }));
const percentile = (values, ratio) => {
  const index = (values.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
};

// Render-call totals per variant/component, reset at the start of every
// create() so each sample (warmup or timed) measures a clean run. This is
// the headline signal: it makes the "siblings don't re-render" claim an
// exact, assertable number instead of a vibe.
const renderCounts = {
  hooksNaive: { counter: 0, siblings: 0 },
  hooksMemo: { counter: 0, siblings: 0 },
  signals: { counter: 0, siblings: 0 },
  signalsManaged: { counter: 0, siblings: 0 },
  lean: { counter: 0, siblings: 0 },
  leanManaged: { counter: 0, siblings: 0 },
  unrelatedCurrent: { counter: 0, siblings: 0 },
  unrelatedLean: { counter: 0, siblings: 0 },
  equalityCurrent: { counter: 0, siblings: 0 },
  equalityLean: { counter: 0, siblings: 0 },
  manyCurrent: { counter: 0, siblings: 0 },
  manyLean: { counter: 0, siblings: 0 },
  jsxComponent: { counter: 0, siblings: 0 },
  jsxHostElement: { counter: 0, siblings: 0 },
};

/**
 * Builds the plain-hooks variant: a `HooksApp` holding `useState`, one
 * `HooksCounter`, and `rows` `HooksSibling`s. `memoizeSibling` toggles
 * between the naive (no memo anywhere) and optimized (`React.memo` on the
 * sibling) hooks answers -- everything else is identical, matching the
 * "hooks-memo is hooks-naive plus one memo" framing.
 */
function createHooksVariant(counts, memoizeSibling) {
  function HooksCounter(props) {
    counts.counter += 1;
    return React.createElement("li", null, "count:", props.count);
  }

  function HooksSiblingBase(props) {
    counts.siblings += 1;
    return React.createElement("li", null, "row ", props.index);
  }

  const HooksSibling = memoizeSibling ? React.memo(HooksSiblingBase) : HooksSiblingBase;
  // Exposes the `setCount` updater to the benchmark harness, which drives
  // updates directly (like a real event handler would) instead of a state
  // setter it owns. Reused safely across sequential mounts since only one
  // mount is ever live at a time.
  const handle = {};

  function HooksApp() {
    const [count, setCount] = useState(0);
    handle.increment = () => setCount((previous) => previous + 1);
    return React.createElement(
      "ul",
      null,
      React.createElement(HooksCounter, { count, onIncrement: handle.increment }),
      ...buildSiblingElements(HooksSibling, rows),
    );
  }

  return { App: HooksApp, handle };
}

/**
 * Builds the signals variant: `count` is a single module/benchmark-scoped
 * signal (not per-mount `useState`), created once here. `SignalsApp` never
 * calls `useSignalTracking()` and never reads `count.value`, so it renders exactly
 * once, ever; only `SignalsCounter` opts in and re-renders on writes.
 * `SignalsSibling` is a plain, unmemoized component -- proof that siblings
 * need zero opt-in to be skipped.
 */
function createSignalsVariant(counts) {
  const count = signal(0);

  function SignalsCounter() {
    useSignalTracking();
    counts.counter += 1;
    return React.createElement("li", null, "count:", count.value);
  }

  function SignalsSibling(props) {
    counts.siblings += 1;
    return React.createElement("li", null, "row ", props.index);
  }

  function SignalsApp() {
    return React.createElement(
      "ul",
      null,
      React.createElement(SignalsCounter),
      ...buildSiblingElements(SignalsSibling, rows),
    );
  }

  return { App: SignalsApp, count };
}

/**
 * Builds the managed-boundary signals variant: same shape as
 * `createSignalsVariant` above, but `ManagedSignalsCounter` opens and closes
 * its render scope the way the plugin's shipped `transform: "managed"`
 * output does -- `const store = useManagedSignals(); try { ... } finally {
 * store.finish(); }` against `react-fine-grained-signals/runtime` -- instead of calling
 * the bare `useSignalTracking()` hook. This is the boundary real apps built with
 * the default toolchain actually run, so it's benchmarked alongside the bare
 * variant rather than in its place.
 */
function createManagedSignalsVariant(counts) {
  const count = signal(0);

  function ManagedSignalsCounter() {
    const store = useManagedSignals();
    try {
      counts.counter += 1;
      return React.createElement("li", null, "count:", count.value);
    } finally {
      store.finish();
    }
  }

  function ManagedSignalsSibling(props) {
    counts.siblings += 1;
    return React.createElement("li", null, "row ", props.index);
  }

  function ManagedSignalsApp() {
    return React.createElement(
      "ul",
      null,
      React.createElement(ManagedSignalsCounter),
      ...buildSiblingElements(ManagedSignalsSibling, rows),
    );
  }

  return { App: ManagedSignalsApp, count };
}

function createLeanSignalsVariant(counts, managed) {
  const runtime = createLeanRuntime(() => undefined);
  const count = runtime.signal(0);
  function renderCounter() {
    counts.counter += 1;
    return React.createElement("li", null, "count:", count.value);
  }
  function LeanCounter() {
    const store = useLeanManagedSignals();
    try {
      return renderCounter();
    } finally {
      store.finish();
    }
  }
  function UnmanagedLeanCounter() { useLeanSignalTracking(); return renderCounter(); }
  function LeanSibling(props) {
    counts.siblings += 1;
    return React.createElement("li", null, "row ", props.index);
  }
  function LeanApp() {
    return React.createElement("ul", null,
      React.createElement(managed ? LeanCounter : UnmanagedLeanCounter),
      ...buildSiblingElements(LeanSibling, rows),
    );
  }
  return { App: LeanApp, count };
}

function createControlledSignalsVariant(counts, lean, managed, mode) {
  const runtime = lean ? createLeanRuntime(() => undefined) : { signal, computed };
  const useManaged = lean ? useLeanManagedSignals : useManagedSignals;
  const useUnmanaged = lean ? useLeanSignalTracking : useSignalTracking;
  const displayed = runtime.signal(0);
  const trigger = mode === "unrelated" ? runtime.signal(0) : displayed;
  const value = mode === "equality" ? runtime.computed(() => Math.floor(trigger.value / 10)) : displayed;
  function renderCounter() {
    counts.counter += 1;
    return React.createElement("li", null, "count:", value.value);
  }
  function Counter() {
    const store = useManaged();
    try {
      return renderCounter();
    } finally {
      store.finish();
    }
  }
  function UnmanagedCounter() { useUnmanaged(); return renderCounter(); }
  function Sibling(props) {
    counts.siblings += 1;
    return React.createElement("li", null, "row ", props.index);
  }
  function App() {
    return React.createElement("ul", null, React.createElement(managed ? Counter : UnmanagedCounter), ...buildSiblingElements(Sibling, rows));
  }
  return {
    App,
    displayed,
    increment: () => { trigger.value += 1; },
    getStart: () => mode === "equality" ? Math.floor(trigger.value / 10) : displayed.value,
  };
}

function createManySubscriberVariant(counts, lean) {
  const runtime = lean ? createLeanRuntime(() => undefined) : { signal };
  const useTracking = lean ? useLeanSignalTracking : useSignalTracking;
  const sources = Array.from({ length: rows }, () => runtime.signal(0));
  const renders = Array(rows).fill(0);
  function Leaf({ index }) {
    useTracking();
    counts.siblings += 1;
    renders[index] += 1;
    return React.createElement("li", null, sources[index].value);
  }
  function App() {
    return React.createElement("ul", null, ...sources.map((_, index) => React.createElement(Leaf, { key: index, index })));
  }
  return {
    App,
    getStart: () => 0,
    reset() { for (const source of sources) source.value = 0; renders.fill(0); },
    increment() { for (const source of sources) source.value += 1; },
    customCheck(state, updateCount) {
      if (renders.some((count) => count !== updateCount + 1)) throw new Error("many subscribers: a leaf missed or duplicated updates");
      const values = Array.from(state.container.querySelectorAll("li"), (element) => Number(element.textContent));
      if (values.length !== rows || values.some((value) => value !== updateCount)) throw new Error(`many subscribers: wrong final values ${JSON.stringify(values)} (wanted ${updateCount})`);
    },
  };
}

/**
 * Builds the JSX-pragma variant for a non-reactive custom function component:
 * `rows` `PlainPropsRow`s, each created via `signalsJsx(PlainPropsRow, props,
 * key)` -- exactly what a compiled `<PlainPropsRow ... />` call site becomes
 * -- with a handful of plain props (no signals anywhere). Since none of it is
 * memoized, every update re-renders `JsxComponentApp`, which re-invokes
 * `signalsJsx` for all `rows` elements again, the same shape as
 * `hooks-naive` above but exercising the real JSX pragma instead of
 * `React.createElement`.
 */
function createJsxComponentVariant(counts) {
  function PlainPropsRow(props) {
    counts.siblings += 1;
    return signalsJsx("li", { children: ["row ", props.index] }, undefined);
  }

  /** Builds `count` `<PlainPropsRow ... />` elements via the real JSX pragma, keyed by index. */
  const buildPlainPropsRows = (count) =>
    Array.from({ length: count }, (_, index) =>
      signalsJsx(
        PlainPropsRow,
        { id: `row-${index}`, label: "Row label", count: index, active: index % 2 === 0, index },
        index,
      ),
    );

  const handle = {};

  function JsxComponentApp() {
    const [count, setCount] = useState(0);
    handle.increment = () => setCount((previous) => previous + 1);
    counts.counter += 1;
    return signalsJsxs(
      "ul",
      { children: [signalsJsx("li", { children: ["count:", count] }, "counter"), buildPlainPropsRows(rows)] },
      undefined,
    );
  }

  return { App: JsxComponentApp, handle };
}

/**
 * Builds the JSX-pragma variant for a plain native host element: `rows`
 * `<li>`s, each created via `signalsJsx("li", props, key)` with several plain
 * string/number attributes and no signal bindings at all -- so
 * `transformHostProps`'s reactive-prop scan always finds nothing to bind.
 * Otherwise identical in shape to `createJsxComponentVariant` above.
 */
function createJsxHostVariant(counts) {
  /** Builds `count` plain `<li id=... className=... .../>` elements via the real JSX pragma. */
  const buildPlainHostRows = (count) =>
    Array.from({ length: count }, (_, index) => {
      counts.siblings += 1;
      return signalsJsx(
        "li",
        {
          id: `row-${index}`,
          className: "row",
          title: "Row title",
          "data-index": index,
          tabIndex: index,
          children: ["row ", index],
        },
        index,
      );
    });

  const handle = {};

  function JsxHostApp() {
    const [count, setCount] = useState(0);
    handle.increment = () => setCount((previous) => previous + 1);
    counts.counter += 1;
    return signalsJsxs(
      "ul",
      { children: [signalsJsx("li", { children: ["count:", count] }, "counter"), buildPlainHostRows(rows)] },
      undefined,
    );
  }

  return { App: JsxHostApp, handle };
}

const { App: HooksNaiveApp, handle: hooksNaiveHandle } = createHooksVariant(renderCounts.hooksNaive, false);
const { App: HooksMemoApp, handle: hooksMemoHandle } = createHooksVariant(renderCounts.hooksMemo, true);
// `count` is created once, above, and outlives every individual mount --
// exactly the decoupling from component lifetime that useState can't offer.
const { App: SignalsApp, count: signalsCount } = createSignalsVariant(renderCounts.signals);
const { App: ManagedSignalsApp, count: managedSignalsCount } =
  createManagedSignalsVariant(renderCounts.signalsManaged);
const { App: LeanSignalsApp, count: leanSignalsCount } = createLeanSignalsVariant(renderCounts.lean, false);
const { App: LeanManagedSignalsApp, count: leanManagedSignalsCount } = createLeanSignalsVariant(renderCounts.leanManaged, true);
const unrelatedCurrent = createControlledSignalsVariant(renderCounts.unrelatedCurrent, false, false, "unrelated");
const unrelatedLean = createControlledSignalsVariant(renderCounts.unrelatedLean, true, false, "unrelated");
const equalityCurrent = createControlledSignalsVariant(renderCounts.equalityCurrent, false, false, "equality");
const equalityLean = createControlledSignalsVariant(renderCounts.equalityLean, true, false, "equality");
const manyCurrent = createManySubscriberVariant(renderCounts.manyCurrent, false);
const manyLean = createManySubscriberVariant(renderCounts.manyLean, true);
const { App: JsxComponentApp, handle: jsxComponentHandle } = createJsxComponentVariant(renderCounts.jsxComponent);
const { App: JsxHostApp, handle: jsxHostHandle } = createJsxHostVariant(renderCounts.jsxHostElement);

/**
 * Wraps one variant's App/increment/render-counts into the create/run/check/
 * dispose shape used by `benchmark()` below, mirroring the case pattern in
 * benchmarks/core.mjs. `getStart` reports the counter's value *before* this
 * mount's updates run, so `signals` (whose backing signal is never reset)
 * and the hooks variants (which always start at 0) share one assertion.
 */
function makeVariant({ name, counts, expectedSiblingRenders, App, increment, getStart, expectedCounterRenders, expectedDisplay, customCheck, reset }) {
  return {
    name,
    counts,
    create() {
      counts.counter = 0;
      counts.siblings = 0;
      reset?.();
      const startCount = getStart();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      act(() => {
        root.render(React.createElement(App));
      });
      return { container, root, startCount };
    },
    run(state, updateCount) {
      for (let index = 0; index < updateCount; index += 1) {
        act(() => {
          increment();
        });
      }
    },
    check(state, updateCount) {
      if (customCheck) {
        customCheck(state, updateCount);
        return;
      }
      const expectedCounter = expectedCounterRenders ? expectedCounterRenders(updateCount) : updateCount + 1;
      assert(
        counts.counter === expectedCounter,
        `${name}: expected ${expectedCounter} counter renders, got ${counts.counter}`,
      );
      const expectedSiblings = expectedSiblingRenders(updateCount);
      assert(
        counts.siblings === expectedSiblings,
        `${name}: expected ${expectedSiblings} sibling renders, got ${counts.siblings}`,
      );
      const expectedFinal = expectedDisplay ? expectedDisplay(state.startCount, updateCount) : state.startCount + updateCount;
      const counterNode = state.container.querySelector("li");
      const expectedText = `count:${expectedFinal}`;
      assert(
        counterNode?.textContent === expectedText,
        `${name}: expected counter text "${expectedText}", got "${counterNode?.textContent}"`,
      );
    },
    dispose(state) {
      act(() => {
        state.root.unmount();
      });
      state.container.remove();
    },
  };
}

const allVariants = [
  makeVariant({
    name: "hooks-naive",
    counts: renderCounts.hooksNaive,
    expectedSiblingRenders: (updateCount) => rows * (updateCount + 1),
    App: HooksNaiveApp,
    increment: () => hooksNaiveHandle.increment(),
    getStart: () => 0,
  }),
  makeVariant({
    name: "hooks-memo",
    counts: renderCounts.hooksMemo,
    expectedSiblingRenders: () => rows,
    App: HooksMemoApp,
    increment: () => hooksMemoHandle.increment(),
    getStart: () => 0,
  }),
  makeVariant({
    name: "signals",
    counts: renderCounts.signals,
    expectedSiblingRenders: () => rows,
    App: SignalsApp,
    increment: () => {
      signalsCount.value += 1;
    },
    getStart: () => signalsCount.value,
  }),
  makeVariant({
    name: "signals-managed",
    counts: renderCounts.signalsManaged,
    expectedSiblingRenders: () => rows,
    App: ManagedSignalsApp,
    increment: () => {
      managedSignalsCount.value += 1;
    },
    getStart: () => managedSignalsCount.value,
  }),
  makeVariant({
    name: "lean",
    counts: renderCounts.lean,
    expectedSiblingRenders: () => rows,
    App: LeanSignalsApp,
    increment: () => { leanSignalsCount.value += 1; },
    getStart: () => leanSignalsCount.value,
  }),
  makeVariant({
    name: "lean-managed",
    counts: renderCounts.leanManaged,
    expectedSiblingRenders: () => rows,
    App: LeanManagedSignalsApp,
    increment: () => { leanManagedSignalsCount.value += 1; },
    getStart: () => leanManagedSignalsCount.value,
  }),
  ...[ ["unrelated-current", unrelatedCurrent, renderCounts.unrelatedCurrent], ["unrelated-lean", unrelatedLean, renderCounts.unrelatedLean] ].map(([name, instance, counts]) => makeVariant({
    name, counts, expectedSiblingRenders: () => rows, App: instance.App,
    increment: instance.increment, getStart: instance.getStart,
    expectedCounterRenders: () => 1, expectedDisplay: (start) => start,
  })),
  ...[ ["equality-current", equalityCurrent, renderCounts.equalityCurrent], ["equality-lean", equalityLean, renderCounts.equalityLean] ].map(([name, instance, counts]) => makeVariant({
    name, counts, expectedSiblingRenders: () => rows, App: instance.App,
    increment: instance.increment, getStart: instance.getStart,
    expectedCounterRenders: (count) => Math.floor(count / 10) + 1,
    expectedDisplay: (start, count) => start + Math.floor(count / 10),
  })),
  ...[ ["many-current", manyCurrent, renderCounts.manyCurrent], ["many-lean", manyLean, renderCounts.manyLean] ].map(([name, instance, counts]) => makeVariant({
    name, counts, expectedSiblingRenders: (count) => rows * (count + 1),
    App: instance.App, increment: instance.increment, getStart: instance.getStart,
    customCheck: instance.customCheck, reset: instance.reset,
  })),
  makeVariant({
    name: "jsx-component",
    counts: renderCounts.jsxComponent,
    expectedSiblingRenders: (updateCount) => rows * (updateCount + 1),
    App: JsxComponentApp,
    increment: () => jsxComponentHandle.increment(),
    getStart: () => 0,
  }),
  makeVariant({
    name: "jsx-host-element",
    counts: renderCounts.jsxHostElement,
    expectedSiblingRenders: (updateCount) => rows * (updateCount + 1),
    App: JsxHostApp,
    increment: () => jsxHostHandle.increment(),
    getStart: () => 0,
  }),
];

function benchmark(variant) {
  // A full, checked pass before any warmups so a broken variant fails fast
  // instead of burning time on samples that would only fail later anyway.
  const smoke = variant.create();
  variant.run(smoke, updates);
  variant.check(smoke, updates);
  variant.dispose(smoke);

  const mountTimings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const start = process.hrtime.bigint();
    const state = variant.create();
    mountTimings.push(Number(process.hrtime.bigint() - start) / 1e9);
    variant.dispose(state);
  }
  mountTimings.sort((left, right) => left - right);

  for (let round = 0; round < warmups; round += 1) {
    const state = variant.create();
    variant.run(state, updates);
    variant.dispose(state);
  }

  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    global.gc?.();
    const state = variant.create();
    const start = process.hrtime.bigint();
    variant.run(state, updates);
    timings.push(Number(process.hrtime.bigint() - start) / 1e9);
    // Correctness is checked outside the timed region, same as the other benchmarks.
    variant.check(state, updates);
    variant.dispose(state);
  }

  timings.sort((left, right) => left - right);
  const median = percentile(timings, 0.5);
  return {
    variant: variant.name,
    "counter renders": variant.counts.counter,
    "sibling renders (total)": variant.counts.siblings,
    "mount median ms": (percentile(mountTimings, 0.5) * 1e3).toFixed(3),
    "mount p25–p75 ms": `${(percentile(mountTimings, 0.25) * 1e3).toFixed(3)}–${(percentile(mountTimings, 0.75) * 1e3).toFixed(3)}`,
    "median ms": (median * 1e3).toFixed(3),
    "p25 ms": (percentile(timings, 0.25) * 1e3).toFixed(3),
    "p75 ms": (percentile(timings, 0.75) * 1e3).toFixed(3),
    "updates/s": (updates / median).toLocaleString("en-US", { maximumFractionDigits: 0 }),
  };
}

console.log(
  `Node ${process.version}; ${rows.toLocaleString()} sibling rows, ${updates.toLocaleString()} counter updates; ${samples} samples after ${warmups} warmups`,
);
console.log(`${os.platform()} ${os.arch()}; ${os.cpus()[0]?.model ?? "unknown CPU"}`);
console.log("Manual diagnostics only: compare results only on identical Node versions and hardware.");
const requestedVariant = process.env.BENCH_VARIANT;
const variants = requestedVariant ? allVariants.filter((variant) => variant.name === requestedVariant) : allVariants;
if (requestedVariant && variants.length === 0) throw new Error(`Unknown BENCH_VARIANT: ${requestedVariant}`);
const results = variants.map(benchmark);
console.table(results);
if (process.env.BENCH_OUTPUT) {
  const metadata = {
    kind: "react-sample", date: "2026-09-26", commit: "906a0108b212dff2c84ed226c48063a6d096cc40",
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, react: "19.2.8", rows, updates, warmups, samples,
  };
  for (const result of results) appendFileSync(process.env.BENCH_OUTPUT, `${JSON.stringify({ ...metadata, ...result })}\n`);
}
if (requestedVariant) process.exit(0);

/**
 * The React-render harness above wraps every `jsx`/`jsxs` call in `act()`,
 * a full commit, and real DOM work -- useful for "did this regress the whole
 * app", but too noisy to see a per-call saving of one small object
 * allocation. This isolates `jsx`/`jsxs` themselves: build the element, read
 * one field back off it (so V8 can't prove the call is dead and elide it),
 * never touch React DOM at all.
 */
function benchmarkJsxCalls(name, callsPerSample, callJsx) {
  const jsxWarmups = 3;
  const jsxSamples = 7;

  const run = () => {
    let sink = 0;
    for (let index = 0; index < callsPerSample; index += 1) {
      sink += callJsx(index).props.index;
    }
    return sink;
  };

  for (let round = 0; round < jsxWarmups; round += 1) run();

  const timings = [];
  for (let sample = 0; sample < jsxSamples; sample += 1) {
    global.gc?.();
    const start = process.hrtime.bigint();
    const sink = run();
    timings.push(Number(process.hrtime.bigint() - start) / 1e9);
    assert(Number.isFinite(sink), `${name}: sink was not finite`);
  }

  timings.sort((left, right) => left - right);
  const median = percentile(timings, 0.5);
  return {
    case: name,
    "calls/sample": callsPerSample.toLocaleString("en-US"),
    "median ms": (median * 1e3).toFixed(3),
    "ns/call": ((median * 1e9) / callsPerSample).toFixed(1),
    "calls/s": (callsPerSample / median).toLocaleString("en-US", { maximumFractionDigits: 0 }),
  };
}

// Never actually rendered by React -- `jsx()` only builds an element object
// referencing this as `type`, it never invokes the function -- so its body
// is irrelevant; only its identity as "a custom function component" matters.
function MicroBenchComponent(props) {
  return props.index;
}

const microBenchComponentProps = { id: "row", label: "Row label", count: 0, active: true };
const microBenchHostProps = { id: "row", className: "row", title: "Row title", "data-index": 0, tabIndex: 0 };
const jsxCallsPerSample = 200_000;

const jsxMicroCases = [
  {
    name: "jsx() custom component (plain props)",
    callJsx: (index) => signalsJsx(MicroBenchComponent, { ...microBenchComponentProps, index }, index),
  },
  {
    name: "jsx() host element (plain props, no signals)",
    callJsx: (index) => signalsJsx("li", { ...microBenchHostProps, index }, index),
  },
];

console.log("\nIsolated JSX-pragma cost (jsx()/jsxs() only -- no React render/commit):");
console.table(jsxMicroCases.map((jsxCase) => benchmarkJsxCalls(jsxCase.name, jsxCallsPerSample, jsxCase.callJsx)));
