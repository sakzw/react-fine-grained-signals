import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, computed, effect, signal, untracked } from "../src/index.js";

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
});
