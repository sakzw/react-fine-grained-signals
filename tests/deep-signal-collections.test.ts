import { afterEach, describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { batch, deepSignal, effect, signal, untracked } from "../src/index.js";
import { coreRuntime } from "../src/core/core-runtime.js";
import { inspectCollectionMetadata } from "../src/core/deep-signal.js";

describe("deepSignal reactive collections", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("reacts to collection roots and nested collections by default", () => {
    const rawMap = new Map([["a", 1]]);
    const nested = deepSignal({ map: rawMap });
    const reactive = deepSignal(rawMap);
    expect(reactive.value).toBeInstanceOf(Map);
    expect(reactive.value).toBe(nested.value.map);
    const values: Array<number | undefined> = [];
    disposers.push(effect(() => { values.push(nested.value.map.get("a")); }));
    expect(nested.value.map.set("a", 2)).toBe(nested.value.map);
    expect(values).toEqual([1, 2]);
    expect(reactive.value.get("a")).toBe(2);
  });

  it("tracks Map keys, values, size and both iteration domains independently", () => {
    const map = deepSignal(new Map([["a", 1], ["b", 2]]));
    const values: Array<number | undefined> = [];
    const existence: boolean[] = [];
    const sizes: number[] = [];
    const keys: string[][] = [];
    const entries: string[][] = [];
    disposers.push(effect(() => { values.push(map.value.get("a")); }));
    disposers.push(effect(() => { existence.push(map.value.has("a")); }));
    disposers.push(effect(() => { sizes.push(map.value.size); }));
    disposers.push(effect(() => { keys.push([...map.value.keys()]); }));
    disposers.push(effect(() => { entries.push([...map.value].map(([key, value]) => `${key}=${value}`)); }));

    map.value.set("a", 3);
    expect(values).toEqual([1, 3]);
    expect(existence).toEqual([true]);
    expect(sizes).toEqual([2]);
    expect(keys).toEqual([["a", "b"]]);
    expect(entries).toEqual([["a=1", "b=2"], ["a=3", "b=2"]]);

    map.value.set("c", 4);
    expect(values).toEqual([1, 3]);
    expect(existence).toEqual([true]);
    expect(sizes).toEqual([2, 3]);
    expect(keys.at(-1)).toEqual(["a", "b", "c"]);
    expect(entries.at(-1)).toEqual(["a=3", "b=2", "c=4"]);

    const runCounts = [values.length, existence.length, sizes.length, keys.length, entries.length];
    map.value.set("c", 4);
    expect([values.length, existence.length, sizes.length, keys.length, entries.length]).toEqual(runCounts);
    map.value.delete("a");
    expect(values).toEqual([1, 3, undefined]);
    expect(existence).toEqual([true, false]);
    expect(sizes.at(-1)).toBe(2);
    expect(keys.at(-1)).toEqual(["b", "c"]);
    expect(entries.at(-1)).toEqual(["b=2", "c=4"]);
  });

  it("normalizes raw and proxy Map keys and Set members while wrapping iteration values", () => {
    const key = { id: 1 };
    const value = { count: 1 };
    const state = deepSignal({ map: new Map([[key, value]]), set: new Set([key]) });
    const proxyKey = [...state.value.map.keys()][0]!;
    const proxySetMember = [...state.value.set][0]!;

    expect(proxyKey).not.toBe(key);
    expect(proxySetMember).toBe(proxyKey);
    expect(state.value.map.get(key)).toBe(state.value.map.get(proxyKey));
    expect(state.value.map.get(proxyKey)?.count).toBe(1);
    expect(state.value.set.has(key)).toBe(true);
    expect(state.value.set.has(proxySetMember)).toBe(true);

    state.value.map.set(proxyKey, { count: 2 });
    expect(state.value.map.size).toBe(1);
    expect(state.peek().map.has(proxyKey)).toBe(false);
    expect(state.peek().map.has(key)).toBe(true);
    expect(state.value.set.delete(proxySetMember)).toBe(true);
    expect(state.peek().set.has(key)).toBe(false);
  });

  it("rejects collection subclasses and cross-realm collections in reactive mode", () => {
    class CustomMap extends Map<string, number> {}
    const crossRealmMap = runInNewContext("new Map([['a', 1]])") as Map<string, number>;
    expect(() => deepSignal(new CustomMap())).toThrow(/same-realm/);
    expect(() => deepSignal({ map: crossRealmMap })).toThrow(/same-realm/);
  });

  it("rejects prototype mutation on reactive collection proxies", () => {
    const map = deepSignal(new Map([["a", 1]]));

    expect(() => Reflect.set(map.value, "extra", 1)).toThrow(/own properties/);
    expect(() => Reflect.deleteProperty(map.value, "a")).toThrow(/own properties/);
    expect(() => Object.defineProperty(map.value, "extra", { value: 1 })).toThrow(/property descriptors/);
    expect(() => Object.preventExtensions(map.value)).toThrow(/must remain extensible/);
    expect(() => Object.setPrototypeOf(map.value, null)).toThrow(/prototype mutation/);
    expect(map.value).toBeInstanceOf(Map);
    expect(map.value.get("a")).toBe(1);
  });

  it("rejects Map key collisions caused by normalizing this runtime's proxy", () => {
    const source = deepSignal({ key: { id: 1 } });
    const rawKey = source.peek().key;
    const proxyKey = source.value.key;
    const colliding = new Map< object, number>([[rawKey, 1], [proxyKey, 2]]);
    expect(() => deepSignal(colliding)).toThrow(/collide after proxy normalization/);
  });

  it("wraps nested collection values and preserves aliases and cycles", () => {
    const shared = { count: 0 };
    const map = new Map<string, { child: typeof shared }>([["entry", { child: shared }]]);
    const raw: { map: typeof map; first: typeof shared; second: typeof shared; self?: unknown } = {
      map,
      first: shared,
      second: shared,
    };
    raw.self = raw;
    const state = deepSignal(raw);
    const root = state.value;

    expect(root.first).toBe(root.second);
    expect(root.map.get("entry")?.child).toBe(root.first);
    expect(root.self).toBe(root);
  });

  it("tracks WeakMap and WeakSet operations only by object key", () => {
    const key = {};
    const weakMap = deepSignal(new WeakMap<object, { count: number }>());
    const weakSet = deepSignal(new WeakSet<object>());
    expect("clear" in weakMap.value).toBe(false);
    expect("clear" in weakSet.value).toBe(false);
    const seen: Array<number | undefined> = [];
    const hasValues: boolean[] = [];
    let hasRuns = 0;
    disposers.push(effect(() => { seen.push(weakMap.value.get(key)?.count); }));
    disposers.push(effect(() => { hasValues.push(weakMap.value.has(key)); }));
    disposers.push(effect(() => { weakSet.value.has(key); hasRuns++; }));

    weakMap.value.set(key, { count: 1 });
    expect(hasValues).toEqual([false, true]);
    expect(seen).toEqual([undefined, 1]);
    expect(weakMap.value.get(key)?.count).toBe(1);
    weakMap.value.set(key, { count: 2 });
    expect(seen).toEqual([undefined, 1, 2]);
    expect(hasValues).toEqual([false, true]);
    expect(weakSet.value.add(key)).toBe(weakSet.value);
    expect(hasRuns).toBe(2);
    weakSet.value.add(key);
    expect(hasRuns).toBe(2);
    expect(weakMap.value.delete(key)).toBe(true);
    expect(seen).toEqual([undefined, 1, 2, undefined]);
    expect(hasValues).toEqual([false, true, false]);
    expect(weakSet.value.delete(key)).toBe(true);
    expect(hasRuns).toBe(3);

    let supportsWeakSymbols = false;
    const symbolKey = Symbol("weak-key");
    try {
      WeakMap.prototype.set.call(new WeakMap(), symbolKey as unknown as object, 1);
      supportsWeakSymbols = true;
    } catch {
      // Engines predating weak symbol keys use the normal strong primitive-key
      // metadata path, which is reclaimed by collection mutation sweeps.
    }
    const symbolValues: Array<number | undefined> = [];
    if (supportsWeakSymbols) {
      const weakSymbolMap = deepSignal(new WeakMap<object, number>());
      const weakSymbolKey = symbolKey as unknown as object;
      disposers.push(effect(() => { symbolValues.push(weakSymbolMap.value.get(weakSymbolKey)); }));
      weakSymbolMap.value.set(weakSymbolKey, 1);
    }
    expect(symbolValues).toEqual(supportsWeakSymbols ? [undefined, 1] : []);
  });

  it("tracks reactive Set operands used by native Set composition methods", () => {
    type SetWithIsSubsetOf = Set<unknown> & {
      isSubsetOf?: (other: ReadonlySet<unknown>) => boolean;
    };
    if (typeof (Set.prototype as SetWithIsSubsetOf).isSubsetOf !== "function") return;
    const left = deepSignal(new Set([1]));
    const right = deepSignal(new Set([1]));
    const results: boolean[] = [];
    disposers.push(effect(() => { results.push((left.value as SetWithIsSubsetOf).isSubsetOf!(right.value)); }));

    right.value.add(2);
    expect(results).toEqual([true, true]);
  });

  it("batches collection changes and leaves untracked reads unsubscribed", () => {
    const state = deepSignal({ map: new Map<string, number>() });
    let runs = 0;
    disposers.push(effect(() => { state.value.map.get("a"); runs++; }));

    untracked(() => state.value.map.get("a"));
    batch(() => {
      state.value.map.set("a", 1);
      state.value.map.set("a", 2);
    });
    expect(runs).toBe(2);
  });

  it("keeps subscribed primitive-key metadata through unrelated mutations", () => {
    const map = deepSignal(new Map<string, number>([["watched", 1]]));
    const seen: Array<number | undefined> = [];
    disposers.push(effect(() => { seen.push(map.value.get("watched")); }));

    // These writes run cleanup without notifying the watched-key subscriber.
    map.value.set("other-1", 1);
    map.value.set("other-2", 2);
    map.value.set("watched", 3);
    expect(seen).toEqual([1, 3]);
  });

  it("reclaims disposed primitive-key reads and tracks them again on reuse", () => {
    const map = deepSignal(new Map<string, number>());
    const staleSeen: Array<number | undefined> = [];
    const dispose = effect(() => { staleSeen.push(map.value.get("reused")); });
    dispose();

    // A later mutation sweeps the disposed dependency candidate. Reusing the
    // same primitive key must create a live dependency with the current value.
    map.value.set("unrelated", 1);
    map.value.set("reused", 2);
    const seen: Array<number | undefined> = [];
    disposers.push(effect(() => { seen.push(map.value.get("reused")); }));
    map.value.set("reused", 3);
    expect(staleSeen).toEqual([undefined]);
    expect(seen).toEqual([2, 3]);
  });

  it("notifies key and iteration readers when clearing Map and Set and leaves empty clear as a no-op", () => {
    const map = deepSignal(new Map([["a", 1], ["b", 2]]));
    const set = deepSignal(new Set(["a", "b"]));
    const mapSnapshots: string[] = [];
    const setSnapshots: string[] = [];
    disposers.push(effect(() => {
      mapSnapshots.push(`${map.value.get("a")}:${map.value.size}:${[...map.value.keys()].join(",")}`);
    }));
    disposers.push(effect(() => {
      setSnapshots.push(`${set.value.has("a")}:${set.value.size}:${[...set.value].join(",")}`);
    }));

    expect(map.value.clear()).toBeUndefined();
    expect(set.value.clear()).toBeUndefined();
    expect(mapSnapshots).toEqual(["1:2:a,b", "undefined:0:"]);
    expect(setSnapshots).toEqual(["true:2:a,b", "false:0:"]);

    map.value.clear();
    set.value.clear();
    expect(mapSnapshots).toHaveLength(2);
    expect(setSnapshots).toHaveLength(2);
  });

  it("tracks Map and Set forEach reads with native callback arguments and thisArg", () => {
    const map = deepSignal(new Map([["a", 1]]));
    const set = deepSignal(new Set(["x"]));
    const mapSnapshots: string[] = [];
    const setSnapshots: string[] = [];
    const context = { prefix: "ctx" };
    disposers.push(effect(() => {
      map.value.forEach(function (this: typeof context, value, key, collection) {
        expect(this).toBe(context);
        expect(collection).toBe(map.value);
        mapSnapshots.push(`${this.prefix}:${key}=${value}`);
      }, context);
    }));
    disposers.push(effect(() => {
      set.value.forEach((value, key, collection) => {
        expect(key).toBe(value);
        expect(collection).toBe(set.value);
        setSnapshots.push(`${key}=${value}`);
      });
    }));

    map.value.set("a", 2);
    set.value.add("y");
    expect(mapSnapshots).toEqual(["ctx:a=1", "ctx:a=2"]);
    expect(setSnapshots).toEqual(["x=x", "x=x", "y=y"]);
    expect(() => map.value.forEach(null as never)).toThrow(/callback must be a function/);
    expect(() => set.value.forEach(null as never)).toThrow(/callback must be a function/);
  });

  it("looks up Map and Set keys by identity without validating the key graph", () => {
    const keyCalls = { count: 0 };
    const accessorKey = { get x() { keyCalls.count += 1; return 1; } };
    const frozenKey = Object.freeze({});
    class Opaque { constructor(readonly inner: unknown) {} }
    const state = deepSignal({ map: new Map<unknown, string>(), set: new Set<unknown>(), nested: { a: 1 } });
    const opaqueKey = new Opaque(state.value.nested);

    for (const key of [accessorKey, frozenKey, opaqueKey, Object.prototype, new (class extends Map {})()]) {
      expect(state.value.map.get(key)).toBeUndefined();
      expect(state.value.map.has(key)).toBe(false);
      expect(state.value.map.delete(key)).toBe(false);
      expect(state.value.set.has(key)).toBe(false);
      expect(state.value.set.delete(key)).toBe(false);
    }
    expect(keyCalls.count).toBe(0);

    const stored = { child: state.value.nested };
    state.value.map.set(stored, "stored");
    state.value.set.add(stored);
    expect(state.value.map.get(stored)).toBe("stored");
    expect(state.value.set.has(stored)).toBe(true);
    const [storedKey] = state.value.map.keys();
    expect(state.value.map.get(storedKey)).toBe("stored");

    const seen: Array<string | undefined> = [];
    disposers.push(effect(() => { seen.push(state.value.map.get(stored)); }));
    expect(state.value.map.delete(stored)).toBe(true);
    expect(state.value.set.delete(stored)).toBe(true);
    expect(seen).toEqual(["stored", undefined]);
  });

  it("returns iterators that inherit Iterator helpers", () => {
    const state = deepSignal({ map: new Map([["a", { n: 1 }]]), set: new Set(["x"]) });
    const entries = state.value.map.entries();
    expect(Object.prototype.toString.call(entries)).toBe("[object Map Iterator]");
    expect(entries[Symbol.iterator]()).toBe(entries);
    // Iterator helpers postdate the ES2022 lib this project typechecks against.
    type Helpers = { toArray(): unknown[]; map(callback: (value: unknown) => unknown): Helpers };
    // Node >= 22 (the supported engines) always provides the global.
    const IteratorConstructor = (globalThis as unknown as { Iterator: abstract new () => unknown }).Iterator;
    const helpers = (iterator: unknown) => iterator as Helpers;
    expect(entries).toBeInstanceOf(IteratorConstructor);
    expect(helpers(state.value.map.keys()).toArray()).toEqual(["a"]);
    expect(helpers(state.value.set.values()).map((value) => String(value).toUpperCase()).toArray()).toEqual(["X"]);
    expect(helpers(state.value.map.values()).toArray()[0]).toBe(state.value.map.get("a"));
  });

  it("releases lookup-only primitive keys once their readers are gone", async () => {
    const map = deepSignal(new Map<string, number>([["kept", 1]]));
    const set = deepSignal(new Set<string>());
    const query = signal("q0");
    const dispose = effect(() => {
      map.value.has(query.value);
      map.value.get(query.value);
      set.value.has(query.value);
    });
    for (let index = 1; index < 300; index += 1) query.value = `q${index}`;
    dispose();
    const live: boolean[] = [];
    disposers.push(effect(() => { live.push(map.value.has("kept")); }));

    map.value.set("other", 2);
    set.value.add("other");
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    const mapKeys = inspectCollectionMetadata(map.value)!;
    expect(mapKeys.existence).toEqual(["kept"]);
    expect(mapKeys.values).toEqual([]);
    expect(inspectCollectionMetadata(set.value)!.members).toEqual([]);
    map.value.delete("kept");
    expect(live).toEqual([true, false]);
  });

  it("makes a render attempt that read a released key observe the change at commit", () => {
    const map = deepSignal(new Map<string, number>());
    const render = coreRuntime.renderAdapter;
    const attempt = render.createRenderAttempt();
    render.withRenderScope(attempt, () => { map.value.get("pending"); });
    // The attempt has not subscribed yet; an unrelated mutation sweeps the key.
    map.value.set("other", 1);
    expect(inspectCollectionMetadata(map.value)!.values).toEqual([]);
    expect(render.settleRenderAttempt(attempt)).toBe(false);
  });
});
