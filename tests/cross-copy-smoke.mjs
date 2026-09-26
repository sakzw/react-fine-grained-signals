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
      entry: { index: join(repositoryRoot, "src/index.ts") },
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
    copies.push(await import(pathToFileURL(join(outDir, "index.js")).href));
  }
  const [copyA, copyB, copyC] = copies;
  assert.notEqual(copyA.signal, copyB.signal, "the package runtime modules must be distinct");

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

    render(React.createElement(DeepTrackedReader));
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
  } finally {
    cleanup();
    dom.window.close();
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("Genuine duplicate-package runtime smoke passed.");
