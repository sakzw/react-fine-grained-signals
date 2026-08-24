import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, computed, effect, isSignal, signal, untracked } from "../src/index.js";

// Spelled out rather than imported: the literal string is the cross-instance
// wire format, so a second copy of the package can only agree by matching it.
const SIGNAL_BRAND = Symbol.for("react-alien-signals.signal");

/** Produces what a signal from a second copy of this package looks like here. */
function brandForeign<T extends object>(value: T, version: unknown = 1): T {
  Object.defineProperty(value, SIGNAL_BRAND, {
    value: version,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

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
    expect(isSignal(() => 1)).toBe(false);
    expect(isSignal([signal(1)])).toBe(false);
    expect(isSignal(new Proxy({ value: 1, peek: () => 1 }, {}))).toBe(false);
  });

  it("identifies a signal branded by a second package instance", () => {
    expect(isSignal(brandForeign({ value: 1, peek: () => 1 }))).toBe(true);
    // A later protocol version only widens the `{ value, peek() }` contract,
    // so an older instance keeps trusting it.
    expect(isSignal(brandForeign({ value: 1, peek: () => 1 }, 2))).toBe(true);
  });

  it("rejects a brand that claims no supported protocol version", () => {
    expect(isSignal(brandForeign({ value: 1, peek: () => 1 }, true))).toBe(false);
    expect(isSignal(brandForeign({ value: 1, peek: () => 1 }, "1"))).toBe(false);
    expect(isSignal(brandForeign({ value: 1, peek: () => 1 }, 0))).toBe(false);
    // A brand is a claim: without the contract behind it the value is rejected
    // here instead of crashing later inside a render.
    expect(isSignal(brandForeign({ value: 1 }))).toBe(false);
  });

  it("keeps the brand off every enumerable surface", () => {
    const count = signal(1);
    const doubled = computed(() => count.value * 2);

    expect(Object.keys(count)).toEqual([]);
    expect(Object.keys(doubled)).toEqual(["value", "peek"]);
    expect(JSON.stringify({ count, doubled })).toBe('{"count":{},"doubled":{"value":2}}');
    expect(Object.getOwnPropertySymbols({ ...count })).toEqual([]);
    expect(Object.getOwnPropertySymbols({ ...doubled })).toEqual([]);
    expect(isSignal({ ...doubled })).toBe(false);
  });

  it("keeps the brand fixed once a signal is public", () => {
    const count = signal(1);
    const brandHolder = count as unknown as Record<symbol, unknown>;

    expect(Object.getOwnPropertyDescriptor(count, SIGNAL_BRAND)).toEqual({
      value: 1,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(() => {
      brandHolder[SIGNAL_BRAND] = 99;
    }).toThrow(TypeError);
    expect(() => {
      delete brandHolder[SIGNAL_BRAND];
    }).toThrow(TypeError);
    expect(isSignal(count)).toBe(true);
  });
});

describe("computed error propagation", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("surfaces the getter's own error, unchanged, from both .value and .peek()", () => {
    const failure = new Error("getter failed");
    const broken = computed(() => {
      throw failure;
    });

    expect(() => broken.value).toThrow(failure);
    expect(() => broken.peek()).toThrow(failure);

    // `.toThrow(error)` only compares messages; capture the thrown value
    // outside the catch so the identity check isn't a conditional `expect`.
    let thrownFromValue: unknown;
    try {
      broken.value;
    } catch (error) {
      thrownFromValue = error;
    }
    expect(thrownFromValue).toBe(failure);
  });

  it("recovers once the dependency changes to a value the getter accepts, instead of staying wedged", () => {
    // alien-signals@3.2.1's updateComputed resets a computed's dirty/pending
    // flags in a `finally` regardless of outcome, so an escaping getter
    // exception used to leave the node looking clean on its stale value, and
    // could permanently unwatch an effect whose run was interrupted mid-flush
    // (confirmed directly against alien-signals: neither ever recovered on a
    // later write). The watcher below guards its own read so this test
    // exercises exactly that internal re-evaluation path.
    const source = signal(1);
    const flaky = computed(() => {
      if (source.value === 2) throw new Error("boom");
      return source.value * 10;
    });
    const results: Array<number | "error"> = [];
    disposers.push(effect(() => {
      try {
        results.push(flaky.value);
      } catch {
        results.push("error");
      }
    }));
    expect(results).toEqual([10]);

    source.value = 2;
    expect(results).toEqual([10, "error"]);

    // The regression: a later write to a value the getter accepts must still
    // reach the getter, not return the stale pre-throw value forever.
    source.value = 3;
    expect(results).toEqual([10, "error", 30]);

    source.value = 4;
    expect(results).toEqual([10, "error", 30, 40]);
  });

  it("does not throw synchronously at the write site; the error only surfaces on a subsequent read", () => {
    const source = signal(1);
    const flaky = computed(() => {
      if (source.value === 2) throw new Error("boom");
      return source.value;
    });
    // Guarding the read inside the watcher isolates the write-site behavior:
    // any throw that still escapes here would have to come from alien-signals'
    // own dirty-checking (run before the effect body executes), not from this
    // unguarded call, because this call IS guarded.
    disposers.push(effect(() => {
      try {
        flaky.value;
      } catch {
        // Ignored on purpose: this test only cares whether the write throws.
      }
    }));

    expect(() => {
      source.value = 2;
    }).not.toThrow();
    expect(() => flaky.value).toThrow("boom");

    expect(() => {
      batch(() => {
        source.value = 3;
      });
    }).not.toThrow();
    expect(flaky.value).toBe(3);
  });

  it("does not stall an unrelated effect queued in the same batch/flush", () => {
    // Pre-fix, alien-signals' flush() has a `finally` but no `catch`: once one
    // queued effect's dirty-check throws, every effect still queued behind it
    // in that flush is skipped, not merely deferred — and empirically (verified
    // directly against alien-signals) it never runs again on its own, even from
    // later, unrelated writes. Reproduced here through the public API: `a` is
    // written before `b`, so the erroring watcher is queued ahead of the
    // healthy one in the shared flush.
    const a = signal(1);
    const b = signal(100);
    const erroring = computed(() => {
      if (a.value === 2) throw new Error("boom");
      return a.value;
    });
    const healthySeen: number[] = [];
    disposers.push(effect(() => {
      try {
        erroring.value;
      } catch {
        // Ignored on purpose: only `healthySeen` is under test here.
      }
    }));
    disposers.push(effect(() => {
      healthySeen.push(b.value * 2);
    }));
    expect(healthySeen).toEqual([200]);

    expect(() => {
      batch(() => {
        a.value = 2;
        b.value = 200;
      });
    }).not.toThrow();
    expect(healthySeen).toEqual([200, 400]);

    // Confirm it keeps reacting afterward too, not just this one time.
    b.value = 300;
    expect(healthySeen).toEqual([200, 400, 600]);
  });
});
