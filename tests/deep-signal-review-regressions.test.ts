import { describe, expect, it } from "vitest";
import { deepSignal, effect, signal } from "../src/index.js";
import { inspectDeepSignalMetadata } from "../src/core/deep-signal.js";

// Regression coverage for the v0.2.0 release review's DeepSignal findings.

function countRuns(read: () => void): { runs: () => number; stop: () => void } {
  let runs = 0;
  const stop = effect(() => {
    runs += 1;
    read();
  });
  return { runs: () => runs, stop };
}

describe("array mutators do not subscribe the caller (D1)", () => {
  const mutations: Array<[string, (list: number[]) => unknown]> = [
    ["push", (list) => list.push(9)],
    ["pop", (list) => list.pop()],
    ["shift", (list) => list.shift()],
    ["unshift", (list) => list.unshift(0)],
    ["splice", (list) => list.splice(1, 1, 7)],
    // The point is the in-place mutators themselves.
    // oxlint-disable-next-line unicorn/no-array-sort
    ["sort", (list) => list.sort((x, y) => y - x)],
    // oxlint-disable-next-line unicorn/no-array-reverse
    ["reverse", (list) => list.reverse()],
    ["fill", (list) => list.fill(5, 0, 1)],
    ["copyWithin", (list) => list.copyWithin(0, 1)],
  ];

  for (const [name, mutate] of mutations) {
    it(`${name}() inside an effect does not make the effect depend on the array`, () => {
      const trigger = signal(0);
      const state = deepSignal({ list: [3, 1, 2] });
      const { runs, stop } = countRuns(() => {
        void trigger.value;
        mutate(state.value.list);
      });
      expect(runs()).toBe(1);
      // A write made elsewhere must not re-run the effect.
      state.value.list.push(4);
      expect(runs()).toBe(1);
      trigger.value = 1;
      expect(runs()).toBe(2);
      stop();
    });
  }

  it("still notifies readers of the array when a mutator runs", () => {
    const state = deepSignal({ log: ["a"] });
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(state.value.log.length);
    });
    state.value.log.push("b");
    state.value.log.splice(0, 1);
    expect(seen).toEqual([1, 2, 1]);
    stop();
  });

  it("does not grow a log pushed to from inside an effect on unrelated pushes", () => {
    const trigger = signal(0);
    const state = deepSignal({ log: [] as string[] });
    const stop = effect(() => {
      void trigger.value;
      state.value.log.push("x");
    });
    expect(state.value.log.length).toBe(1);
    state.value.log.push("external");
    expect(state.value.log.length).toBe(2);
    stop();
  });
});

describe("key enumeration and own-key checks track existence, not values (D2)", () => {
  const readers: Array<[string, (value: Record<string, number>) => unknown]> = [
    ["Object.keys", (value) => Object.keys(value)],
    ["for...in", (value) => {
      const keys: string[] = [];
      for (const key in value) keys.push(key);
      return keys;
    }],
    ["Object.hasOwn", (value) => Object.hasOwn(value, "a")],
    ["hasOwnProperty.call", (value) => Object.prototype.hasOwnProperty.call(value, "a")],
  ];

  for (const [name, read] of readers) {
    it(`${name} does not re-run on a value change but does on add/delete`, () => {
      const state = deepSignal<Record<string, number>>({ a: 1 });
      const { runs, stop } = countRuns(() => read(state.value));
      state.value.a = 10;
      expect(runs()).toBe(1);
      delete state.value.a;
      expect(runs()).toBe(2);
      state.value.a = 1;
      expect(runs()).toBe(3);
      stop();
    });
  }

  it("still re-runs a value reader such as Object.entries", () => {
    const state = deepSignal<Record<string, number>>({ a: 1 });
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(Object.entries(state.value));
    });
    state.value.a = 2;
    expect(seen).toEqual([[["a", 1]], [["a", 2]]]);
    stop();
  });

  it("keeps array and symbol-key existence reactive", () => {
    const tag = Symbol("tag");
    const state = deepSignal<{ list: number[]; meta: Record<symbol, number> }>({ list: [1], meta: {} });
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push([Object.hasOwn(state.value.list, 1), Object.hasOwn(state.value.meta, tag)]);
    });
    state.value.list.push(2);
    state.value.meta[tag] = 1;
    expect(seen).toEqual([[false, false], [true, false], [true, true]]);
    stop();
  });

  it("still hands back wrapped nested values through descriptors", () => {
    const state = deepSignal({ nested: { count: 0 } });
    const descriptor = Object.getOwnPropertyDescriptor(state.value, "nested");
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push((descriptor!.value as { count: number }).count);
    });
    state.value.nested.count = 1;
    expect(seen).toEqual([0, 1]);
    stop();
  });
});

describe("inherited keys and receivers", () => {
  it("keeps dictionary-style state keyed by inherited names reactive", () => {
    const counts = deepSignal<Record<string, number>>({});
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push([Object.hasOwn(counts.value, "constructor"), "toString" in counts.value]);
    });
    counts.value.constructor = 1 as never;
    expect(seen).toEqual([[false, true], [true, true]]);
    stop();
  });

  it("re-runs a get of an inherited name once it becomes an own property", () => {
    const counts = deepSignal<Record<string, unknown>>({});
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(typeof counts.value.toString);
    });
    Reflect.set(counts.value, "toString", 3);
    expect(seen).toEqual(["function", "number"]);
    stop();
  });

  it("does not mint version signals for array methods read on every render", () => {
    const state = deepSignal({ list: [1, 2] });
    const stop = effect(() => {
      void state.value.list.map((item) => item);
    });
    // `map` and friends stay untracked for arrays, as before.
    state.value.list.push(3);
    const tracked = inspectDeepSignalMetadata(state.value.list)?.properties;
    expect(tracked).not.toContain("map");
    expect(tracked).toContain("length");
    stop();
  });

  it("defines a property on a receiver that inherits from the proxy", () => {
    const state = deepSignal<Record<string, number>>({ a: 1 });
    const seen: unknown[] = [];
    const stop = effect(() => {
      seen.push(Object.keys(state.value));
    });
    const child = Object.create(state.value) as Record<string, number>;
    child.a = 99;
    child.b = 2;
    expect(Object.hasOwn(child, "a")).toBe(true);
    expect(child.a).toBe(99);
    expect(state.value.a).toBe(1);
    expect(Object.hasOwn(state.value, "b")).toBe(false);
    expect(seen).toEqual([["a"]]);
    stop();
  });
});
