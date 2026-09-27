import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(repositoryRoot, ".cross-copy-smoke-"));
const { build } = await import("tsdown");

try {
  const copies = [];
  for (const name of ["copy-a", "copy-b", "copy-c"]) {
    const outDir = join(temporaryRoot, name);
    await build({
      config: false,
      entry: {
        index: join(repositoryRoot, "src/index.ts"),
        runtime: join(repositoryRoot, "src/runtime.ts"),
        "jsx-runtime": join(repositoryRoot, "src/jsx-runtime.ts"),
        "interop-test": join(repositoryRoot, "tests/fixtures/cross-copy-interop-entry.ts"),
      },
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
    const files = await readdir(outDir, { recursive: true });
    for (const file of files.filter((item) => item.endsWith(".js"))) {
      const contents = await readFile(join(outDir, file), "utf8");
      assert.doesNotMatch(contents, /from\s*["']alien-signals(?:\/|["'])/);
    }
    copies.push({
      api: await import(pathToFileURL(join(outDir, "index.js")).href),
      runtime: await import(pathToFileURL(join(outDir, "runtime.js")).href),
      jsx: await import(pathToFileURL(join(outDir, "jsx-runtime.js")).href),
      interop: await import(pathToFileURL(join(outDir, "interop-test.js")).href),
    });
  }
  const [copyA, copyB, copyC] = copies.map((copy) => copy.api);
  const [jsxA] = copies.map((copy) => copy.jsx);
  const [interopA, interopB, interopC] = copies.map((copy) => copy.interop);
  assert.notEqual(copyA.signal, copyB.signal, "the package runtime modules must be distinct");
  assert.equal(copyA.isSignal(copyA.signal(1)), true, "a package recognizes its local signal");
  assert.equal(copyA.isSignal(copyB.signal(1)), true, "a package recognizes a foreign signal brand");
  assert.equal(copyA.isSignal(copyC.computed(() => 1)), true, "a package recognizes a foreign computed brand");

  // Separate bundled copies must restore a still-active managed parent scope
  // when a nested managed scope owned by another copy finishes.
  {
    const context = interopA.getSharedInteropContext();
    assert.equal(context, interopB.getSharedInteropContext());
    assert.equal(context, interopC.getSharedInteropContext());
    const readsA = [];
    const readsB = [];
    const collectorA = { add: (protocol, revision) => readsA.push([protocol, revision]) };
    const collectorB = { add: (protocol, revision) => readsB.push([protocol, revision]) };
    let activeA = true;
    let activeB = true;
    let restoreA;
    let restoreB;
    const scopeA = {
      token: {},
      managed: true,
      isActive: () => activeA,
      finish() {
        if (!activeA) return;
        activeA = false;
        restoreA();
      },
    };
    const scopeB = {
      token: {},
      managed: true,
      isActive: () => activeB,
      finish() {
        if (!activeB) return;
        activeB = false;
        restoreB();
      },
    };
    restoreA = interopA.pushInteropRenderScope(scopeA, collectorA);
    restoreB = interopB.pushInteropRenderScope(scopeB, collectorB);
    const readable = copyC.signal("cross-copy scope read");
    interopC.publishInteropRenderRead(readable[Symbol.for("react-fine-grained-signals.readable-interop.v1")], 0);
    assert.equal(readsA.length, 0);
    assert.equal(readsB.length, 1, "the innermost B collector owns reads while B is active");

    scopeB.finish();
    assert.equal(context.renderScope, scopeA, "finishing B restores the still-active A scope");
    assert.equal(context.renderCollector, collectorA);
    interopC.publishInteropRenderRead(readable[Symbol.for("react-fine-grained-signals.readable-interop.v1")], 0);
    assert.equal(readsA.length, 1, "reads return to A after B finishes");

    scopeA.finish();
    assert.equal(context.renderScope, undefined);
    assert.equal(context.renderCollector, undefined);
  }

  const brandedDeepSignal = copyB.deepSignal({ nested: { value: 1 } });
  assert.equal(copyA.isSignal(brandedDeepSignal), true, "a package recognizes a foreign public deep signal");
  assert.equal(copyA.isSignal(brandedDeepSignal.value), false, "deep state remains unbranded data");

  {
    const source = copyB.signal(1);
    const doubled = copyA.computed(() => source.value * 2);
    assert.equal(doubled.value, 2);
    source.value = 2;
    assert.equal(doubled.value, 4);
  }

  {
    const source = copyC.signal(2);
    const middle = copyB.computed(() => source.value * 3);
    const outer = copyA.computed(() => middle.value + 1);
    assert.equal(outer.value, 7);
    source.value = 4;
    assert.equal(outer.value, 13);
  }

  {
    const shouldThrow = copyB.signal(true);
    const foreign = copyB.computed(() => {
      if (shouldThrow.value) throw new Error("foreign computed failure");
      return 42;
    });
    const local = copyA.computed(() => foreign.value + 1);
    assert.throws(() => local.value, /foreign computed failure/);
    shouldThrow.value = false;
    assert.equal(local.value, 43, "foreign computed errors recover after a later write");
  }

  {
    const source = copyB.signal(1);
    const seen = [];
    const dispose = copyA.effect(() => {
      seen.push(source.value);
    });
    source.value = 2;
    assert.deepEqual(seen, [1, 2]);
    dispose();
  }

  {
    const source = copyA.signal(1);
    const seen = [];
    const dispose = copyB.effect(() => {
      seen.push(source.value);
    });
    source.value = 2;
    assert.deepEqual(seen, [1, 2], "foreign graph dependencies update in the opposite copy direction");
    dispose();
  }

  {
    const chooseLeft = copyA.signal(true);
    const left = copyB.signal("left");
    const right = copyB.signal("right");
    const seen = [];
    const dispose = copyA.effect(() => {
      seen.push(chooseLeft.value ? left.value : right.value);
    });

    left.value = "left updated";
    chooseLeft.value = false;
    left.value = "ignored after switch";
    right.value = "right updated";
    assert.deepEqual(seen, ["left", "left updated", "right", "right updated"]);
    dispose();
  }

  {
    const source = copyB.signal(0);
    const seen = [];
    const dispose = copyA.effect(() => {
      seen.push(source.value);
    });
    source.value = -0;
    source.value = Number.NaN;
    source.value = Number.NaN;
    assert.equal(seen.length, 3);
    assert.equal(Object.is(seen[0], 0), true);
    assert.equal(Object.is(seen[1], -0), true);
    assert.equal(Number.isNaN(seen[2]), true);
    dispose();
  }

  {
    const state = copyB.deepSignal({ profile: { name: "Ada", age: 36 }, active: false });
    const showName = copyA.signal(true);
    const seen = [];
    const dispose = copyA.effect(() => {
      seen.push(showName.value ? state.value.profile.name : state.value.active);
    });
    state.value.profile.age = 37;
    assert.deepEqual(seen, ["Ada"], "unread sibling properties stay isolated");
    state.value.profile.name = "Grace";
    assert.deepEqual(seen, ["Ada", "Grace"]);
    showName.value = false;
    state.value.profile.name = "Katherine";
    state.value.active = true;
    assert.deepEqual(seen, ["Ada", "Grace", false, true]);
    dispose();
    state.value.active = false;
    assert.deepEqual(seen, ["Ada", "Grace", false, true], "disposing releases foreign deep subscriptions");
  }

  {
    const state = copyB.deepSignal({ profile: { name: "Ada", age: 36 } });
    const name = copyA.computed(() => state.value.profile.name);
    assert.equal(name.value, "Ada");
    state.value.profile.age = 37;
    assert.equal(name.value, "Ada");
    state.value.profile.name = "Grace";
    assert.equal(name.value, "Grace");
  }

  // Cross-copy batches are local; they do not promise one global atomic flush.
  {
    const fromA = copyA.signal(0);
    const fromB = copyB.signal(0);
    const seen = [];
    const dispose = copyA.effect(() => {
      seen.push(fromA.value + fromB.value);
    });
    copyA.batch(() => {
      fromA.value = 1;
      fromB.value = 1;
    });
    assert.deepEqual(seen, [0, 2], "copies keep independent batch schedulers");
    console.log(`Observed cross-copy batch effect values: ${JSON.stringify(seen)}`);
    dispose();
  }

  // The package copies use the same React dependency installed at the repo
  // root. Set up jsdom before loading React DOM / Testing Library.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });

  const React = await import("react");
  const { act, cleanup, render, screen } = await import("@testing-library/react");
  try {
    const source = copyB.signal("before");
    function Reader() {
      return React.createElement(
        "output",
        { "aria-label": "cross-copy value" },
        copyA.useSignalValue(source),
      );
    }

    render(React.createElement(Reader));
    assert.equal(screen.getByLabelText("cross-copy value").textContent, "before");
    await act(async () => {
      source.value = "after";
    });
    assert.equal(screen.getByLabelText("cross-copy value").textContent, "after");

    const computedInput = copyB.signal("computed before");
    const foreignComputedLeaf = copyB.computed(() => computedInput.value.toUpperCase());
    function ComputedLeafReader() {
      return React.createElement(
        "output",
        { "aria-label": "cross-copy computed leaf" },
        copyA.useSignalValue(foreignComputedLeaf),
      );
    }
    render(React.createElement(ComputedLeafReader));
    assert.equal(screen.getByLabelText("cross-copy computed leaf").textContent, "COMPUTED BEFORE");
    await act(async () => {
      computedInput.value = "computed after";
    });
    assert.equal(screen.getByLabelText("cross-copy computed leaf").textContent, "COMPUTED AFTER");

    const foreignTitle = copyB.signal("foreign title before");
    render(jsxA.jsx("input", { "aria-label": "cross-copy jsx binding", title: foreignTitle }));
    assert.equal(screen.getByLabelText("cross-copy jsx binding").title, "foreign title before");
    await act(async () => {
      foreignTitle.value = "foreign title after";
    });
    assert.equal(screen.getByLabelText("cross-copy jsx binding").title, "foreign title after");

    const state = copyB.deepSignal({ profile: { name: "Ada" } });
    function DeepReader() {
      copyA.useSignalTracking();
      return React.createElement(
        "output",
        { "aria-label": "cross-copy deep value" },
        state.value.profile.name,
      );
    }

    render(React.createElement(DeepReader));
    assert.equal(screen.getByLabelText("cross-copy deep value").textContent, "Ada");
    await act(async () => {
      state.value.profile.name = "Grace";
    });
    assert.equal(screen.getByLabelText("cross-copy deep value").textContent, "Grace");

    const trackedState = copyB.deepSignal({ profile: { name: "Ada", age: 36 } });
    const deepRenders = [];
    function DeepTrackedReader() {
      copyA.useSignalTracking();
      deepRenders.push(1);
      return React.createElement(
        "output",
        { "aria-label": "tracked cross-copy deep value" },
        trackedState.value.profile.name,
      );
    }

    const deepView = render(React.createElement(DeepTrackedReader));
    assert.equal(screen.getByLabelText("tracked cross-copy deep value").textContent, "Ada");
    const deepRenderCount = deepRenders.length;
    await act(async () => {
      trackedState.value.profile.age = 37;
    });
    assert.equal(deepRenders.length, deepRenderCount, "unread deep sibling does not rerender");
    await act(async () => {
      trackedState.value.profile.name = "Grace";
    });
    assert.equal(screen.getByLabelText("tracked cross-copy deep value").textContent, "Grace");
    assert.equal(deepRenders.length, deepRenderCount + 1);

    const previousRoot = trackedState.value;
    await act(async () => {
      trackedState.value = { profile: { name: "Lin", age: 20 } };
    });
    assert.equal(screen.getByLabelText("tracked cross-copy deep value").textContent, "Lin");
    assert.equal(deepRenders.length, deepRenderCount + 2, "root replacement notifies the public cross-copy reader");
    await act(async () => deepView.unmount());
    await act(async () => {
      previousRoot.profile.name = "stale";
      trackedState.value.profile.name = "after unmount";
    });
    assert.equal(deepRenders.length, deepRenderCount + 2, "unmount releases the public cross-copy deep subscription");

    const managedOuterBefore = copyA.signal("A before");
    const managedInner = copyB.signal("B inner");
    const managedOuterAfter = copyA.signal("A after");
    const managedCrossCopyRenders = [];
    let managedOuterStore;
    let managedInnerStore;
    function NestedManagedReader() {
      const outerScope = copies[0].runtime.useManagedSignals();
      managedOuterStore = outerScope;
      try {
        const before = managedOuterBefore.value;
        const innerScope = copies[1].runtime.useManagedSignals();
        managedInnerStore = innerScope;
        let inner;
        try {
          inner = managedInner.value;
        } finally {
          innerScope.finish();
        }
        const after = managedOuterAfter.value;
        managedCrossCopyRenders.push(1);
        return React.createElement(
          "output",
          { "aria-label": "nested cross-copy managed" },
          `${before}/${inner}/${after}`,
        );
      } finally {
        outerScope.finish();
      }
    }

    render(React.createElement(NestedManagedReader));
    assert.equal(screen.getByLabelText("nested cross-copy managed").textContent, "A before/B inner/A after");
    const outerVersionBeforeInnerWrite = managedOuterStore.getSnapshot();
    const innerVersionBeforeInnerWrite = managedInnerStore.getSnapshot();
    await act(async () => {
      managedInner.value = "B updated";
    });
    assert.equal(screen.getByLabelText("nested cross-copy managed").textContent, "A before/B updated/A after");
    assert.equal(managedCrossCopyRenders.length, 2, "copy B's managed scope subscribes its foreign readable");
    assert.equal(managedOuterStore.getSnapshot(), outerVersionBeforeInnerWrite, "copy A does not own copy B's inner readable");
    assert.equal(managedInnerStore.getSnapshot(), innerVersionBeforeInnerWrite + 1);
    const outerVersionBeforeRestoredRead = managedOuterStore.getSnapshot();
    const innerVersionBeforeRestoredRead = managedInnerStore.getSnapshot();
    await act(async () => {
      managedOuterAfter.value = "A after updated";
    });
    assert.equal(screen.getByLabelText("nested cross-copy managed").textContent, "A before/B updated/A after updated");
    assert.equal(managedCrossCopyRenders.length, 3, "copy A's collector is restored after copy B finishes");
    assert.equal(managedOuterStore.getSnapshot(), outerVersionBeforeRestoredRead + 1);
    assert.equal(managedInnerStore.getSnapshot(), innerVersionBeforeRestoredRead, "copy B no longer owns reads after its scope finishes");

    const aSignalInsideB = copyA.signal("A inside B before");
    const cSignalInsideB = copyC.signal("C inside B before");
    let aStoreForNestedRead;
    let bStoreForNestedRead;
    function NestedForeignOwnerReader() {
      const outerScope = copies[0].runtime.useManagedSignals();
      aStoreForNestedRead = outerScope;
      try {
        const innerScope = copies[1].runtime.useManagedSignals();
        bStoreForNestedRead = innerScope;
        let value;
        try {
          value = `${aSignalInsideB.value}/${cSignalInsideB.value}`;
        } finally {
          innerScope.finish();
        }
        return React.createElement("output", { "aria-label": "A readable inside B scope" }, value);
      } finally {
        outerScope.finish();
      }
    }

    render(React.createElement(NestedForeignOwnerReader));
    assert.equal(screen.getByLabelText("A readable inside B scope").textContent, "A inside B before/C inside B before");
    const aStoreVersionBefore = aStoreForNestedRead.getSnapshot();
    const bStoreVersionBefore = bStoreForNestedRead.getSnapshot();
    await act(async () => {
      aSignalInsideB.value = "A inside B after";
    });
    assert.equal(screen.getByLabelText("A readable inside B scope").textContent, "A inside B after/C inside B before");
    assert.equal(aStoreForNestedRead.getSnapshot(), aStoreVersionBefore, "the outer A store does not own a read inside B's lexical scope");
    assert.equal(bStoreForNestedRead.getSnapshot(), bStoreVersionBefore + 1, "the inner B store owns A's readable inside B's lexical scope");
    const aVersionBeforeCWrite = aStoreForNestedRead.getSnapshot();
    const bVersionBeforeCWrite = bStoreForNestedRead.getSnapshot();
    await act(async () => {
      cSignalInsideB.value = "C inside B after";
    });
    assert.equal(screen.getByLabelText("A readable inside B scope").textContent, "A inside B after/C inside B after");
    assert.equal(aStoreForNestedRead.getSnapshot(), aVersionBeforeCWrite, "the outer A store does not own copy C's read inside B");
    assert.equal(bStoreForNestedRead.getSnapshot(), bVersionBeforeCWrite + 1, "the lexical B scope owns copy C's readable too");

    const computedSourceA = copyA.signal(1);
    const computedA = copyA.computed(() => computedSourceA.value % 2);
    let computedAStore;
    let computedBStore;
    function NestedComputedOwnerReader() {
      const outerScope = copies[0].runtime.useManagedSignals();
      computedAStore = outerScope;
      try {
        const innerScope = copies[1].runtime.useManagedSignals();
        computedBStore = innerScope;
        let value;
        try {
          value = computedA.value;
        } finally {
          innerScope.finish();
        }
        return React.createElement("output", { "aria-label": "A computed inside B scope" }, value);
      } finally {
        outerScope.finish();
      }
    }

    render(React.createElement(NestedComputedOwnerReader));
    assert.equal(screen.getByLabelText("A computed inside B scope").textContent, "1");
    const computedAVersionBeforeEqualWrite = computedAStore.getSnapshot();
    const computedBVersionBeforeEqualWrite = computedBStore.getSnapshot();
    await act(async () => {
      computedSourceA.value = 3;
    });
    assert.equal(computedAStore.getSnapshot(), computedAVersionBeforeEqualWrite, "computed internal source reads do not leak to A's outer store");
    assert.equal(computedBStore.getSnapshot(), computedBVersionBeforeEqualWrite, "B subscribes to the computed boundary and keeps Object.is equality suppression");
    await act(async () => {
      computedSourceA.value = 4;
    });
    assert.equal(screen.getByLabelText("A computed inside B scope").textContent, "0");
    assert.equal(computedAStore.getSnapshot(), computedAVersionBeforeEqualWrite);
    assert.equal(computedBStore.getSnapshot(), computedBVersionBeforeEqualWrite + 1, "the B store owns the A computed boundary");

    const deepStateA = copyA.deepSignal({ user: { name: "Ada", age: 36 } });
    let deepAStore;
    let deepBStore;
    function NestedDeepOwnerReader() {
      const outerScope = copies[0].runtime.useManagedSignals();
      deepAStore = outerScope;
      try {
        const innerScope = copies[1].runtime.useManagedSignals();
        deepBStore = innerScope;
        let name;
        try {
          name = deepStateA.value.user.name;
        } finally {
          innerScope.finish();
        }
        return React.createElement("output", { "aria-label": "A deep leaf inside B scope" }, name);
      } finally {
        outerScope.finish();
      }
    }

    render(React.createElement(NestedDeepOwnerReader));
    assert.equal(screen.getByLabelText("A deep leaf inside B scope").textContent, "Ada");
    const deepAVersionBeforeSiblingWrite = deepAStore.getSnapshot();
    const deepBVersionBeforeSiblingWrite = deepBStore.getSnapshot();
    await act(async () => {
      deepStateA.value.user.age = 37;
    });
    assert.equal(deepAStore.getSnapshot(), deepAVersionBeforeSiblingWrite);
    assert.equal(deepBStore.getSnapshot(), deepBVersionBeforeSiblingWrite, "unread sibling deep properties stay isolated");
    await act(async () => {
      deepStateA.value.user.name = "Grace";
    });
    assert.equal(screen.getByLabelText("A deep leaf inside B scope").textContent, "Grace");
    assert.equal(deepAStore.getSnapshot(), deepAVersionBeforeSiblingWrite);
    assert.equal(deepBStore.getSnapshot(), deepBVersionBeforeSiblingWrite + 1, "the B store owns the A deep-property dependency");

    const computedSource = copyB.signal("before");
    const foreignComputed = copyB.computed(() => computedSource.value.toUpperCase());
    function ComputedReader() {
      copyA.useSignalTracking();
      return React.createElement(
        "output",
        { "aria-label": "tracked cross-copy computed" },
        foreignComputed.value,
      );
    }

    render(React.createElement(ComputedReader));
    assert.equal(screen.getByLabelText("tracked cross-copy computed").textContent, "BEFORE");
    await act(async () => {
      computedSource.value = "after";
    });
    assert.equal(screen.getByLabelText("tracked cross-copy computed").textContent, "AFTER");

    const speculativeState = copyB.deepSignal({ user: { name: "Ada" } });
    const effectValues = [];
    let disposeEffect;
    let effectRuns = 0;
    let outerEvaluations = 0;
    const outer = copyA.computed(() => {
      outerEvaluations += 1;
      if (disposeEffect === undefined) {
        disposeEffect = copyB.effect(() => {
          effectRuns += 1;
          effectValues.push(speculativeState.value.user.name);
        });
      }
      return "outer-ready";
    });
    const speculativeRenders = [];
    function SpeculativeReader() {
      copyA.useSignalTracking();
      speculativeRenders.push(1);
      return React.createElement(
        "output",
        { "aria-label": "cross-copy speculative deep effect" },
        outer.value,
      );
    }

    const sharedInteropContext = interopA.getSharedInteropContext();
    const speculativeDepth = sharedInteropContext.speculativeDepth;
    const speculativeEpoch = sharedInteropContext.speculativeDeepReadEpoch;
    render(React.createElement(SpeculativeReader));
    assert.equal(screen.getByLabelText("cross-copy speculative deep effect").textContent, "outer-ready");
    assert.deepEqual(effectValues, ["Ada"], "the B effect performs its initial durable read during A's speculative getter");
    assert.equal(effectRuns, 1);
    assert.equal(outerEvaluations, 1);
    const speculativeRenderCount = speculativeRenders.length;
    assert.equal(
      sharedInteropContext.speculativeDeepReadEpoch,
      speculativeEpoch,
      "the durable B effect's deep read does not advance A's speculative deep-read epoch",
    );
    assert.equal(sharedInteropContext.speculativeDepth, speculativeDepth, "A's speculative scope is restored after render");

    await act(async () => {
      speculativeState.value.user.name = "Grace";
    });
    assert.deepEqual(effectValues, ["Ada", "Grace"], "the B effect retains its durable fine-grained deep dependency");
    assert.equal(outerEvaluations, 1, "the B deep dependency does not leak into A's speculative computed");
    assert.equal(speculativeRenders.length, speculativeRenderCount, "the B deep dependency does not rerender A's component");
    assert.equal(sharedInteropContext.speculativeDeepReadEpoch, speculativeEpoch);
    assert.equal(sharedInteropContext.speculativeDepth, speculativeDepth);

    disposeEffect();
    await act(async () => {
      speculativeState.value.user.name = "Lin";
    });
    assert.deepEqual(effectValues, ["Ada", "Grace"], "disposing B's effect releases its deep dependency");
    assert.equal(outerEvaluations, 1);
    assert.equal(speculativeRenders.length, speculativeRenderCount);
    assert.equal(sharedInteropContext.speculativeDepth, speculativeDepth);
  } finally {
    cleanup();
    dom.window.close();
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("Genuine duplicate-package runtime smoke passed.");
