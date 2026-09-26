import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repoRoot, "node_modules", ".cache", "phase4-duplicate-smoke");
const fixture = join(repoRoot, "tests", "fixtures", "phase4-duplicate-entry.ts");
const { build } = await import("tsdown");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

try {
  const copies = [];
  for (const name of ["copy-a", "copy-b", "copy-c"]) {
    const outDir = join(outputRoot, name);
    await build({
      config: false,
      entry: { index: fixture },
      outDir,
      format: "esm",
      platform: "neutral",
      dts: false,
      sourcemap: false,
      clean: true,
      deps: {
        alwaysBundle: [/^alien-signals(?:\/|$)/],
        neverBundle: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/],
      },
    });
    await import(pathToFileURL(join(outDir, "index.js")).href).then((module) => copies.push(module));

    const emittedFiles = await readdir(outDir, { recursive: true });
    const jsFiles = emittedFiles.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
    assert.ok(jsFiles.length > 0, `${name} emitted a JavaScript bundle`);
    let alienImportFound = false;
    let reactImportFound = false;
    for (const file of jsFiles) {
      const contents = await readFile(join(outDir, file), "utf8");
      if (/^\s*(?:import|export)\b[^\n]*\bfrom\s*["']alien-signals(?:\/|["'])/m.test(contents) ||
          /^\s*import\s*\(\s*["']alien-signals(?:\/|["'])/m.test(contents)) {
        alienImportFound = true;
      }
      if (/^\s*import\s+(?:[^\n]*\s+from\s*)?["']react["']/m.test(contents)) {
        reactImportFound = true;
      }
    }
    assert.equal(alienImportFound, false, `${name} bundles alien-signals instead of sharing an external import`);
    assert.equal(reactImportFound, true, `${name} keeps React external and shared`);
  }

  const [copyA, copyB, copyC] = copies;
  assert.notEqual(copyA.createReactiveRuntime, copyB.createReactiveRuntime);
  assert.notEqual(copyB.createReactiveRuntime, copyC.createReactiveRuntime);
  assert.equal(copyA.getSharedInteropContext(), copyB.getSharedInteropContext());
  assert.equal(copyB.getSharedInteropContext(), copyC.getSharedInteropContext());
  assert.equal(copyA.READABLE_INTEROP_V1, copyB.READABLE_INTEROP_V1);

  // Runtime A -> B source, including dynamic edges and Object.is behavior.
  const runtimeA = copyA.createReactiveRuntime();
  const runtimeB = copyB.createReactiveRuntime();
  const sourceB = runtimeB.signal(1);
  const chooseB = runtimeB.signal(true);
  const otherB = runtimeB.signal(2);
  const seen = [];
  const disposeEffect = runtimeA.effect(() => {
    seen.push(chooseB.value ? sourceB.value : otherB.value);
  });
  assert.deepEqual(seen, [1]);
  sourceB.value = 3;
  assert.deepEqual(seen, [1, 3]);
  chooseB.value = false;
  assert.deepEqual(seen, [1, 3, 2]);
  sourceB.value = 4;
  assert.deepEqual(seen, [1, 3, 2], "stale dynamic foreign branch is detached");
  otherB.value = 5;
  assert.deepEqual(seen, [1, 3, 2, 5]);
  disposeEffect();

  // A -> B computed preserves the intermediate equality boundary.
  const equalitySource = runtimeB.signal(10);
  const roundedB = runtimeB.computed(() => Math.floor(equalitySource.value / 10));
  const equalitySeen = [];
  const disposeEquality = runtimeA.effect(() => equalitySeen.push(roundedB.value));
  equalitySource.value = 11;
  assert.deepEqual(equalitySeen, [1], "Object.is-equal foreign computed result suppresses downstream work");
  equalitySource.value = 20;
  assert.deepEqual(equalitySeen, [1, 2]);
  disposeEquality();

  // Built public deepSignal from copy B retains fine-grained property versions,
  // sibling isolation, and root replacement across copy A's runtime.
  const deepState = copyB.deepSignal({ user: { name: "Ada", age: 36 } });
  const deepSeen = [];
  const disposeDeep = runtimeA.effect(() => deepSeen.push(deepState.value.user.name));
  deepState.value.user.age = 37;
  assert.deepEqual(deepSeen, ["Ada"], "a sibling property update does not notify a foreign name read");
  deepState.value.user.name = "Grace";
  assert.deepEqual(deepSeen, ["Ada", "Grace"], "foreign per-key property versions notify the matching dependency");
  deepState.value = { user: { name: "Lin", age: 20 } };
  assert.deepEqual(deepSeen, ["Ada", "Grace", "Lin"], "foreign root replacement is observed");
  disposeDeep();
  deepState.value.user.name = "stale";
  assert.deepEqual(deepSeen, ["Ada", "Grace", "Lin"], "disposing releases the foreign deep dependency");

  const zeroSource = runtimeB.signal(0);
  const zeroSeen = [];
  const disposeZero = runtimeA.effect(() => zeroSeen.push(zeroSource.value));
  zeroSource.value = -0;
  assert.equal(zeroSeen.length, 2, "Object.is distinguishes positive and negative zero");
  disposeZero();

  // Three independently bundled runtimes retain both intermediate boundaries.
  const runtimeC = copyC.createReactiveRuntime();
  const sourceC = runtimeC.signal(1);
  const computedB = runtimeB.computed(() => sourceC.value * 2);
  const computedA = runtimeA.computed(() => computedB.value + 1);
  const transitiveSeen = [];
  const disposeTransitive = runtimeA.effect(() => transitiveSeen.push(computedA.value));
  sourceC.value = 2;
  assert.deepEqual(transitiveSeen, [3, 5]);
  disposeTransitive();

  // Bounded feedback loops cross independently bundled alien systems.
  const cycleA = runtimeA.signal(0);
  const cycleB = runtimeB.signal(0);
  let cycleRunsA = 0;
  let cycleRunsB = 0;
  const disposeCycleA = runtimeA.effect(() => {
    cycleRunsA += 1;
    if (cycleB.value > cycleA.value) cycleA.value = cycleB.value;
  });
  const disposeCycleB = runtimeB.effect(() => {
    cycleRunsB += 1;
    if (cycleA.value > cycleB.value) cycleB.value = cycleA.value;
  });
  cycleA.value = 1;
  assert.equal(cycleA.value, 1);
  assert.equal(cycleB.value, 1);
  assert.ok(cycleRunsA < 10 && cycleRunsB < 10, "two-runtime feedback settles with bounded runs");
  disposeCycleA();
  disposeCycleB();

  const cycleSourceA = runtimeA.signal(0);
  const cycleSourceB = runtimeB.signal(0);
  const cycleSourceC = runtimeC.signal(0);
  let threeRuntimeRuns = 0;
  const disposeThreeRuntime = runtimeA.effect(() => {
    threeRuntimeRuns += 1;
    if (cycleSourceC.value > cycleSourceA.value) cycleSourceA.value = cycleSourceC.value;
  });
  const disposeThreeRuntimeB = runtimeB.effect(() => {
    if (cycleSourceA.value > cycleSourceB.value) cycleSourceB.value = cycleSourceA.value;
  });
  const disposeThreeRuntimeC = runtimeC.effect(() => {
    if (cycleSourceB.value > cycleSourceC.value) cycleSourceC.value = cycleSourceB.value;
  });
  cycleSourceA.value = 1;
  assert.deepEqual([cycleSourceA.value, cycleSourceB.value, cycleSourceC.value], [1, 1, 1]);
  assert.ok(threeRuntimeRuns < 10, "three-runtime feedback settles with bounded runs");
  disposeThreeRuntime();
  disposeThreeRuntimeB();
  disposeThreeRuntimeC();

  const computedCycleA = runtimeA.signal(0);
  const computedCycleB = runtimeB.signal(0);
  const computedCycleViewB = runtimeB.computed(() => computedCycleB.value);
  let computedCycleRunsA = 0;
  const disposeComputedCycleA = runtimeA.effect(() => {
    computedCycleRunsA += 1;
    if (computedCycleA.value === 0) computedCycleB.value = 1;
  });
  const disposeComputedCycleC = runtimeC.effect(() => {
    if (computedCycleViewB.value > computedCycleA.value) {
      computedCycleA.value = computedCycleViewB.value;
    }
  });
  assert.deepEqual([computedCycleA.value, computedCycleB.value], [1, 1]);
  assert.ok(computedCycleRunsA < 10, "a computed in a three-runtime cycle settles with bounded runs");
  disposeComputedCycleA();
  disposeComputedCycleC();

  // A foreign error remains connected and recovers when its source changes.
  const errorSource = runtimeB.signal(1);
  const errorValue = runtimeB.computed(() => {
    if (errorSource.value === 2) throw new Error("foreign failure");
    return errorSource.value;
  });
  const errorValues = [];
  const disposeError = runtimeA.effect(() => {
    try {
      errorValues.push(errorValue.value);
    } catch {
      errorValues.push("error");
    }
  });
  errorSource.value = 2;
  errorSource.value = 3;
  assert.deepEqual(errorValues, [1, "error", 3]);
  disposeError();

  // Cold foreign computed results are pulled fresh and do not require a global runtime.
  const coldSource = runtimeB.signal(4);
  const coldComputed = runtimeA.computed(() => coldSource.value * 2);
  assert.equal(coldComputed.value, 8);
  coldSource.value = 9;
  assert.equal(coldComputed.value, 18);

  await verifyDuplicateReactRender(copyA, copyB);
  console.log("Phase 4 duplicate-copy core and React smoke passed (3 RFSG bundles, each with bundled alien-signals).");
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

async function verifyDuplicateReactRender(copyA, copyB) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { url: "http://localhost" });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { renderToString } = await import("react-dom/server");
    const foreignRuntime = copyB.createReactiveRuntime();
    const foreign = foreignRuntime.signal("before");
    function Reader() {
      copyA.useSignalTracking();
      return React.createElement("output", null, foreign.value);
    }

    const rootElement = document.getElementById("root");
    assert.ok(rootElement);
    const root = createRoot(rootElement);
    await act(async () => root.render(React.createElement(Reader)));
    assert.equal(rootElement.textContent, "before");
    await act(async () => {
      foreign.value = "after";
    });
    assert.equal(rootElement.textContent, "after", "copy A's React collector subscribes to copy B's readable");
    const renderRuntime = copyB.createReactiveRuntime();
    const renderSource = renderRuntime.signal(10);
    const renderComputed = renderRuntime.computed(() => Math.floor(renderSource.value / 10));
    let renderCount = 0;
    function ComputedReader() {
      copyA.useSignalTracking();
      renderCount += 1;
      return React.createElement("output", null, renderComputed.value);
    }
    await act(async () => root.render(React.createElement(ComputedReader)));
    assert.equal(rootElement.textContent, "1");
    await act(async () => {
      renderSource.value = 11;
    });
    assert.equal(renderCount, 1, "foreign computed equality suppresses React rerender");
    await act(async () => {
      renderSource.value = 20;
    });
    assert.equal(rootElement.textContent, "2");
    assert.equal(renderCount, 2, "foreign computed change rerenders through the shared collector");
    const raceSource = renderRuntime.signal(1);
    let raceRenders = 0;
    let raceChanged = false;
    function RaceReader() {
      copyA.useSignalTracking();
      raceRenders += 1;
      const first = raceSource.value;
      if (!raceChanged) {
        raceChanged = true;
        raceSource.value = 2;
      }
      const second = raceSource.value;
      return React.createElement("output", null, `${first}:${second}`);
    }
    await act(async () => root.render(React.createElement(RaceReader)));
    assert.equal(rootElement.textContent, "2:2", "commit detects the first foreign revision observed in the render");
    assert.ok(raceRenders >= 2, "a read-to-commit foreign revision race causes a bounded rerender");

    const revertSource = renderRuntime.signal("initial");
    let revertRenders = 0;
    let hasReverted = false;
    function RevertReader() {
      copyA.useSignalTracking();
      revertRenders += 1;
      const first = revertSource.value;
      if (!hasReverted) {
        hasReverted = true;
        revertSource.value = "temporary";
        revertSource.value = "initial";
      }
      const second = revertSource.value;
      return React.createElement("output", null, `${first}:${second}`);
    }
    await act(async () => root.render(React.createElement(RevertReader)));
    assert.equal(rootElement.textContent, "initial:initial");
    assert.ok(revertRenders >= 2, "foreign change then revert is detected from the first observed revision");
    let ssrSource;
    function ServerReader() {
      copyA.useSignalTracking();
      return React.createElement("output", null, ssrSource.value);
    }
    ssrSource = renderRuntime.signal("server");
    assert.equal(renderToString(React.createElement(ServerReader)), "<output>server</output>");
    await Promise.resolve();
    assert.equal(copyB.getSharedInteropContext().renderScope, undefined, "SSR leaves no active shared render scope");

    let resolveGate;
    const gate = new Promise((fulfillGate) => {
      resolveGate = fulfillGate;
    });
    const abandonedSource = renderRuntime.signal("abandoned");
    let isSuspended = true;
    let suspendedRenders = 0;
    function SuspendedReader() {
      copyA.useSignalTracking();
      suspendedRenders += 1;
      const value = abandonedSource.value;
      if (isSuspended) throw gate;
      return React.createElement("output", null, value);
    }
    await act(async () => {
      root.render(React.createElement(
        React.Suspense,
        { fallback: React.createElement("output", null, "fallback") },
        React.createElement(SuspendedReader),
      ));
    });
    assert.equal(rootElement.textContent, "fallback");
    const rendersBeforeForeignWrite = suspendedRenders;
    abandonedSource.value = "resumed";
    await Promise.resolve();
    assert.equal(suspendedRenders, rendersBeforeForeignWrite, "abandoned foreign render has no durable subscription");
    await act(async () => {
      isSuspended = false;
      resolveGate();
      await gate;
    });
    assert.equal(rootElement.textContent, "resumed");

    // A direct pair of managed hooks exercises managed/managed nesting across
    // copies in one render attempt and ensures finishing the inner store does
    // not lose the outer collector.
    const managedA = copyA.createReactiveRuntime().signal("A");
    const managedB = renderRuntime.signal("B");
    function ManagedPair() {
      const outer = copyA.useManagedSignals();
      const first = managedA.value;
      const inner = copyB.useManagedSignals();
      const second = managedB.value;
      inner.finish();
      outer.finish();
      return React.createElement("output", null, `${first}:${second}`);
    }
    await act(async () => root.render(React.createElement(ManagedPair)));
    assert.equal(rootElement.textContent, "A:B");

    const siblingA = copyA.createReactiveRuntime().signal("left");
    const siblingB = copyB.createReactiveRuntime().signal("right");
    let siblingRendersA = 0;
    let siblingRendersB = 0;
    function SiblingA() {
      const store = copyA.useManagedSignals();
      siblingRendersA += 1;
      const value = siblingA.value;
      store.finish();
      return React.createElement("output", { "aria-label": "copy a" }, value);
    }
    function SiblingB() {
      const store = copyB.useManagedSignals();
      siblingRendersB += 1;
      const value = siblingB.value;
      store.finish();
      return React.createElement("output", { "aria-label": "copy b" }, value);
    }
    function Siblings() {
      return React.createElement(React.Fragment, null,
        React.createElement(SiblingA),
        React.createElement(SiblingB),
      );
    }
    await act(async () => root.render(React.createElement(Siblings)));
    assert.equal(siblingRendersA, 1);
    assert.equal(siblingRendersB, 1);
    await act(async () => {
      siblingA.value = "left updated";
    });
    assert.equal(siblingRendersA, 2);
    assert.equal(siblingRendersB, 1, "copy B sibling boundary remains isolated from copy A");
    assert.equal(rootElement.textContent, "left updatedright");
    await act(async () => root.unmount());
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", previousNavigator);
    delete globalThis.HTMLElement;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}
