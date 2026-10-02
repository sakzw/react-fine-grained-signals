// A' core re-audit: a read made for another copy's graph or render owner must
// not link to this copy's own `activeSub`. In `B effect -> A computed -> B
// signal`, B's running effect is still B's `activeSub` while A's getter reads
// B's signal; linking it there gave the effect a direct dependency that skipped
// A's equality cutoff and child-effect ownership. Each `createReactiveRuntime()`
// is an independent Alien system sharing only the global execution owner, as
// separately bundled package copies do.
import { describe, expect, it } from "vitest";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";
import type { ReactiveRuntime } from "../src/core/reactive-runtime.js";

const READABLE_INTEROP_V1 = Symbol.for("react-fine-grained-signals.readable-interop.v1");

interface Protocol {
  subscribe(listener: (revision: number) => void): { unsubscribe(): void; revision: number };
}

/** Counts how often another copy's subscription notifies through a readable's protocol. */
function countListenerCalls(readable: object): { calls: number } {
  const protocol = Reflect.get(readable, READABLE_INTEROP_V1) as Protocol;
  const subscribe = protocol.subscribe;
  const counter = { calls: 0 };
  protocol.subscribe = function (listener) {
    return subscribe.call(this, (revision) => {
      counter.calls += 1;
      listener(revision);
    });
  };
  return counter;
}

const directions: Array<[string, () => [ReactiveRuntime, ReactiveRuntime]]> = [
  ["A over B", () => [createReactiveRuntime(), createReactiveRuntime()]],
  ["B over A", () => {
    const [a, b] = [createReactiveRuntime(), createReactiveRuntime()];
    return [b, a];
  }],
];

describe.each(directions)("cross-copy round-trip reads (%s)", (_name, make) => {
  it("keeps the equality cutoff of a foreign computed over this copy's source", () => {
    const [a, b] = make();
    const x = b.signal(1);
    const parity = a.computed(() => x.value % 2);
    let runs = 0;
    b.effect(() => {
      parity.value;
      runs += 1;
    });
    x.value = 3;
    x.value = 5;
    expect(runs).toBe(1);
    x.value = 6;
    expect(runs).toBe(2);
  });

  it("does not re-run on writes that leave a threshold computed unchanged", () => {
    const [a, b] = make();
    const items = [b.signal(0), b.signal(0), b.signal(0)];
    const overLimit = a.computed(() => items.reduce((sum, item) => sum + item.value, 0) > 100);
    const seen: boolean[] = [];
    b.effect(() => {
      seen.push(overLimit.value);
    });
    items[0]!.value = 1;
    items[1]!.value = 2;
    items[2]!.value = 3;
    expect(seen).toEqual([false]);
    items[2]!.value = 200;
    expect(seen).toEqual([false, true]);
  });

  it("re-runs a foreign child effect without re-running its parent", () => {
    const [a, b] = make();
    const s = b.signal(0);
    const y = b.signal(0);
    let parent = 0;
    let child = 0;
    let live = 0;
    const dispose = b.effect(() => {
      s.value;
      parent += 1;
      a.effect(() => {
        y.value;
        child += 1;
        live += 1;
        return () => { live -= 1; };
      });
    });
    y.value = 1;
    y.value = 2;
    expect([parent, child, live]).toEqual([1, 3, 1]);
    s.value = 1;
    expect([parent, child, live]).toEqual([2, 4, 1]);
    dispose();
    expect(live).toBe(0);
  });

  it("notifies once per write when one effect reads several foreign sources", () => {
    const [a, b] = make();
    const first = b.signal(0);
    const second = b.signal(0);
    const firstCalls = countListenerCalls(first);
    const secondCalls = countListenerCalls(second);
    let runs = 0;
    a.effect(() => {
      first.value;
      second.value;
      runs += 1;
    });
    first.value = 1;
    expect([runs, firstCalls.calls, secondCalls.calls]).toEqual([2, 1, 0]);
    // Before the fix, the effect's read of `second` during `first`'s
    // notification also subscribed `first`'s internal watcher to `second`.
    second.value = 1;
    expect([runs, firstCalls.calls, secondCalls.calls]).toEqual([3, 1, 1]);
  });

  it("observes a foreign computed that throws and later recovers", () => {
    const [a, b] = make();
    const x = b.signal(0);
    const checked = a.computed(() => {
      if (x.value < 0) throw new Error("negative");
      return x.value > 10;
    });
    const seen: unknown[] = [];
    b.effect(() => {
      try { seen.push(checked.value); }
      catch (error) { seen.push((error as Error).message); }
    });
    x.value = 1;
    x.value = -1;
    x.value = -2;
    x.value = 2;
    x.value = 20;
    expect(seen).toEqual([false, "negative", "negative", false, true]);
  });
});

// Interaction guard (also green before the fix): `untracked()` keeps
// suppressing the outer subscriber across the new foreign-owner branch.
describe.each(directions)("cross-copy untracked reads (%s)", (_name, make) => {
  it("does not subscribe this copy's effect when reading a foreign computed untracked", () => {
    const [a, b] = make();
    const x = b.signal(1);
    const tracked = b.signal(0);
    const doubled = a.computed(() => x.value * 2);
    let runs = 0;
    b.effect(() => {
      tracked.value;
      b.untracked(() => doubled.value);
      runs += 1;
    });
    x.value = 2;
    expect(runs).toBe(1);
    expect(b.untracked(() => doubled.value)).toBe(4);
    tracked.value = 1;
    expect(runs).toBe(2);
  });
});

describe("three-copy round trip", () => {
  it("keeps every hop's cutoff and stays consistent", () => {
    const [a, b, c] = [createReactiveRuntime(), createReactiveRuntime(), createReactiveRuntime()];
    const x = a.signal(1);
    const parity = b.computed(() => x.value % 2);
    const label = c.computed(() => (parity.value === 0 ? "even" : "odd"));
    const seen: string[] = [];
    a.effect(() => {
      seen.push(`${x.peek()}:${label.value}`);
    });
    x.value = 3;
    x.value = 5;
    x.value = 6;
    expect(seen).toEqual(["1:odd", "6:even"]);
  });
});
