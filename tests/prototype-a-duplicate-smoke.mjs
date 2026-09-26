import assert from "node:assert/strict";
import { rm, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const outputRoot = join(root, "node_modules", ".cache", "prototype-a-duplicate-smoke");
const fixture = join(root, "tests", "fixtures", "prototype-a-duplicate-entry.ts");
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
    copies.push(await import(pathToFileURL(join(outDir, "index.js")).href));
    const jsFiles = (await readdir(outDir, { recursive: true })).filter(path => path.endsWith(".js"));
    let alienImportFound = false;
    for (const file of jsFiles) {
      const contents = await readFile(join(outDir, file), "utf8");
      alienImportFound ||= /^\s*(?:import|export)\b[^\n]*\bfrom\s*["']alien-signals(?:\/|["'])/m.test(contents);
    }
    assert.equal(alienImportFound, false, `${name} has a separately bundled alien-signals installation`);
  }

  const [a, b, c] = copies;
  assert.notEqual(a.createLeanRuntime, b.createLeanRuntime);
  assert.equal(a.getSharedInteropContext(), b.getSharedInteropContext());
  const runtimeA = a.createLeanRuntime(() => undefined);
  const runtimeB = b.createLeanRuntime(() => undefined);
  const runtimeC = c.createLeanRuntime(() => undefined);
  const sourceC = runtimeC.signal(1);
  const innerB = runtimeB.computed(() => sourceC.value % 2);
  const outerA = runtimeA.computed(() => innerB.value + 1);
  assert.equal(outerA.value, 2);
  sourceC.value = 3;
  assert.equal(outerA.value, 2, "A -> B -> C retains the middle computed equality boundary");
  sourceC.value = 4;
  assert.equal(outerA.value, 1);

  const seen = [];
  const dispose = runtimeA.effect(() => seen.push(sourceC.value));
  sourceC.value = -0;
  assert.equal(seen.length, 2, "Object.is distinguishes +0 and -0 across bundled runtimes");
  dispose();

  const enableCycle = runtimeA.signal(false);
  let cyclicA;
  const cyclicB = runtimeB.computed(() => cyclicA.value + 1);
  cyclicA = runtimeA.computed(() => enableCycle.value ? cyclicB.value + 1 : 1);
  assert.equal(cyclicA.value, 1);
  enableCycle.value = true;
  assert.throws(() => cyclicA.value, /cycle/i, "A -> B -> A computed cycle is bounded");
  enableCycle.value = false;
  assert.equal(cyclicA.value, 1, "the cross-runtime computed cycle recovers");

  const feedbackA = runtimeA.signal(0);
  const feedbackB = runtimeB.signal(0);
  let feedbackRunsA = 0;
  let feedbackRunsB = 0;
  const stopA = runtimeA.effect(() => {
    feedbackRunsA += 1;
    if (feedbackB.value > feedbackA.value) feedbackA.value = feedbackB.value;
  });
  const stopB = runtimeB.effect(() => {
    feedbackRunsB += 1;
    if (feedbackA.value > feedbackB.value) feedbackB.value = feedbackA.value;
  });
  feedbackA.value = 1;
  assert.deepEqual([feedbackA.value, feedbackB.value], [1, 1]);
  assert.ok(feedbackRunsA < 10 && feedbackRunsB < 10, "cross-runtime feedback is bounded");
  stopA();
  stopB();

  await verifyReact(a, b);
  console.log("Prototype A duplicate-copy core and React smoke passed (3 independent bundles).");
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

async function verifyReact(copyA, copyB) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const foreignRuntime = copyB.createLeanRuntime(() => undefined);
    const foreign = foreignRuntime.signal(1);
    const computed = foreignRuntime.computed(() => foreign.value * 2);
    let renders = 0;
    function Reader() {
      copyA.useSignalTracking();
      renders += 1;
      return React.createElement("output", null, computed.value);
    }
    const target = document.getElementById("root");
    const reactRoot = createRoot(target);
    await act(async () => reactRoot.render(React.createElement(Reader)));
    assert.equal(target.textContent, "2");
    await act(async () => { foreign.value = 2; });
    assert.equal(target.textContent, "4", "React in A rerenders from B's computed read");

    const equalitySource = foreignRuntime.signal(10);
    const equalUntilBoundary = foreignRuntime.computed(() => Math.floor(equalitySource.value / 10));
    let equalityRenders = 0;
    function EqualityReader() {
      copyA.useSignalTracking();
      equalityRenders += 1;
      return React.createElement("output", null, equalUntilBoundary.value);
    }
    await act(async () => reactRoot.render(React.createElement(EqualityReader)));
    const equalityBaseline = equalityRenders;
    await act(async () => { equalitySource.value = 11; });
    assert.equal(equalityRenders, equalityBaseline, "foreign computed equality suppresses React rerender");
    await act(async () => { equalitySource.value = 20; });
    assert.equal(target.textContent, "2");
    assert.equal(equalityRenders, equalityBaseline + 1);

    const identityComputed = foreignRuntime.computed(() => ({ value: foreign.value }));
    function IdentityReader() {
      copyA.useSignalTracking();
      return React.createElement("output", null, identityComputed.value.value);
    }
    await act(async () => reactRoot.render(React.createElement(IdentityReader)));
    assert.equal(target.textContent, "2");
    await act(async () => { foreign.value = 3; });
    assert.equal(target.textContent, "3", "foreign identity-unstable computed results stay fresh");

    const raceSource = foreignRuntime.signal(1);
    let raceRenders = 0;
    let changedDuringRender = false;
    function RaceReader() {
      copyA.useSignalTracking();
      raceRenders += 1;
      const first = raceSource.value;
      if (!changedDuringRender) {
        changedDuringRender = true;
        raceSource.value = 2;
      }
      return React.createElement("output", null, first);
    }
    await act(async () => reactRoot.render(React.createElement(RaceReader)));
    assert.equal(target.textContent, "2", "foreign first-observed render version closes the commit race");
    assert.ok(raceRenders >= 2);

    const revertSource = foreignRuntime.signal("initial");
    let reverted = false;
    let revertRenders = 0;
    function RevertReader() {
      copyA.useSignalTracking();
      revertRenders += 1;
      const first = revertSource.value;
      if (!reverted) {
        reverted = true;
        revertSource.value = "temporary";
        revertSource.value = "initial";
      }
      return React.createElement("output", null, `${first}:${revertSource.value}`);
    }
    await act(async () => reactRoot.render(React.createElement(RevertReader)));
    assert.equal(target.textContent, "initial:initial");
    assert.ok(revertRenders >= 2, "foreign change/revert is detected from the first observed revision");

    const interopContext = copyB.getSharedInteropContext();
    const fakeToken = {};
    let fakeValue = "mounted";
    let fakeRevision = 0;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const renderListeners = new Set();
    const fakeProtocol = {
      version: 1,
      runtimeToken: fakeToken,
      getRevision: () => fakeRevision,
      subscribe(listener) {
        subscribeCount += 1;
        renderListeners.add(listener);
        return { revision: fakeRevision, unsubscribe() { unsubscribeCount += 1; renderListeners.delete(listener); } };
      },
    };
    const instrumented = Object.defineProperty({}, "value", { get() {
      const observedRevision = fakeRevision;
      interopContext.renderCollector?.add(fakeProtocol, observedRevision);
      return fakeValue;
    } });
    copyB.attachReadableInterop(instrumented, fakeProtocol);
    function InstrumentedReader() {
      copyA.useSignalTracking();
      return React.createElement("output", null, instrumented.value);
    }
    await act(async () => reactRoot.render(React.createElement(InstrumentedReader)));
    assert.equal(copyB.getReadableInterop(instrumented), fakeProtocol);
    assert.equal(subscribeCount, 1);
    await act(async () => {
      fakeValue = "updated";
      fakeRevision += 1;
      for (const listener of Array.from(renderListeners)) listener(fakeRevision);
    });
    assert.equal(target.textContent, "updated");
    await act(async () => reactRoot.unmount());
    assert.equal(unsubscribeCount, 1, "unmount releases the foreign render protocol subscription");
    const rendersAtUnmount = renders;
    await act(async () => { foreign.value = 3; });
    assert.equal(renders, rendersAtUnmount, "unmounted foreign React dependency no longer rerenders");
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else delete globalThis.navigator;
  }
}
