import { afterEach, describe, expect, it, vi } from "vitest";
import { batch, computed, effect, isSignal, signal, untracked } from "../src/index.js";
import {
  setActiveRenderCollector,
  type RenderDependency,
} from "../src/core/render-tracking.js";

/**
 * Stands in for what a `useSignals()` component's `RenderStore` does: installs
 * a render collector, performs the reads, and hands back the dependencies the
 * signals registered — the same handles React later subscribes to.
 */
function collectRenderDependencies(read: () => void): RenderDependency[] {
  const dependencies: RenderDependency[] = [];
  const previous = setActiveRenderCollector({
    add: (dependency) => dependencies.push(dependency),
  });
  try {
    read();
  } finally {
    setActiveRenderCollector(previous);
  }
  return dependencies;
}

// Spelled out rather than imported: the literal string is the cross-instance
// wire format, so a second copy of the package can only agree by matching it.
const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");

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
    // Tests below spy on `console.error`/`queueMicrotask` to observe how a
    // thrown callback is reported; leaving those installed would leak both the
    // stubbed behavior and the call history into the next test.
    vi.restoreAllMocks();
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

  it("contains a throwing effect() body instead of corrupting the flush", () => {
    // The effect body is queued first, so pre-fix its throw escaped `flush()`
    // (whose `finally` marks the rest of the queue as skipped rather than
    // running it) and propagated out of the write that triggered it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rethrows: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      rethrows.push(callback);
    });

    const trigger = signal(0);
    const other = signal(0);
    const healthySeen: number[] = [];

    disposers.push(effect(() => {
      if (trigger.value === 1) throw new Error("effect boom");
    }));
    disposers.push(effect(() => {
      healthySeen.push(other.value);
    }));
    expect(healthySeen).toEqual([0]);

    expect(() => {
      batch(() => {
        trigger.value = 1;
        other.value = 1;
      });
    }).not.toThrow();
    // The effect queued behind the failing one still ran in that same flush.
    expect(healthySeen).toEqual([0, 1]);

    // Reported once, in the codebase's `console.error(message, { cause })`
    // shape, and rethrown from a microtask so it still reaches a global
    // handler without being able to corrupt the flush it came from.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0]?.[1] as { cause: unknown } | undefined;
    expect(reported?.cause).toBeInstanceOf(Error);
    expect(rethrows).toHaveLength(1);
    expect(() => rethrows[0]?.()).toThrow("effect boom");

    // The graph keeps working for later, unrelated writes.
    other.value = 2;
    expect(healthySeen).toEqual([0, 1, 2]);
    trigger.value = 2;
    other.value = 3;
    expect(healthySeen).toEqual([0, 1, 2, 3]);
  });

  it("notifies render subscribers when an effect cleanup throws during a write", () => {
    // An effect *cleanup* runs inside alien-signals' `run()`, before that
    // effect's body re-runs and inside `flush()`'s `try`. `effect()` now wraps
    // the cleanup it hands back to alien-signals, so the throw is reported the
    // same way a throwing body is instead of escaping the write.
    //
    // The `finally` in `set value` is the invariant this test exists for and
    // still guards every other way the flush can exit: `#currentValue` is
    // committed before the flush, so a missed `#renderSubscription.notify()`
    // would park every React-side subscriber on the old value forever.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rethrows: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      rethrows.push(callback);
    });

    const source = signal(0);
    const notifications: number[] = [];
    const [dependency] = collectRenderDependencies(() => {
      source.value;
    });
    disposers.push(dependency!.subscribeRender(() => {
      notifications.push(source.peek());
    }));

    disposers.push(effect(() => {
      source.value;
      return () => {
        throw new Error("cleanup boom");
      };
    }));

    expect(() => {
      source.value = 1;
    }).not.toThrow();
    expect(source.value).toBe(1);

    // Same treatment as a throwing body: reported once as
    // `console.error(message, { cause })`, then rethrown from a microtask so a
    // global handler still sees it, from outside the flush it came from.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0]?.[1] as { cause: unknown } | undefined;
    expect(reported?.cause).toBeInstanceOf(Error);
    expect(rethrows).toHaveLength(1);
    expect(() => rethrows[0]?.()).toThrow("cleanup boom");

    // The React-side notification happened anyway, so a `useSignals()`
    // component subscribed to this signal still re-renders.
    expect(notifications).toEqual([1]);
  });

  it("keeps the rest of a flush running when an effect cleanup throws", () => {
    // The queue-cancelling failure mode, reached through the cleanup rather
    // than the body: the cleanup of the first-queued effect runs before its
    // own body does, so pre-fix its throw aborted `flush()` even earlier than
    // a throwing body would.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rethrows: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      rethrows.push(callback);
    });

    const trigger = signal(0);
    const other = signal(0);
    const healthySeen: number[] = [];

    disposers.push(effect(() => {
      trigger.value;
      return () => {
        throw new Error("cleanup boom");
      };
    }));
    disposers.push(effect(() => {
      healthySeen.push(other.value);
    }));
    expect(healthySeen).toEqual([0]);

    expect(() => {
      batch(() => {
        trigger.value = 1;
        other.value = 1;
      });
    }).not.toThrow();
    // The effect queued behind the one whose cleanup threw still ran.
    expect(healthySeen).toEqual([0, 1]);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0]?.[1] as { cause: unknown } | undefined;
    expect(reported?.cause).toBeInstanceOf(Error);
    expect(rethrows).toHaveLength(1);
    expect(() => rethrows[0]?.()).toThrow("cleanup boom");

    // The failing effect re-registered a fresh (also throwing) cleanup, and
    // the graph keeps serving later writes.
    other.value = 2;
    expect(healthySeen).toEqual([0, 1, 2]);
    trigger.value = 2;
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("contains a throwing effect() cleanup on disposal", () => {
    // Disposal is a different alien-signals code path from the re-run above:
    // `effectOper()` calls the stored cleanup after tearing the node's links
    // down, with no `flush()` wrapped around it, so pre-fix the throw came
    // straight back out of the disposer — out of the `useEffect` teardown
    // behind `useSignalEffect`, or out of any caller's own `dispose()`.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rethrows: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      rethrows.push(callback);
    });

    const source = signal(0);
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(source.value);
      return () => {
        throw new Error("dispose cleanup boom");
      };
    });
    expect(runs).toEqual([0]);

    expect(() => dispose()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0]?.[1] as { cause: unknown } | undefined;
    expect(reported?.cause).toBeInstanceOf(Error);
    expect(rethrows).toHaveLength(1);
    expect(() => rethrows[0]?.()).toThrow("dispose cleanup boom");

    // The throw did not leave a half-disposed effect behind: the teardown that
    // ran before the cleanup stands, so later writes never run it again.
    source.value = 1;
    expect(runs).toEqual([0]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps one throwing render listener from cancelling the others", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = signal(0);
    const [dependency] = collectRenderDependencies(() => {
      source.value;
    });
    const later: number[] = [];

    disposers.push(dependency!.subscribeRender(() => {
      throw new Error("listener boom");
    }));
    disposers.push(dependency!.subscribeRender(() => {
      later.push(source.peek());
    }));

    expect(() => {
      source.value = 1;
    }).not.toThrow();
    // Pre-fix the first listener's throw aborted the loop, so every listener
    // registered behind it silently missed this notify cycle.
    expect(later).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const reported = errorSpy.mock.calls[0]?.[1] as { cause: unknown } | undefined;
    expect(reported?.cause).toBeInstanceOf(Error);
  });
});
