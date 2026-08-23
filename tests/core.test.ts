import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, computed, effect, isSignal, signal, untracked } from "../src/index.js";

describe("core signal primitives", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("uses Object.is when deciding whether a signal changed", () => {
    const value = signal<number>(0);
    const listener = vi.fn();
    disposers.push(effect(() => {
      value.value;
      listener();
    }));

    expect(listener).toHaveBeenCalledTimes(1);
    value.value = 0;
    expect(listener).toHaveBeenCalledTimes(1);
    value.value = -0;
    expect(listener).toHaveBeenCalledTimes(2);

    const nan = signal(Number.NaN);
    const nanListener = vi.fn();
    disposers.push(effect(() => {
      nan.value;
      nanListener();
    }));
    nan.value = Number.NaN;
    expect(nanListener).toHaveBeenCalledTimes(1);
  });

  it("preserves Object.is notification semantics through computed", () => {
    const source = signal(0);
    const derived = computed(() => source.value);
    const values: number[] = [];
    disposers.push(effect(() => {
      values.push(derived.value);
    }));

    source.value = -0;
    expect(values).toHaveLength(2);
    expect(Object.is(values[1], -0)).toBe(true);

    const nanSource = signal(Number.NaN);
    const nanDerived = computed(() => nanSource.value);
    const nanReads: number[] = [];
    disposers.push(effect(() => {
      nanReads.push(nanDerived.value);
    }));
    nanSource.value = Number.NaN;
    expect(nanReads).toHaveLength(1);
  });

  it("tracks computed values and switches dynamic dependencies", () => {
    const useFirst = signal(true);
    const first = signal("first");
    const second = signal("second");
    const selected = computed(() => (useFirst.value ? first.value : second.value));
    const values: string[] = [];

    disposers.push(effect(() => {
      values.push(selected.value);
    }));
    expect(values).toEqual(["first"]);

    first.value = "first-updated";
    expect(values).toEqual(["first", "first-updated"]);
    useFirst.value = false;
    expect(values).toEqual(["first", "first-updated", "second"]);
    first.value = "ignored-after-switch";
    expect(values).toEqual(["first", "first-updated", "second"]);
    second.value = "second-updated";
    expect(values).toEqual(["first", "first-updated", "second", "second-updated"]);
  });

  it("coalesces notifications made inside batch", () => {
    const left = signal(1);
    const right = signal(2);
    const total = computed(() => left.value + right.value);
    const values: number[] = [];

    disposers.push(effect(() => {
      values.push(total.value);
    }));
    expect(values).toEqual([3]);

    batch(() => {
      left.value = 10;
      right.value = 20;
    });
    expect(values).toEqual([3, 30]);
  });

  it("does not collect dependencies while executing untracked", () => {
    const source = signal("initial");
    const trigger = signal(0);
    const listener = vi.fn();

    disposers.push(effect(() => {
      trigger.value;
      untracked(() => source.value);
      listener();
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    source.value = "not-a-dependency";
    expect(listener).toHaveBeenCalledTimes(1);
    trigger.value++;
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("runs the current cleanup when an effect disposes itself", () => {
    const source = signal(0);
    const cleanups: number[] = [];
    let dispose: (() => void) | undefined;

    dispose = effect(() => {
      const value = source.value;
      if (value === 1) dispose?.();
      return () => {
        cleanups.push(value);
      };
    });

    source.value = 1;
    source.value = 2;

    expect(cleanups).toEqual([0, 1]);
  });

  it("runs the last cleanup and stops the effect when disposed from outside", () => {
    const source = signal(0);
    const listener = vi.fn();
    const cleanups: number[] = [];

    const dispose = effect(() => {
      const value = source.value;
      listener();
      return () => {
        cleanups.push(value);
      };
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(cleanups).toEqual([]);

    dispose();
    expect(cleanups).toEqual([0]);

    source.value = 1;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(cleanups).toEqual([0]);

    expect(() => dispose()).not.toThrow();
    expect(cleanups).toEqual([0]);
  });

  it("reads the current value via peek without establishing a dependency", () => {
    const source = signal(0);
    const listener = vi.fn();
    disposers.push(effect(() => {
      source.peek();
      listener();
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    source.value = 1;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.peek()).toBe(1);

    const base = signal(1);
    const doubled = computed(() => base.value * 2);
    const computedListener = vi.fn();
    disposers.push(effect(() => {
      doubled.peek();
      computedListener();
    }));
    expect(computedListener).toHaveBeenCalledTimes(1);
    base.value = 2;
    expect(computedListener).toHaveBeenCalledTimes(1);
    expect(doubled.peek()).toBe(4);
  });

  it("identifies values created by signal or computed and rejects everything else", () => {
    expect(isSignal(signal(1))).toBe(true);
    expect(isSignal(computed(() => 1))).toBe(true);
    expect(isSignal({ value: 1 })).toBe(false);
    expect(isSignal(null)).toBe(false);
    expect(isSignal(undefined)).toBe(false);
    expect(isSignal(42)).toBe(false);
    expect(isSignal("string")).toBe(false);
  });
});
