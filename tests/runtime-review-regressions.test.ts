import { describe, expect, it, vi } from "vitest";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import { deepSignal, effect } from "../src/index.js";

// Regression coverage for the v0.2.0 release review. Two `createReactiveRuntime()`
// graphs stand in for two installed copies of the package: they share the
// global execution owner and talk through ReadableInterop V1, exactly as
// duplicated copies do (see tests/cross-copy-smoke.mjs for the packaged form).

describe("cross-copy computed refresh and activation", () => {
  it("subscribes to a foreign dependency first read during an effect's dirty check (C1)", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const flag = a.signal(false);
    const foreign = b.signal(0);
    const over = a.computed(() => (flag.value ? foreign.value > 100 : false));
    const seen: boolean[] = [];
    const stop = a.effect(() => {
      seen.push(over.value);
    });

    // Re-evaluated through the effect's dirty check; the result stays false,
    // so the effect body does not re-run, but the new foreign dependency must
    // still be watched.
    flag.value = true;
    expect(seen).toEqual([false]);
    foreign.value = 200;
    expect(seen).toEqual([false, true]);
    expect(over.value).toBe(true);
    stop();
  });

  it("works in the other direction too (C1)", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const flag = b.signal(false);
    const foreign = a.signal(0);
    const over = b.computed(() => (flag.value ? foreign.value > 100 : false));
    const seen: boolean[] = [];
    const stop = b.effect(() => {
      seen.push(over.value);
    });
    flag.value = true;
    foreign.value = 200;
    expect(seen).toEqual([false, true]);
    stop();
  });

  it("refreshes a foreign-dependent computed whose only subscriber is an unwatched computed (C2)", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const foreign = b.signal(1);
    const scaled = a.computed(() => foreign.value * 10);
    const plusOne = a.computed(() => scaled.value + 1);

    expect(plusOne.value).toBe(11);
    foreign.value = 2;
    // `scaled` has a subscriber (`plusOne`) but nothing watches either of
    // them, so its foreign bridge is inactive and has to be polled.
    expect(scaled.value).toBe(20);
    expect(plusOne.value).toBe(21);
    foreign.value = 3;
    expect(plusOne.value).toBe(31);
  });

  it("stops polling once an effect activates the bridge, and polls again after it goes", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const foreign = b.signal(1);
    const scaled = a.computed(() => foreign.value * 10);
    const seen: number[] = [];
    const stop = a.effect(() => {
      seen.push(scaled.value);
    });
    foreign.value = 2;
    expect(seen).toEqual([10, 20]);
    stop();
    foreign.value = 3;
    expect(scaled.value).toBe(30);
  });
});

describe("cross-copy untracked (C3)", () => {
  it("does not track a read under another copy's untracked()", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const appSignal = b.signal(0);
    let runs = 0;
    const stop = b.effect(() => {
      runs += 1;
      a.untracked(() => appSignal.value);
    });
    appSignal.value = 1;
    expect(runs).toBe(1);
    stop();
  });

  it("does not track in the reverse direction", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const appSignal = a.signal(0);
    let runs = 0;
    const stop = a.effect(() => {
      runs += 1;
      b.untracked(() => appSignal.value);
    });
    appSignal.value = 1;
    expect(runs).toBe(1);
    stop();
  });

  it("does not track a computed read under another copy's untracked()", () => {
    const a = createReactiveRuntime();
    const b = createReactiveRuntime();
    const source = b.signal(1);
    const doubled = b.computed(() => source.value * 2);
    let runs = 0;
    let last = 0;
    const stop = b.effect(() => {
      runs += 1;
      last = a.untracked(() => doubled.value);
    });
    source.value = 2;
    expect(runs).toBe(1);
    // The untracked read still returns the current value.
    expect(a.untracked(() => doubled.value)).toBe(4);
    expect(last).toBe(2);
    stop();
  });

  it("does not track deep-signal reads under another copy's untracked()", () => {
    const other = createReactiveRuntime();
    const state = deepSignal({ count: 0, items: [1] });
    let runs = 0;
    const stop = effect(() => {
      runs += 1;
      other.untracked(() => {
        void state.value.count;
        void state.value.items.length;
      });
    });
    state.value.count = 1;
    state.value.items.push(2);
    expect(runs).toBe(1);
    stop();
  });

  it("keeps ordinary local untracked() working", () => {
    const a = createReactiveRuntime();
    const source = a.signal(0);
    const tracked = a.signal(0);
    let runs = 0;
    const stop = a.effect(() => {
      runs += 1;
      void tracked.value;
      a.untracked(() => source.value);
    });
    source.value = 1;
    expect(runs).toBe(1);
    tracked.value = 1;
    expect(runs).toBe(2);
    stop();
  });
});

describe("effect lifecycle", () => {
  it("does not stay subscribed to reads made after disposing itself mid-run", () => {
    const runtime = createReactiveRuntime();
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
    const runtime = createReactiveRuntime();
    const input = runtime.signal(1);
    // eslint-disable-next-line prefer-const
    let second: { readonly value: number } | undefined;
    const first = runtime.computed((): number => input.value + (second?.value ?? 0));
    second = runtime.computed(() => first.value + 1);
    expect(() => first.value).toThrow("Computed cycle detected");
    expect(() => second.value).toThrow("Computed cycle detected");
  });

  it("keeps library-internal subscriptions alive when they are created inside a user effect", () => {
    const runtime = createReactiveRuntime();
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
