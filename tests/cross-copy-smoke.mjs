import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(repositoryRoot, ".cross-copy-smoke-"));

try {
  const copyAPath = join(temporaryRoot, "copy-a");
  const copyBPath = join(temporaryRoot, "copy-b");
  await Promise.all([
    cp(join(repositoryRoot, "dist"), copyAPath, { recursive: true }),
    cp(join(repositoryRoot, "dist"), copyBPath, { recursive: true }),
  ]);

  const resolveFromA = createRequire(join(copyAPath, "index.js"));
  const resolveFromB = createRequire(join(copyBPath, "index.js"));
  assert.equal(
    resolveFromA.resolve("alien-signals"),
    resolveFromB.resolve("alien-signals"),
    "both built package copies must resolve the same alien-signals peer",
  );

  const [copyA, copyB] = await Promise.all([
    import(pathToFileURL(join(copyAPath, "index.js"))),
    import(pathToFileURL(join(copyBPath, "index.js"))),
  ]);
  assert.notEqual(copyA.signal, copyB.signal, "the package runtime modules must be distinct");

  {
    const source = copyB.signal(1);
    const doubled = copyA.computed(() => source.value * 2);
    assert.equal(doubled.value, 2);
    source.value = 2;
    assert.equal(doubled.value, 4);
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

  // Record the current behavior without turning shared-peer batch coordination
  // into a permanent contract for a future runtime architecture.
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
  } finally {
    cleanup();
    dom.window.close();
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("Genuine duplicate-package runtime smoke passed.");
