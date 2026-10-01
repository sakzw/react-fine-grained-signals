import { describe, expect, it } from "vitest";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import type { ReadableInteropV1 } from "../src/core/interop.js";
import { batch, deepSignal, effect, signal } from "../src/index.js";

// Regression coverage for the post-M3 v0.2.0 release review.

describe("effect creation with a self-invalidating first run", () => {
  it("runs a top-level effect that writes its own dependency once", () => {
    const count = signal(0);
    let runs = 0;
    const dispose = effect(() => {
      runs += 1;
      if (count.value < 3) count.value += 1;
    });

    expect(runs).toBe(1);
    expect(count.value).toBe(1);
    dispose();
  });

  it("runs the same effect once when it is created inside batch()", () => {
    const count = signal(0);
    let runs = 0;
    let dispose!: () => void;
    batch(() => {
      dispose = effect(() => {
        runs += 1;
        if (count.value < 3) count.value += 1;
      });
    });

    expect(runs).toBe(1);
    expect(count.value).toBe(1);
    dispose();
  });

  it("re-runs exactly once for a later external write", () => {
    const count = signal(0);
    let runs = 0;
    const dispose = effect(() => {
      runs += 1;
      if (count.value < 3) count.value += 1;
    });

    // A value the first run did not see; its own write to 3 is not a re-run.
    count.value = 2;
    expect(runs).toBe(2);
    expect(count.value).toBe(3);
    dispose();
  });

  it("keeps cleanup semantics: none on creation, one per re-run, one on dispose", () => {
    const count = signal(0);
    const events: string[] = [];
    const dispose = effect(() => {
      const seen = count.value;
      events.push(`run:${seen}`);
      if (seen === 0) count.value = 1;
      return () => events.push(`cleanup:${seen}`);
    });

    expect(events).toEqual(["run:0"]);
    count.value = 5;
    expect(events).toEqual(["run:0", "cleanup:0", "run:5"]);
    dispose();
    expect(events).toEqual(["run:0", "cleanup:0", "run:5", "cleanup:5"]);
  });

  it("keeps nested effect ownership: one live child per owner run", () => {
    const count = signal(0);
    const trigger = signal(0);
    let childRuns = 0;
    let childCleanups = 0;
    const dispose = effect(() => {
      trigger.value;
      if (count.value === 0) count.value = 1;
      effect(() => {
        childRuns += 1;
        count.value;
        return () => { childCleanups += 1; };
      });
    });

    expect(childRuns).toBe(1);
    expect(childCleanups).toBe(0);

    trigger.value = 1;
    expect(childRuns).toBe(2);
    expect(childCleanups).toBe(1);

    // Only the second child is still subscribed.
    count.value = 2;
    expect(childRuns).toBe(3);
    expect(childCleanups).toBe(2);

    dispose();
    expect(childCleanups).toBe(3);
    count.value = 3;
    expect(childRuns).toBe(3);
  });

  it("treats a write its first run caused through another effect as its own", () => {
    // v0.1.1 and Alien 3.2.1: the second effect's write flushes the first,
    // whose write lands on a dependency the second effect already read.
    const a = signal(0);
    const b = signal(0);
    const seen: number[] = [];
    const stopDouble = effect(() => { b.value = a.value * 2; });
    const stop = effect(() => {
      seen.push(b.value);
      if (a.value === 0) a.value = 5;
    });

    expect(seen).toEqual([0]);
    a.value = 6;
    expect(seen).toEqual([0, 12]);
    stop();
    stopDouble();
  });

  it("still retries when a foreign subscription reports a newer revision during the first run", () => {
    const runtime = createReactiveRuntime();
    const local = runtime.signal(0);
    let notify: ((revision: number) => void) | undefined;
    const protocol: ReadableInteropV1 = {
      version: 1,
      runtimeToken: {},
      getRevision: () => 1,
      subscribe(listener) {
        notify = listener;
        return { unsubscribe: () => {}, revision: 1 };
      },
    };
    let runs = 0;
    const dispose = runtime.effect(() => {
      runs += 1;
      // A self-write and a stale foreign dependency in the same first run:
      // the foreign staleness must not be dropped with the self-write.
      if (local.value === 0) local.value = 1;
      if (runs === 1) runtime.graphOwner.add(protocol, 0);
    });

    expect(runs).toBe(2);
    expect(notify).toBeDefined();
    dispose();
  });
});

describe("deepSignal array identity lookups", () => {
  it("finds a raw object with includes, indexOf and lastIndexOf", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const state = deepSignal({ items: [a, b, a] });
    const items = state.value.items;

    expect(items.includes(a)).toBe(true);
    expect(items.includes(b)).toBe(true);
    expect(items.indexOf(a)).toBe(0);
    expect(items.indexOf(b)).toBe(1);
    expect(items.lastIndexOf(a)).toBe(2);
    expect(items.lastIndexOf(b)).toBe(1);
    expect(items.includes({ id: 1 })).toBe(false);
    expect(items.indexOf({ id: 1 })).toBe(-1);
    expect(items.lastIndexOf({ id: 1 })).toBe(-1);
  });

  it("finds a root array's raw element and an element pushed later", () => {
    const a = {};
    const c = {};
    const state = deepSignal([a]);
    expect(state.value.indexOf(a)).toBe(0);
    expect(state.value.includes(a)).toBe(true);

    state.value.push(c);
    expect(state.value.includes(c)).toBe(true);
    expect(state.value.indexOf(c)).toBe(1);
  });

  it("still finds the proxy an element reads as", () => {
    const state = deepSignal({ items: [{ id: 1 }, { id: 2 }] });
    const items = state.value.items;
    const second = items[1]!;

    expect(items.includes(second)).toBe(true);
    expect(items.indexOf(second)).toBe(1);
    expect(items.lastIndexOf(second)).toBe(1);
  });

  it("keeps native semantics for primitives", () => {
    const state = deepSignal({ items: [1, Number.NaN, "x", 1, undefined] });
    const items = state.value.items;

    expect(items.indexOf(1)).toBe(0);
    expect(items.lastIndexOf(1)).toBe(3);
    expect(items.includes(Number.NaN)).toBe(true);
    expect(items.indexOf(Number.NaN)).toBe(-1);
    expect(items.includes("x")).toBe(true);
    expect(items.includes(undefined)).toBe(true);
    expect(items.indexOf(2)).toBe(-1);
  });

  it("honours positive and negative fromIndex with raw objects", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const state = deepSignal({ items: [a, b, a, b] });
    const items = state.value.items;

    expect(items.indexOf(a, 1)).toBe(2);
    expect(items.indexOf(a, 3)).toBe(-1);
    expect(items.indexOf(b, -2)).toBe(3);
    expect(items.indexOf(a, -1)).toBe(-1);
    expect(items.lastIndexOf(a, 1)).toBe(0);
    expect(items.lastIndexOf(b, -2)).toBe(1);
    expect(items.lastIndexOf(b, -4)).toBe(-1);
    expect(items.includes(a, 3)).toBe(false);
    expect(items.includes(b, -1)).toBe(true);
    expect(items.includes(a, -2)).toBe(true);
  });

  it("removes the right element with splice(indexOf(raw), 1)", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const state = deepSignal({ items: [a, b] });
    const items = state.value.items;

    items.splice(items.indexOf(a), 1);
    expect(state.peek().items).toEqual([{ id: 2 }]);
    expect(state.peek().items[0]).toBe(b);
  });

  it("keeps a lookup tracked and unbatched", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const state = deepSignal({ items: [b] });
    const seen: boolean[] = [];
    const dispose = effect(() => {
      seen.push(state.value.items.includes(a));
    });
    expect(seen).toEqual([false]);

    state.value.items.push(a);
    expect(seen).toEqual([false, true]);
    state.value.items[1] = { id: 3 };
    expect(seen).toEqual([false, true, false]);
    state.value.items[0] = a;
    expect(seen).toEqual([false, true, false, true]);
    dispose();

    // A lookup is a read: it must not hold back a write made around it.
    const count = signal(0);
    const counts: number[] = [];
    const stop = effect(() => { counts.push(count.value); });
    state.value.items.indexOf(a);
    count.value = 1;
    expect(counts).toEqual([0, 1]);
    stop();
  });
});
