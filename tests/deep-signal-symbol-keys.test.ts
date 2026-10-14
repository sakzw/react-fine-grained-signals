import { afterEach, describe, expect, it } from "vitest";
import { deepSignal, effect } from "../src/index.js";

describe("deepSignal reactive symbol keys", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("tracks registered symbols through Map get/has and Set has across mutations", () => {
    const key = Symbol.for("react-fine-grained-signals.registered-map-key");
    const map = deepSignal(new Map<symbol, number>());
    const set = deepSignal(new Set<symbol>());
    const values: Array<number | undefined> = [];
    const mapPresence: boolean[] = [];
    const setPresence: boolean[] = [];
    disposers.push(effect(() => { values.push(map.value.get(key)); }));
    disposers.push(effect(() => { mapPresence.push(map.value.has(key)); }));
    disposers.push(effect(() => { setPresence.push(set.value.has(key)); }));

    expect(values).toEqual([undefined]);
    expect(mapPresence).toEqual([false]);
    expect(setPresence).toEqual([false]);

    map.value.set(key, 1);
    set.value.add(key);
    expect(values).toEqual([undefined, 1]);
    expect(mapPresence).toEqual([false, true]);
    expect(setPresence).toEqual([false, true]);

    map.value.set(key, 2);
    set.value.add(key);
    expect(values).toEqual([undefined, 1, 2]);
    expect(mapPresence).toEqual([false, true]);
    expect(setPresence).toEqual([false, true]);

    expect(map.value.delete(key)).toBe(true);
    expect(set.value.delete(key)).toBe(true);
    expect(values).toEqual([undefined, 1, 2, undefined]);
    expect(mapPresence).toEqual([false, true, false]);
    expect(setPresence).toEqual([false, true, false]);
  });

  it("matches native WeakMap and WeakSet symbol-key acceptance and error behavior", () => {
    const registered = Symbol.for("react-fine-grained-signals.invalid-weak-key");
    const local = Symbol("weak-key");
    const wellKnown = Symbol.iterator;
    const objectKey = {};
    const symbols = [registered, local, wellKnown];
    const nativeWeakMap = new WeakMap<object, number>();
    const nativeWeakSet = new WeakSet<object>();
    const reactiveWeakMap = deepSignal(new WeakMap<object, number>());
    const reactiveWeakSet = deepSignal(new WeakSet<object>());

    const keyList = [objectKey, ...symbols] as unknown as object[];
    for (const key of keyList) {
      const nativeMapResult = capture(() => WeakMap.prototype.get.call(nativeWeakMap, key));
      const reactiveMapResult = capture(() => reactiveWeakMap.value.get(key));
      expect(reactiveMapResult).toEqual(nativeMapResult);

      const nativeMapHas = capture(() => WeakMap.prototype.has.call(nativeWeakMap, key));
      const reactiveMapHas = capture(() => reactiveWeakMap.value.has(key));
      expect(reactiveMapHas).toEqual(nativeMapHas);

      const nativeSetHas = capture(() => WeakSet.prototype.has.call(nativeWeakSet, key));
      const reactiveSetHas = capture(() => reactiveWeakSet.value.has(key));
      expect(reactiveSetHas).toEqual(nativeSetHas);

      const nativeMapSet = capture(() => WeakMap.prototype.set.call(nativeWeakMap, key, 1));
      const reactiveMapSet = capture(() => reactiveWeakMap.value.set(key, 1));
      expect(errorName(reactiveMapSet)).toBe(errorName(nativeMapSet));

      const nativeSetAdd = capture(() => WeakSet.prototype.add.call(nativeWeakSet, key));
      const reactiveSetAdd = capture(() => reactiveWeakSet.value.add(key));
      expect(errorName(reactiveSetAdd)).toBe(errorName(nativeSetAdd));
    }

    // Invalid non-object/non-weak-symbol keys keep the engine's native
    // TypeError contract for writes, while read behavior follows this runtime.
    for (const invalid of [null, undefined, 0, "key", registered]) {
      expect(() => reactiveWeakMap.value.set(invalid as unknown as object, 1)).toThrow(TypeError);
      expect(() => reactiveWeakSet.value.add(invalid as unknown as object)).toThrow(TypeError);
    }
  });

  it("preserves reactive reads for local and well-known symbols", () => {
    const local = Symbol("local-map-key");
    const wellKnown = Symbol.iterator;
    const map = deepSignal(new Map<symbol, number>([[local, 1], [wellKnown, 3]]));
    const localValues: Array<number | undefined> = [];
    const wellKnownValues: Array<number | undefined> = [];
    disposers.push(effect(() => { localValues.push(map.value.get(local)); }));
    disposers.push(effect(() => { wellKnownValues.push(map.value.get(wellKnown)); }));

    map.value.set(local, 2);
    map.value.set(wellKnown, 4);
    expect(localValues).toEqual([1, 2]);
    expect(wellKnownValues).toEqual([3, 4]);

    let supportsWeakSymbolKeys = false;
    try {
      WeakMap.prototype.set.call(new WeakMap(), local as unknown as object, 1);
      WeakSet.prototype.add.call(new WeakSet(), wellKnown as unknown as object);
      supportsWeakSymbolKeys = true;
    } catch {
      // Older runtimes still support these keys in strong Map/Set metadata.
    }
    const weakMap = deepSignal(new WeakMap<object, number>());
    const weakSet = deepSignal(new WeakSet<object>());
    const weakValues: Array<number | undefined> = [];
    const weakPresence: boolean[] = [];
    if (supportsWeakSymbolKeys) {
      disposers.push(effect(() => { weakValues.push(weakMap.value.get(local as unknown as object)); }));
      disposers.push(effect(() => { weakPresence.push(weakSet.value.has(wellKnown as unknown as object)); }));
      weakMap.value.set(local as unknown as object, 8);
      weakSet.value.add(wellKnown as unknown as object);
    }
    expect(weakValues).toEqual(supportsWeakSymbolKeys ? [undefined, 8] : []);
    expect(weakPresence).toEqual(supportsWeakSymbolKeys ? [false, true] : []);
  });

  it("keeps object-key subscriptions disposable and reusable", () => {
    const key = {};
    const map = deepSignal(new Map<object, number>([[key, 1]]));
    const firstValues: Array<number | undefined> = [];
    const disposeFirst = effect(() => { firstValues.push(map.value.get(key)); });
    disposeFirst();

    map.value.set(key, 2);
    expect(firstValues).toEqual([1]);

    const nextValues: Array<number | undefined> = [];
    disposers.push(effect(() => { nextValues.push(map.value.get(key)); }));
    map.value.set(key, 3);
    expect(nextValues).toEqual([2, 3]);
    expect(firstValues).toEqual([1]);
  });
});

function capture<T>(callback: () => T): { value: T } | { error: { name: string } } {
  try {
    return { value: callback() };
  } catch (error) {
    return { error: { name: error instanceof Error ? error.name : typeof error } };
  }
}

function errorName(result: { value: unknown } | { error: { name: string } }): string | undefined {
  return "error" in result ? result.error.name : undefined;
}
