/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { StrictMode, Suspense, act, useInsertionEffect, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveRenderCollector } from "../../src/core/render-tracking.js";
import { useManagedSignals, useSignalTracking } from "../../src/react/use-signals.js";
import { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Prototype A React render layer", () => {
  it("tracks dynamic source reads and ignores unrelated sources", () => {
    const runtime = createLeanRuntime(() => undefined);
    const chooseLeft = runtime.signal(true);
    const left = runtime.signal("left");
    const right = runtime.signal("right");
    const unrelated = runtime.signal(0);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="selected">{chooseLeft.value ? left.value : right.value}</output>;
    }
    render(<Reader />);
    act(() => { unrelated.value = 1; });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { left.value = "left-2"; });
    expect(screen.getByLabelText("selected").textContent).toBe("left-2");
    act(() => { chooseLeft.value = false; });
    expect(screen.getByLabelText("selected").textContent).toBe("right");
    const afterSwitch = renders.mock.calls.length;
    act(() => { left.value = "stale"; });
    expect(renders).toHaveBeenCalledTimes(afterSwitch);
    act(() => { right.value = "right-2"; });
    expect(screen.getByLabelText("selected").textContent).toBe("right-2");
  });

  it("preserves the first-observed revision and catches a render-time change-and-revert", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal("A");
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      const value = source.value;
      if (renders.mock.calls.length === 1) runtime.batch(() => { source.value = "B"; source.value = "A"; });
      return <output aria-label="reverted">{value}</output>;
    }
    render(<Reader />);
    expect(screen.getByLabelText("reverted").textContent).toBe("A");
    expect(source.getRenderVersion()).toBe(2);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("does not rerender a mounted source consumer for a semantic batch revert", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal("A");
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="semantic-revert">{source.value}</output>;
    }
    render(<Reader />);
    act(() => runtime.batch(() => { source.value = "B"; source.value = "A"; }));
    expect(source.getRenderVersion()).toBe(2);
    expect(screen.getByLabelText("semantic-revert").textContent).toBe("A");
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("subscribes before comparing versions when an insertion effect writes before layout commit", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      const value = source.value;
      useInsertionEffect(() => { if (value === 0) source.value = 1; }, [value]);
      return <output aria-label="commit-race">{value}</output>;
    }
    render(<Reader />);
    expect(screen.getByLabelText("commit-race").textContent).toBe("1");
    expect(renders.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates sibling and StrictMode render subscriptions", () => {
    const runtime = createLeanRuntime(() => undefined);
    const first = runtime.signal(0);
    const second = runtime.signal(10);
    const firstRenders = vi.fn();
    function First() {
      useSignalTracking();
      firstRenders();
      return <output aria-label="first">{first.value}</output>;
    }
    function Second() {
      useSignalTracking();
      return <output aria-label="second">{second.value}</output>;
    }
    const view = render(<StrictMode><><First /><Second /></></StrictMode>);
    const initialFirst = firstRenders.mock.calls.length;
    act(() => { second.value = 11; });
    expect(screen.getByLabelText("second").textContent).toBe("11");
    expect(firstRenders).toHaveBeenCalledTimes(initialFirst);
    act(() => { first.value = 1; });
    expect(screen.getByLabelText("first").textContent).toBe("1");
    view.unmount();
    const afterUnmount = firstRenders.mock.calls.length;
    act(() => { first.value = 2; });
    expect(firstRenders).toHaveBeenCalledTimes(afterUnmount);
  });

  it("tracks computed boundaries and suppresses equal computed results", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="parity">{parity.value}</output>;
    }
    render(<Reader />);
    act(() => { source.value = 3; });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { source.value = 4; });
    expect(screen.getByLabelText("parity").textContent).toBe("0");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("keeps nested speculative computed boundaries and reuses the promoted outer cache", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const outer = runtime.computed(() => ({ parity: parity.value, values: [parity.value] }));
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      const result = outer.value;
      return <output aria-label="nested-computed">{result.parity}:{result.values[0]}</output>;
    }
    render(<Reader />);
    act(() => { source.value = 3; });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { source.value = 4; });
    expect(screen.getByLabelText("nested-computed").textContent).toBe("0:0");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it.each(["unmanaged", "managed"] as const)("reuses identity-unstable speculative computed results in %s scopes", (scope) => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal([1, 2]);
    const derived = runtime.computed(() => source.value.map((value) => value * 2));
    const unrelated = runtime.signal(0);
    const renders = vi.fn();
    function readValues() {
      renders();
      const values = derived.value.join(",");
      unrelated.value;
      return values;
    }
    function ManagedReader() {
      const store = useManagedSignals();
      try { return <output aria-label={"derived-" + scope}>{readValues()}</output>; }
      finally { store.finish(); }
    }
    function UnmanagedReader() {
      useSignalTracking();
      return <output aria-label={"derived-" + scope}>{readValues()}</output>;
    }
    const Reader = scope === "managed" ? ManagedReader : UnmanagedReader;
    render(<Reader />);
    expect(screen.getByLabelText("derived-" + scope).textContent).toBe("2,4");
    act(() => { unrelated.value = 1; });
    expect(renders).toHaveBeenCalledTimes(2);
    act(() => { source.value = [3, 4]; });
    expect(screen.getByLabelText("derived-" + scope).textContent).toBe("6,8");
    expect(renders.mock.calls.length).toBeLessThan(5);
  });

  it("suppresses untracked and peek reads during a component render", () => {
    const runtime = createLeanRuntime(() => undefined);
    const tracked = runtime.signal(1);
    const ignored = runtime.signal(10);
    const derived = runtime.computed(() => ignored.value * 2);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="untracked">{tracked.value + runtime.untracked(() => ignored.value) + derived.peek()}</output>;
    }
    render(<Reader />);
    act(() => { ignored.value = 11; });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { tracked.value = 2; });
    expect(screen.getByLabelText("untracked").textContent).toBe("35");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("keeps untracked sources out of speculative computed dependencies", () => {
    const runtime = createLeanRuntime(() => undefined);
    const tracked = runtime.signal(1);
    const ignored = runtime.signal(10);
    const evaluate = vi.fn(() => tracked.value + runtime.untracked(() => ignored.value));
    const derived = runtime.computed(evaluate);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="spec-untracked">{derived.value}</output>;
    }
    render(<Reader />);
    expect(screen.getByLabelText("spec-untracked").textContent).toBe("11");
    expect(evaluate).toHaveBeenCalledTimes(1);
    act(() => { ignored.value = 20; });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { tracked.value = 2; });
    expect(screen.getByLabelText("spec-untracked").textContent).toBe("22");
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("does not collect a nested computed evaluated only through peek", () => {
    const runtime = createLeanRuntime(() => undefined);
    const nestedSource = runtime.signal(1);
    const nested = runtime.computed(() => nestedSource.value * 2);
    const evaluateOuter = vi.fn(() => nested.peek() + 1);
    const outer = runtime.computed(evaluateOuter);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="peek-boundary">{outer.value}</output>;
    }
    render(<Reader />);
    expect(screen.getByLabelText("peek-boundary").textContent).toBe("3");
    act(() => { nestedSource.value = 2; });
    expect(evaluateOuter).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("isolates effects and cleanups triggered during speculative computed evaluation", () => {
    const runtime = createLeanRuntime(() => undefined);
    const trigger = runtime.signal(0);
    const effectOnly = runtime.signal(0);
    const cleanupOnly = runtime.signal(0);
    let effectRuns = 0;
    let cleanupRuns = 0;
    runtime.effect(() => {
      trigger.value;
      effectOnly.value;
      effectRuns += 1;
      return () => { cleanupOnly.value; cleanupRuns += 1; };
    });
    let shouldTrigger = true;
    const evaluate = vi.fn(() => {
      if (shouldTrigger) {
        shouldTrigger = false;
        trigger.value = 1;
      }
      return 7;
    });
    const outer = runtime.computed(evaluate);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="effect-spec-isolation">{outer.value}</output>;
    }
    render(<Reader />);
    expect(effectRuns).toBe(2);
    expect(cleanupRuns).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    act(() => { effectOnly.value = 1; });
    expect(effectRuns).toBe(3);
    expect(cleanupRuns).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { cleanupOnly.value = 1; });
    expect(effectRuns).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("restores nested untracked collectors after a caught throw inside a speculative getter", () => {
    const runtime = createLeanRuntime(() => undefined);
    const tracked = runtime.signal(1);
    const ignored = runtime.signal(10);
    const failure = new Error("nested untracked failure");
    let caught: unknown;
    const derived = runtime.computed(() => {
      try {
        runtime.untracked(() => runtime.untracked(() => {
          ignored.value;
          throw failure;
        }));
      } catch (error) {
        caught = error;
      }
      return tracked.value;
    });
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="nested-untracked">{derived.value}</output>;
    }
    render(<Reader />);
    expect(caught).toBe(failure);
    expect(hasActiveRenderCollector()).toBe(false);
    act(() => { ignored.value = 11; });
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => { tracked.value = 2; });
    expect(screen.getByLabelText("nested-untracked").textContent).toBe("2");
    expect(renders).toHaveBeenCalledTimes(2);
    expect(hasActiveRenderCollector()).toBe(false);
  });

  it("isolates RenderWatcher listeners from active speculative computed reads", () => {
    const runtime = createLeanRuntime(() => undefined);
    const trigger = runtime.signal(0);
    const listenerOnly = runtime.signal(0);
    const unsubscribe = trigger.subscribeRender(() => { listenerOnly.value; });
    let shouldTrigger = true;
    const evaluate = vi.fn(() => {
      if (shouldTrigger) {
        shouldTrigger = false;
        trigger.value = 1;
      }
      return 3;
    });
    const outer = runtime.computed(evaluate);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output aria-label="watcher-spec-isolation">{outer.value}</output>;
    }
    render(<Reader />);
    act(() => { listenerOnly.value = 1; });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not leak ordinary effect reads into an open render scope", () => {
    const runtime = createLeanRuntime(() => undefined);
    const trigger = runtime.signal(0);
    const effectOnly = runtime.signal(0);
    const displayed = runtime.signal(0);
    runtime.effect(() => { trigger.value; effectOnly.value; });
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      if (renders.mock.calls.length === 1) trigger.value = 1;
      return <output aria-label="effect-isolation">{displayed.value}</output>;
    }
    render(<Reader />);
    const afterMount = renders.mock.calls.length;
    act(() => { effectOnly.value = 1; });
    expect(renders).toHaveBeenCalledTimes(afterMount);
  });

  it("keeps independent roots subscribed and releases each root on unmount", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return <output>{source.value}</output>;
    }
    const firstRoot = render(<Reader />);
    const secondRoot = render(<Reader />);
    const mountedRenders = renders.mock.calls.length;
    act(() => { source.value = 1; });
    expect(renders.mock.calls.length).toBe(mountedRenders + 2);
    firstRoot.unmount();
    secondRoot.unmount();
    const unmountedRenders = renders.mock.calls.length;
    act(() => { source.value = 2; });
    expect(renders).toHaveBeenCalledTimes(unmountedRenders);
  });

  it("releases the graph-native watcher and computed dependency links after unmount", async () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const evaluate = vi.fn(() => source.value * 2);
    const derived = runtime.computed(evaluate);
    function Reader() {
      useSignalTracking();
      return <output>{derived.value}</output>;
    }
    const view = render(<Reader />);
    expect(evaluate).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    act(() => { source.value = 2; });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(derived.value).toBe(4);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("closes managed scopes on success and throw", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const failure = new Error("render failure");
    function Successful() {
      const store = useManagedSignals();
      const value = source.value;
      store.finish();
      expect(hasActiveRenderCollector()).toBe(false);
      return <output aria-label="managed">{value}</output>;
    }
    render(<Successful />);
    expect(screen.getByLabelText("managed").textContent).toBe("1");
    function Throwing(): ReactNode {
      const store = useManagedSignals();
      try { source.value; throw failure; } finally { store.finish(); }
    }
    expect(() => render(<Throwing />)).toThrow(failure);
    expect(hasActiveRenderCollector()).toBe(false);
  });

  it("abandons managed Suspense reads and renders the newest value after retry", async () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const doubled = runtime.computed(() => source.value * 2);
    let resolve!: () => void;
    const wait = new Promise<void>((done) => { resolve = done; });
    let ready = false;
    function Reader() {
      const store = useManagedSignals();
      try {
        const value = doubled.value;
        if (!ready) throw wait;
        return <output aria-label="suspense">{value}</output>;
      } finally { store.finish(); }
    }
    render(<Suspense fallback={<span>waiting</span>}><Reader /></Suspense>);
    expect(screen.getByText("waiting")).toBeTruthy();
    expect(hasActiveRenderCollector()).toBe(false);
    act(() => { source.value = 2; });
    ready = true;
    await act(async () => { resolve(); await wait; });
    expect(screen.getByLabelText("suspense").textContent).toBe("4");
  });

  it("surfaces speculative computed errors and recovers without retaining abandoned links", () => {
    const runtime = createLeanRuntime(() => undefined);
    const fail = runtime.signal(true);
    const failure = new Error("speculative computed failure");
    const derived = runtime.computed(() => {
      if (fail.value) throw failure;
      return "recovered";
    });
    const subscribe = vi.spyOn(derived, "subscribeRender");
    function Reader(): ReactNode {
      const store = useManagedSignals();
      try { return <output>{derived.value}</output>; }
      finally { store.finish(); }
    }
    expect(() => render(<Reader />)).toThrow(failure);
    expect(subscribe).not.toHaveBeenCalled();
    expect(hasActiveRenderCollector()).toBe(false);
    act(() => { fail.value = false; });
    render(<Reader />);
    expect(screen.getByText("recovered")).toBeTruthy();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps managed subscriptions through StrictMode replay and releases them on unmount", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const renders = vi.fn();
    function Reader() {
      const store = useManagedSignals();
      try {
        renders();
        return <output aria-label="managed-strict">{source.value}</output>;
      } finally { store.finish(); }
    }
    const view = render(<StrictMode><Reader /></StrictMode>);
    act(() => { source.value = 1; });
    expect(screen.getByLabelText("managed-strict").textContent).toBe("1");
    view.unmount();
    const afterUnmount = renders.mock.calls.length;
    act(() => { source.value = 2; });
    expect(renders).toHaveBeenCalledTimes(afterUnmount);
  });

  it("closes abandoned unmanaged scopes through the microtask fallback", async () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const wait = new Promise<void>(() => {});
    function Reader(): ReactNode {
      useSignalTracking();
      source.value;
      throw wait;
    }
    render(<Suspense fallback={<span>unmanaged waiting</span>}><Reader /></Suspense>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("unmanaged waiting")).toBeTruthy();
    expect(hasActiveRenderCollector()).toBe(false);
  });

  it("renders on the server without committing subscriptions", async () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal("ssr");
    const derived = runtime.computed(() => source.value.toUpperCase());
    const subscribe = vi.spyOn(derived, "subscribeRender");
    function Reader() {
      useSignalTracking();
      return <output>{derived.value}</output>;
    }
    const { renderToString } = await import("react-dom/server");
    expect(renderToString(<Reader />)).toContain("SSR");
    await Promise.resolve();
    expect(subscribe).not.toHaveBeenCalled();
    expect(hasActiveRenderCollector()).toBe(false);
  });
});
