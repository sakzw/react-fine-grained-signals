/** @jsxImportSource react-fine-grained-signals */
// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAlienDerivedRenderAdapter } from "../src/core/render-runtime.mjs";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { computed, effect, signal, useSignalTracking } from "../src/index.js";

// Regression coverage for the v0.2.0 core runtime release audit (A1-A6) and
// its follow-up checks. Each `createReactiveRuntime()` instance owns its own
// graph.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

function createRenderRuntime() {
  const runtime = createReactiveRuntime();
  runtime.initializeRenderAdapter(createAlienDerivedRenderAdapter);
  return runtime;
}

type Runtime = ReturnType<typeof createReactiveRuntime>;
type Attempt = ReturnType<Runtime["renderAdapter"]["createRenderAttempt"]>;

function renderAttempt<T>(runtime: Runtime, read: () => T, scopePolicy: "managed" | "bare" = "managed") {
  const attempt = runtime.renderAdapter.createRenderAttempt();
  let value!: T;
  runtime.renderAdapter.withRenderScope(attempt, () => { value = read(); }, scopePolicy);
  return { attempt, value };
}

const subscriptions: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
});

/**
 * Commits an attempt as RenderStore.commit does -- promote, subscribe to its
 * local dependencies, settle -- and reports whether it must re-render.
 */
function commitNeedsRerender(runtime: Runtime, attempt: Attempt): boolean {
  let changed = !runtime.renderAdapter.promoteRenderAttempt(attempt);
  const local = [...attempt.dependencies.keys()].filter((dependency) => runtime.getNodeForReadable(dependency as never) !== undefined);
  if (local.length > 0) subscriptions.push(runtime.renderAdapter.subscribeReadables(local, () => {}));
  if (!runtime.renderAdapter.settleRenderAttempt(attempt)) changed = true;
  return changed;
}

describe("A2: render attempts that observed different values of one computed", () => {
  it("re-renders the earlier attempt when a later attempt promoted first", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);
    expect([parent.value, child.value]).toEqual([10, 20]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
    expect(scaled.value).toBe(20);
  });

  it("re-renders the earlier attempt when it commits first", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);

    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
  });

  it("re-renders the earlier attempt over a computed that was warm before both", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);
    expect(scaled.value).toBe(10);
    source.value = 5;

    const parent = renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => scaled.value);
    expect([parent.value, child.value]).toEqual([50, 20]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
  });

  it("keeps both attempts stable when they observed equal values", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);

    const parent = renderAttempt(runtime, () => parity.value);
    source.value = 3;
    const child = renderAttempt(runtime, () => parity.value);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(false);
  });

  it("re-renders an attempt that saw a value once another promoted an error", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const checked = runtime.computed(() => {
      if (source.value > 1) throw new Error("too large");
      return source.value;
    });

    const parent = renderAttempt(runtime, () => checked.value);
    source.value = 2;
    const child = renderAttempt(runtime, () => { try { return checked.value; } catch { return "error"; } });
    expect([parent.value, child.value]).toEqual([1, "error"]);

    expect(commitNeedsRerender(runtime, child.attempt)).toBe(false);
    expect(commitNeedsRerender(runtime, parent.attempt)).toBe(true);
  });

  it("is unaffected by an aborted attempt that never commits", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const scaled = runtime.computed(() => source.value * 10);

    renderAttempt(runtime, () => scaled.value);
    source.value = 2;
    const committed = renderAttempt(runtime, () => scaled.value);
    expect(commitNeedsRerender(runtime, committed.attempt)).toBe(false);
    source.value = 3;
    expect(scaled.value).toBe(30);
  });
});

describe("A4: computed getters are called as () => T", () => {
  it("passes no arguments and no this on the graph path", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    const calls: Array<{ self: unknown; count: number }> = [];
    const value = runtime.computed(function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, count: args.length });
      return source.value;
    });

    value.value;
    source.value = 1;
    value.value;
    source.value = 2;
    value.value;
    expect(calls).toEqual([
      { self: undefined, count: 0 },
      { self: undefined, count: 0 },
      { self: undefined, count: 0 },
    ]);
  });

  it("applies a default parameter on every recomputation", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    function total(offset = 100) { return source.value + offset; }
    const value = runtime.computed(total);

    const seen = [value.value];
    for (const next of [1, 2, 3]) {
      source.value = next;
      seen.push(value.value);
    }
    expect(seen).toEqual([100, 101, 102, 103]);
  });

  it("passes no arguments and no this on a speculative render's first read", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(1);
    const calls: Array<{ self: unknown; count: number }> = [];
    function total(this: unknown, offset = 100) {
      calls.push({ self: this, count: arguments.length });
      return source.value + offset;
    }
    const value = runtime.computed(total);

    const first = renderAttempt(runtime, () => value.value);
    expect(first.value).toBe(101);
    expect(commitNeedsRerender(runtime, first.attempt)).toBe(false);
    source.value = 2;
    const second = renderAttempt(runtime, () => value.value);
    expect(second.value).toBe(102);
    expect(calls.every(({ self, count }) => self === undefined && count === 0)).toBe(true);
  });

  it("matches v0.1.1 in a tracked component's first render", () => {
    const source = signal(1);
    function total(offset = 100) { return source.value + offset; }
    const value = computed(total);
    function View() {
      useSignalTracking();
      return <p>{value.value}</p>;
    }

    const view = render(<View />);
    expect(view.container.textContent).toBe("101");
    act(() => { source.value = 2; });
    expect(view.container.textContent).toBe("102");
    act(() => { source.value = 3; });
    expect(view.container.textContent).toBe("103");
  });
});

describe("follow-up: effects created by a speculatively evaluated getter", () => {
  it("disposes them when the attempt is aborted", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    const tick = runtime.signal(0);
    let live = 0;
    const owner = runtime.computed(() => {
      runtime.effect(() => { void tick.value; live += 1; return () => { live -= 1; }; });
      return source.value;
    });

    renderAttempt(runtime, () => owner.value);
    expect(live).toBe(0);
    tick.value = 1;
    expect(live).toBe(0);
  });

  it("leaves exactly one owned child once the computed is committed", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    const tick = runtime.signal(0);
    let live = 0;
    let runs = 0;
    const owner = runtime.computed(() => {
      runtime.effect(() => { void tick.value; runs += 1; live += 1; return () => { live -= 1; }; });
      return source.value;
    });

    const { attempt } = renderAttempt(runtime, () => owner.value);
    commitNeedsRerender(runtime, attempt);
    const stop = runtime.effect(() => { void owner.value; });
    expect(live).toBe(1);
    const before = runs;
    tick.value = 1;
    expect(runs).toBe(before + 1);
    source.value = 1;
    expect(live).toBe(1);
    stop();
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    expect(live).toBe(0);
  });

  it("leaves no child alive after a tracked component unmounts", async () => {
    const source = signal(0);
    const tick = signal(0);
    let live = 0;
    const owner = computed(() => {
      effect(() => { void tick.value; live += 1; return () => { live -= 1; }; });
      return source.value;
    });
    function View() {
      useSignalTracking();
      return <p>{owner.value}</p>;
    }

    const view = render(<View />);
    expect(live).toBe(1);
    for (const next of [1, 2, 3]) act(() => { source.value = next; });
    expect(live).toBe(1);
    view.unmount();
    await Promise.resolve();
    expect(live).toBe(0);
  });
});

