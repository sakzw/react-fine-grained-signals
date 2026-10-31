import { describe, expect, it, vi } from "vitest";
import { createAlienDerivedRenderAdapter } from "../src/core/render-runtime.mjs";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { computed, deepSignal, effect, signal } from "../src/index.js";
import { subscribeLocalReadable } from "../src/core/readable-subscription.js";

function createRenderRuntime() {
  const runtime = createReactiveRuntime();
  runtime.initializeRenderAdapter(createAlienDerivedRenderAdapter);
  return runtime;
}

// Core runtime regressions that do not involve a second copy of the package.
// They came from the v0.2.0 release review and were part of a test file that
// v0.4 removed together with its cross-copy cases.
describe("effect lifecycle", () => {
  it("does not stay subscribed to reads made after disposing itself mid-run", () => {
    const runtime = createRenderRuntime();
    const ready = runtime.signal(false);
    const other = runtime.signal(0);
    let runs = 0;
    let stop: (() => void) | undefined;
    stop = runtime.effect(() => {
      runs += 1;
      if (ready.value) {
        stop?.();
        void other.value;
      }
    });
    ready.value = true;
    expect(runs).toBe(2);
    expect(runtime.hasSubscribers(other)).toBe(false);
    expect(runtime.hasSubscribers(ready)).toBe(false);
    other.value = 1;
    ready.value = false;
    expect(runs).toBe(2);
  });

  it("reports an indirect computed cycle instead of returning a stale value", () => {
    const runtime = createRenderRuntime();
    const input = runtime.signal(1);
    let second: { readonly value: number } | undefined;
    const first = runtime.computed((): number => input.value + (second?.value ?? 0));
    second = runtime.computed(() => first.value + 1);
    expect(() => first.value).toThrow("Computed cycle detected");
    expect(() => second.value).toThrow("Computed cycle detected");
  });

  it("keeps library-internal subscriptions alive when they are created inside a user effect", () => {
    const runtime = createRenderRuntime();
    const outer = runtime.signal(0);
    const watched = runtime.signal(0);
    const notify = vi.fn();
    let unsubscribe: (() => void) | undefined;
    const stop = runtime.effect(() => {
      void outer.value;
      // Render stores and DOM bindings are created from React commits, which
      // can run synchronously inside a user effect (flushSync).
      unsubscribe ??= runtime.renderAdapter.subscribeReadables([watched], notify);
    });
    outer.value = 1;
    watched.value = 1;
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
    watched.value = 2;
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });
});

describe("local readable subscription", () => {
  it("keeps a subscription created inside a user effect when that effect re-runs", () => {
    const outer = signal(0);
    const watched = signal(0);
    const notify = vi.fn();
    let unsubscribe: (() => void) | undefined;
    const stop = effect(() => {
      void outer.value;
      unsubscribe ??= subscribeLocalReadable(watched, notify);
    });
    outer.value = 1;
    watched.value = 1;
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
    watched.value = 2;
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe?.();
    watched.value = 3;
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("notifies across success, error, a different error and recovery without letting writes throw", () => {
    const source = signal(1);
    const firstError = new Error("computed failure");
    const secondError = new Error("different computed failure");
    const value = computed(() => {
      if (source.value === 2) throw firstError;
      if (source.value === 3) throw secondError;
      return source.value;
    });
    const notify = vi.fn();
    const unsubscribe = subscribeLocalReadable(value, notify);

    expect(() => {
      source.value = 2;
    }).not.toThrow();
    expect(() => value.value).toThrow(firstError);
    expect(() => {
      source.value = 3;
    }).not.toThrow();
    expect(() => value.value).toThrow(secondError);
    expect(() => {
      source.value = 4;
    }).not.toThrow();
    expect(value.value).toBe(4);
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
    source.value = 5;
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("supports many independent listeners and releases each subscription", () => {
    const source = signal(0);
    const listeners = Array.from({ length: 64 }, () => vi.fn());
    const unsubscribes = listeners.map((listener) => subscribeLocalReadable(source, listener));
    source.value = 1;
    expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true);
    for (const unsubscribe of unsubscribes) unsubscribe();
    source.value = 2;
    expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true);
  });

  it("follows a computed's dynamically selected branch", () => {
    const chooseLeft = signal(true);
    const left = signal("left");
    const right = signal("right");
    const selected = computed(() => (chooseLeft.value ? left.value : right.value));
    const notify = vi.fn();
    const unsubscribe = subscribeLocalReadable(selected, notify);

    left.value = "left updated";
    chooseLeft.value = false;
    left.value = "ignored";
    right.value = "right updated";
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("throws for a readable this package did not create", () => {
    const structural = { value: 1, peek: () => 1 };
    expect(() => subscribeLocalReadable(structural, vi.fn())).toThrow(TypeError);
  });

  it("subscribes a deep signal root through its internal source", () => {
    const state = deepSignal({ count: 1 });
    const notify = vi.fn();
    const unsubscribe = subscribeLocalReadable(state, notify);
    state.value.count = 2;
    expect(notify).not.toHaveBeenCalled();
    state.value = { count: 3 };
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
