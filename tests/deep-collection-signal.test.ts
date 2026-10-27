import { describe, expect, it } from "vitest";
import { deepCollectionSignal } from "../src/index.js";

describe("deepCollectionSignal", () => {
  it("normalizes deep proxies used as collection keys, values, and members", () => {
    const state = deepCollectionSignal({
      source: { count: 1 },
      map: new Map<string | object, unknown>(),
      set: new Set<unknown>(),
      carrier: undefined as { collection: Map<unknown, unknown> } | undefined,
    });
    const source = state.value.source;
    const mapWithProxyKey = new Map([[source, "value"]]);
    const mapWithProxyValue = new Map([["source", source]]);
    const setWithProxy = new Set([source]);
    const nestedCarrier = { collection: new Map([["source", source]]) };

    state.value.map = mapWithProxyKey;
    expect(state.value.map.get(source)).toBe("value");
    expect(state.value.map.get(state.peek().source)).toBe("value");

    state.value.map = mapWithProxyValue;
    expect(state.value.map.get("source")).toBe(source);
    expect(state.peek().map.get("source")).toBe(state.peek().source);

    state.value.set = setWithProxy;
    expect(state.value.set.has(source)).toBe(true);
    expect(state.value.set.has(state.peek().source)).toBe(true);

    state.value.carrier = nestedCarrier;
    expect(state.value.carrier?.collection.get("source")).toBe(source);
    expect(state.peek().carrier?.collection.get("source")).toBe(state.peek().source);

    const reassigned = deepCollectionSignal({ map: mapWithProxyValue });
    expect(reassigned.value.map.get("source")).toBe(source);
    expect(() => structuredClone(state.peek())).not.toThrow();
    expect(() => structuredClone(state.peek())).not.toThrow();
  });

  it("exposes Map and Set values through stable reactive proxies", () => {
    const state = deepCollectionSignal({
      source: { count: 1 },
      map: new Map<string, number>([["first", 1]]),
      set: new Set(["first"]),
    });
    const map = state.value.map;
    const set = state.value.set;

    expect(map).toBe(state.value.map);
    expect(set).toBe(state.value.set);
    expect(map).not.toBe(state.peek().map);
    expect(set).not.toBe(state.peek().set);
    expect(map.size).toBe(1);
    expect(map.get("first")).toBe(1);
    expect([...map.keys()]).toEqual(["first"]);
    expect([...map.values()]).toEqual([1]);
    expect([...map.entries()]).toEqual([["first", 1]]);
    expect(new Map(map)).toEqual(new Map([["first", 1]]));
    let mapThirdArgument: ReadonlyMap<string, number> | undefined;
    map.forEach((_value, _key, collection) => {
      mapThirdArgument = collection;
    });
    expect(mapThirdArgument).toBe(map);

    expect(set.size).toBe(1);
    expect(set.has("first")).toBe(true);
    expect([...set.keys()]).toEqual(["first"]);
    expect([...set.values()]).toEqual(["first"]);
    expect([...set.entries()]).toEqual([["first", "first"]]);
    expect(new Set(set)).toEqual(new Set(["first"]));
    let setThirdArgument: ReadonlySet<string> | undefined;
    set.forEach((_value, _key, collection) => {
      setThirdArgument = collection;
    });
    expect(setThirdArgument).toBe(set);

    type SetOperations<T> = Set<T> & {
      union(other: ReadonlySet<T>): Set<T>;
      intersection(other: ReadonlySet<T>): Set<T>;
      difference(other: ReadonlySet<T>): Set<T>;
      symmetricDifference(other: ReadonlySet<T>): Set<T>;
      isSubsetOf(other: ReadonlySet<T>): boolean;
      isSupersetOf(other: ReadonlySet<T>): boolean;
      isDisjointFrom(other: ReadonlySet<T>): boolean;
    };
    const setOperations = set as SetOperations<string>;
    const other = deepCollectionSignal({ set: new Set(["first", "second"]) }).value.set;
    expect(setOperations.union(other)).toEqual(new Set(["first", "second"]));
    expect(setOperations.intersection(other)).toEqual(new Set(["first"]));
    expect(setOperations.difference(other)).toEqual(new Set());
    expect(setOperations.symmetricDifference(other)).toEqual(new Set(["second"]));
    expect(setOperations.isSubsetOf(other)).toBe(true);
    expect(setOperations.isSupersetOf(other)).toBe(false);
    expect(setOperations.isDisjointFrom(other)).toBe(false);

    expect(state.peek().map).toEqual(new Map([["first", 1]]));
    expect(state.peek().set).toEqual(new Set(["first"]));
    expect(() => structuredClone(state.peek())).not.toThrow();

    // Collection methods keep their native return values while mutations are
    // tracked and update the raw graph behind `.peek()`.
    expect(map.set("source", 2)).toBe(map);
    expect(map.delete("first")).toBe(true);
    expect(map.get("source")).toBe(2);
    expect(map.clear()).toBeUndefined();
    expect(set.add("second")).toBe(set);
    expect(set.delete("first")).toBe(true);
    expect(set.has("second")).toBe(true);
    expect(set.clear()).toBeUndefined();

    state.value = {
      source: { count: 2 },
      map: map as unknown as Map<string, number>,
      set: set as unknown as Set<string>,
    };
    expect(state.peek().map).not.toBe(map);
    expect(state.peek().set).not.toBe(set);
    expect(new Map(state.value.map)).toEqual(new Map());
    expect(new Set(state.value.set)).toEqual(new Set());
  });

  it("reports a frozen collection-valued property with the library's own error", () => {
    // `wrap()` substitutes a proxy for a Map/Set exactly as it
    // substitutes a proxy for a plain object, and neither can be handed back
    // through a non-configurable, non-writable slot without violating the
    // proxy invariants. Gating the check on `isPlainObjectOrArray` let the
    // Map/Set case fall through to a raw engine TypeError instead.
    const withMap = Object.defineProperty({}, "collection", {
      value: new Map([["a", 1]]),
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { collection: Map<string, number> };
    const mapState = deepCollectionSignal(withMap);
    expect(() => mapState.value.collection).toThrow(/non-configurable, non-writable object property/);

    const withSet = Object.defineProperty({}, "collection", {
      value: new Set([1]),
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { collection: Set<number> };
    const setState = deepCollectionSignal(withSet);
    expect(() => setState.value.collection).toThrow(/non-configurable, non-writable object property/);

    // An opaque value needs no substitution, so it is still readable.
    const withDate = Object.defineProperty({}, "at", {
      value: new Date(0),
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { at: Date };
    expect(deepCollectionSignal(withDate).value.at.getTime()).toBe(0);
  });
});
