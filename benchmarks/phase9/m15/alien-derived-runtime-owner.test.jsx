/* oxlint-disable react/globals -- These test fixtures intentionally inspect mutable render/effect counters. */
import React, { Suspense } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as runtime from "./alien-derived-runtime-owner-candidate.mjs";

afterEach(() => cleanup());
const h = React.createElement;
const hooks = runtime.createReactAdapter();

describe("M1.5.1 compositional render adapter", () => {
  it("tracks useSignalValue and managed local dependencies", () => {
    const source = runtime.signalClassBrandHelper("before");
    function Reader() { return h("output", { "aria-label": "value" }, hooks.useSignalValue(source)); }
    render(h(Reader));
    act(() => { source.value = "after"; });
    expect(screen.getByLabelText("value").textContent).toBe("after");
  });

  it("promotes speculative computed dependencies only after commit", () => {
    const source = runtime.signalClassBrandHelper(2);
    const derived = runtime.computedClassBrandHelper(() => source.value * 3);
    function Reader() {
      const scope = hooks.useManagedSignals();
      return runtime.managed(scope, () => h("output", { "aria-label": "computed" }, derived.value));
    }
    render(h(Reader));
    act(() => { source.value = 4; });
    expect(screen.getByLabelText("computed").textContent).toBe("12");
  });

  it("does not promote or subscribe an abandoned suspended attempt", async () => {
    const source = runtime.signalClassBrandHelper(1);
    const derived = runtime.computedClassBrandHelper(() => source.value * 2);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let suspend = true;
    function Reader() {
      const scope = hooks.useManagedSignals();
      return runtime.managed(scope, () => {
        const value = derived.value;
        if (suspend) throw gate;
        return h("output", { "aria-label": "resolved" }, value);
      });
    }
    render(h(Suspense, { fallback: h("output", { "aria-label": "fallback" }, "pending") }, h(Reader)));
    expect(screen.getByLabelText("fallback").textContent).toBe("pending");
    await Promise.resolve();
    suspend = false;
    await act(async () => { release(); await gate; });
    expect(screen.getByLabelText("resolved").textContent).toBe("2");
    act(() => { source.value = 3; });
    expect(screen.getByLabelText("resolved").textContent).toBe("6");
  });

  it("keeps a nested graph owner from leaking reads into a render owner", () => {
    const nestedRead = runtime.signalClassBrandHelper("nested");
    const visible = runtime.signalClassBrandHelper("visible");
    let renders = 0;
    function Reader() {
      const scope = hooks.useManagedSignals();
      return runtime.managed(scope, () => {
        renders += 1;
        const dispose = runtime.effect(() => { nestedRead.value; });
        dispose();
        return h("output", { "aria-label": "visible" }, visible.value);
      });
    }
    render(h(Reader));
    const committed = renders;
    act(() => { nestedRead.value = "changed"; });
    expect(renders).toBe(committed);
  });

  it("lets an inner render owner override a surrounding graph owner", () => {
    const source = runtime.signalClassBrandHelper(1);
    let effectRuns = 0;
    const dispose = runtime.effect(() => {
      effectRuns += 1;
      const attempt = runtime.createRenderAttempt();
      runtime.withRenderScope(attempt, () => source.value);
    });
    act(() => { source.value = 2; });
    expect(effectRuns).toBe(1);
    dispose();
  });

  it("tracks foreign v0.2 signal/computed reads through independent module copies", async () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const copyRoot = await mkdtemp(join(sourceDir, ".owner-react-copies-"));
    const files = [
      "alien-derived-runtime-owner-core.mjs",
      "alien-derived-runtime-foreign-adapter.mjs",
      "alien-derived-runtime-execution-owner.mjs",
      "alien-derived-runtime-interop-context.mjs",
    ];
    try {
      await mkdir(join(copyRoot, "copy-b"));
      await Promise.all(files.map((file) => copyFile(join(sourceDir, file), join(copyRoot, "copy-b", file))));
      const foreign = await import(pathToFileURL(join(copyRoot, "copy-b", files[0])).href);
      const graphSource = foreign.signalClassBrandHelper(0);
      const source = foreign.signalClassBrandHelper("before");
      const derived = foreign.computedClassBrandHelper(() => source.value.toUpperCase());
      let renders = 0;
      let nestedEffectRuns = 0;
      function Reader() {
        const scope = hooks.useManagedSignals();
        const stopNestedEffect = React.useMemo(() => runtime.effect(() => {
          graphSource.value;
          nestedEffectRuns += 1;
        }), []);
        React.useEffect(() => () => stopNestedEffect(), [stopNestedEffect]);
        return runtime.managed(scope, () => {
          renders += 1;
          return h("output", { "aria-label": "foreign" }, derived.value);
        });
      }
      const view = render(h(Reader));
      expect(screen.getByLabelText("foreign").textContent).toBe("BEFORE");
      act(() => { source.value = "after"; });
      expect(screen.getByLabelText("foreign").textContent).toBe("AFTER");
      expect(renders).toBe(2);
      act(() => { graphSource.value = 1; });
      expect(nestedEffectRuns).toBe(2);
      expect(renders).toBe(2);
      view.unmount();
      act(() => { source.value = "disposed"; });
      graphSource.value = 2;
      expect(renders).toBe(2);
      expect(nestedEffectRuns).toBe(2);
    } finally {
      await rm(copyRoot, { recursive: true, force: true });
    }
  });
});
