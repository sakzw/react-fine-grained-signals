import { afterEach, describe, expect, it } from "vitest";
import { batch, deepSignal, effect, isSignal } from "../src/index.js";
import { inspectDeepSignalMetadata } from "../src/core/deep-signal.js";

/** Reads the internal per-key metadata a deep proxy is retaining. */
function metadataOf(value: object) {
  const metadata = inspectDeepSignalMetadata(value);
  if (metadata === undefined) throw new Error("no deep-signal metadata for this value");
  return metadata;
}

// Spelled out rather than imported: the literal string is the cross-instance
// wire format, so a second copy of the package can only agree by matching it.
const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");

/** Produces what a signal from a second copy of this package looks like here. */
function brandForeign<T extends object>(value: T): T {
  Object.defineProperty(value, SIGNAL_BRAND, {
    value: 1,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

describe("deepSignal", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("tracks exact nested keys without notifying a sibling reader", () => {
    const state = deepSignal({
      user: { name: "Ada", age: 36 },
    });
    const names: string[] = [];
    let ageRuns = 0;

    disposers.push(effect(() => {
      names.push(state.value.user.name);
    }));
    disposers.push(effect(() => {
      state.value.user.age;
      ageRuns++;
    }));

    expect(names).toEqual(["Ada"]);
    expect(ageRuns).toBe(1);
    state.value.user.name = "Grace";
    expect(names).toEqual(["Ada", "Grace"]);
    expect(ageRuns).toBe(1);

    state.value.user.age = 37;
    expect(names).toEqual(["Ada", "Grace"]);
    expect(ageRuns).toBe(2);
  });

  it("reconnects nested readers after their parent is replaced", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const values: string[] = [];

    disposers.push(effect(() => {
      values.push(state.value.user.name);
    }));
    state.value.user = { name: "Grace" };
    state.value.user.name = "Lin";

    expect(values).toEqual(["Ada", "Grace", "Lin"]);
  });

  it("preserves Object.is semantics for nested writes", () => {
    const state = deepSignal({ value: 0, nan: Number.NaN });
    const zeroes: number[] = [];
    let nanRuns = 0;

    disposers.push(effect(() => {
      zeroes.push(state.value.value);
    }));
    disposers.push(effect(() => {
      state.value.nan;
      nanRuns++;
    }));

    state.value.value = 0;
    state.value.value = -0;
    state.value.nan = Number.NaN;

    expect(zeroes).toHaveLength(2);
    expect(Object.is(zeroes[1], -0)).toBe(true);
    expect(nanRuns).toBe(1);
  });

  it("tracks additions, deletions, key enumeration, and the in operator", () => {
    const state = deepSignal<Record<string, number>>({});
    const snapshots: Array<{ value: number | undefined; keys: string[]; hasCount: boolean }> = [];

    disposers.push(effect(() => {
      snapshots.push({
        value: state.value.count,
        keys: Object.keys(state.value),
        hasCount: "count" in state.value,
      });
    }));
    state.value.count = 1;
    delete state.value.count;

    expect(snapshots).toEqual([
      { value: undefined, keys: [], hasCount: false },
      { value: 1, keys: ["count"], hasCount: true },
      { value: undefined, keys: [], hasCount: false },
    ]);
  });

  it("tracks array indices and length across mutators and batches writes", () => {
    const state = deepSignal({ items: ["first"] });
    const snapshots: string[] = [];

    disposers.push(effect(() => {
      snapshots.push(`${state.value.items.length}:${state.value.items[1] ?? ""}`);
    }));
    state.value.items.push("second");
    state.value.items.splice(0, 1, "replacement");
    state.value.items.pop();
    batch(() => {
      state.value.items.push("batched-one");
      state.value.items.push("batched-two");
    });

    expect(snapshots).toEqual([
      "1:",
      "2:second",
      "1:",
      "3:batched-one",
    ]);
  });

  it("notifies tracked array indices when length truncates them", () => {
    const state = deepSignal({ items: ["first", "second"] });
    const secondItems: Array<string | undefined> = [];

    disposers.push(effect(() => {
      secondItems.push(state.value.items[1]);
    }));
    state.value.items.length = 1;

    expect(secondItems).toEqual(["second", undefined]);
  });

  it("preserves aliases and cycles while changes remain reactive", () => {
    const shared = { count: 1 };
    type Cyclic = { self?: Cyclic; shared: typeof shared };
    const cyclic: Cyclic = { shared };
    cyclic.self = cyclic;
    const state = deepSignal({ left: shared, right: shared, cyclic });
    const counts: number[] = [];

    expect(state.value.left).toBe(state.value.right);
    expect(state.value.cyclic).toBe(state.value.cyclic.self);
    disposers.push(effect(() => {
      counts.push(state.value.left.count);
    }));
    state.value.right.count = 2;

    expect(counts).toEqual([1, 2]);
  });

  it("never stores deep proxies in the raw tree", () => {
    const state = deepSignal({
      source: { count: 1 },
      wrapped: undefined as
        | { source: { count: number }; self?: unknown }
        | undefined,
    });
    const wrapped: { source: { count: number }; self?: unknown } = {
      source: state.value.source,
    };
    wrapped.self = wrapped;

    state.value.wrapped = wrapped;

    expect(state.peek().wrapped?.source).toBe(state.peek().source);
    expect(state.peek().wrapped?.self).toBe(state.peek().wrapped);
    expect(() => structuredClone(state.peek())).not.toThrow();

    let runs = 0;
    disposers.push(effect(() => {
      state.value.source;
      runs++;
    }));
    // Intentional self-assignment: verifies an equal value doesn't re-notify.
    // oxlint-disable-next-line no-self-assign
    state.value.source = state.value.source;
    expect(runs).toBe(1);
  });

  it("rejects deep proxies inside Map and Set assignments atomically", () => {
    const state = deepSignal({
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

    expect(() => {
      state.value.map = mapWithProxyKey;
    }).toThrow(TypeError);
    expect(() => {
      state.value.map = mapWithProxyValue;
    }).toThrow(TypeError);
    expect(() => {
      state.value.set = setWithProxy;
    }).toThrow(TypeError);
    expect(() => {
      state.value.carrier = nestedCarrier;
    }).toThrow(TypeError);
    expect(() => {
      state.value = {
        source: { count: 2 },
        map: mapWithProxyValue,
        set: new Set(),
        carrier: undefined,
      };
    }).toThrow(TypeError);
    expect(() => deepSignal({ map: mapWithProxyValue })).toThrow(TypeError);

    expect(state.peek().map.size).toBe(0);
    expect(state.peek().set.size).toBe(0);
    expect(state.peek().carrier).toBeUndefined();
    expect(() => structuredClone(state.peek())).not.toThrow();
  });

  it("rejects deep proxies in every opaque value without changing state", () => {
    class Box {
      ref: unknown;

      constructor(ref: unknown) {
        this.ref = ref;
      }
    }
    const state = deepSignal({
      source: { count: 1 },
      box: undefined as Box | undefined,
      date: undefined as Date | undefined,
      callback: undefined as ((() => void) & { ref?: unknown }) | undefined,
      carrier: undefined as { opaque: Box } | undefined,
    });
    const source = state.value.source;
    const date = Object.assign(new Date(), { ref: source });
    const callback = Object.assign(() => undefined, { ref: source });

    expect(() => {
      state.value.box = new Box(source);
    }).toThrow(TypeError);
    expect(() => {
      state.value.date = date;
    }).toThrow(TypeError);
    expect(() => {
      state.value.callback = callback;
    }).toThrow(TypeError);
    expect(() => {
      state.value.carrier = { opaque: new Box(source) };
    }).toThrow(TypeError);

    expect(state.peek().box).toBeUndefined();
    expect(state.peek().date).toBeUndefined();
    expect(state.peek().callback).toBeUndefined();
    expect(state.peek().carrier).toBeUndefined();
    expect(() => structuredClone(state.peek())).not.toThrow();
  });

  it("exposes Map and Set values through stable read-only views", () => {
    const state = deepSignal({
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

    // The public type remains `Map` / `Set` so DeepSignal<T> continues to be
    // assignable to Signal<T>; immutable replacement is enforced at runtime.
    expect(() => map.set("source", 2)).toThrow("Map#set()");
    expect(() => map.delete("first")).toThrow("Map#delete()");
    expect(() => map.clear()).toThrow("Map#clear()");
    expect(() => set.add("second")).toThrow("Set#add()");
    expect(() => set.delete("first")).toThrow("Set#delete()");
    expect(() => set.clear()).toThrow("Set#clear()");

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
    const other = deepSignal({ set: new Set(["first", "second"]) }).value.set;
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

    state.value = {
      source: { count: 2 },
      map: map as unknown as Map<string, number>,
      set: set as unknown as Set<string>,
    };
    expect(state.peek().map).not.toBe(map);
    expect(state.peek().set).not.toBe(set);
    expect(new Map(state.value.map)).toEqual(new Map([["first", 1]]));
    expect(new Set(state.value.set)).toEqual(new Set(["first"]));
  });

  it("does not rescan a direct deep proxy assignment", () => {
    let ownKeyReads = 0;
    const nested = new Proxy(
      { items: Array.from({ length: 4_000 }, (_, index) => ({ index })) },
      {
        ownKeys(target) {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const state = deepSignal({ nested });
    const direct = state.value.nested;
    ownKeyReads = 0;

    state.value.nested = direct;

    expect(ownKeyReads).toBe(0);
  });

  it("does not rescan a known deep subtree inside a new carrier", () => {
    let ownKeyReads = 0;
    const nested = new Proxy(
      { items: Array.from({ length: 4_000 }, (_, index) => ({ index })) },
      {
        ownKeys(target) {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const state = deepSignal({ nested, carrier: undefined as { inner: typeof nested } | undefined });
    const direct = state.value.nested;
    ownKeyReads = 0;

    state.value.carrier = { inner: direct };

    expect(ownKeyReads).toBe(0);
    expect(state.peek().carrier?.inner).toBe(state.peek().nested);
  });

  it("does not rescan a deep graph when reading value", () => {
    let ownKeyReads = 0;
    const raw = new Proxy(
      { items: Array.from({ length: 4_000 }, (_, index) => ({ index })) },
      {
        ownKeys(target) {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const state = deepSignal(raw);
    ownKeyReads = 0;

    for (let index = 0; index < 2_000; index++) state.value;

    expect(ownKeyReads).toBe(0);
  });

  it("accepts very deep graphs without recursive traversal", () => {
    type Node = { child?: Node; value?: number };
    const root: Node = {};
    let current = root;
    for (let depth = 0; depth < 20_000; depth++) {
      current.child = {};
      current = current.child;
    }
    current.value = 1;

    const state = deepSignal(root);
    let nested = state.value;
    for (let depth = 0; depth < 20_000; depth++) nested = nested.child as Node;

    expect(nested.value).toBe(1);
  });

  it("preserves carrier aliases while removing contained proxies", () => {
    const state = deepSignal({
      source: { count: 1 },
      left: undefined as { source: { count: number } } | undefined,
      right: undefined as { source: { count: number } } | undefined,
    });
    const carrier = { source: state.value.source };

    state.value.left = carrier;
    state.value.right = carrier;

    expect(state.peek().left).toBe(state.peek().right);
    expect(state.peek().left?.source).toBe(state.peek().source);
    expect(() => structuredClone(state.peek())).not.toThrow();

    carrier.source = { count: 2 };
    state.value.right = carrier;
    expect(state.peek().right).not.toBe(state.peek().left);
    expect(state.peek().left?.source).toBe(state.peek().source);
    expect(state.peek().right?.source.count).toBe(2);
  });

  it("notifies every deep signal that shares a raw object", () => {
    const shared = { count: 1 };
    const left = deepSignal({ shared });
    const right = deepSignal({ shared });
    const leftValues: number[] = [];
    const rightValues: number[] = [];

    disposers.push(effect(() => {
      leftValues.push(left.value.shared.count);
    }));
    disposers.push(effect(() => {
      rightValues.push(right.value.shared.count);
    }));

    left.value.shared.count = 2;

    expect(left.value.shared).toBe(right.value.shared);
    expect(leftValues).toEqual([1, 2]);
    expect(rightValues).toEqual([1, 2]);
  });

  it("is a signal and keeps deep reactivity after root replacement", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const values: string[] = [];

    expect(isSignal(state)).toBe(true);
    disposers.push(effect(() => {
      values.push(state.value.user.name);
    }));
    state.value = { user: { name: "Grace" } };
    state.value.user.name = "Lin";

    expect(values).toEqual(["Ada", "Grace", "Lin"]);
  });

  it("keeps non-plain nested values opaque", () => {
    class Box {
      constructor(readonly value: number) {}
    }
    const box = new Box(1);
    const map = new Map([["value", 1]]);
    const nestedSignal = deepSignal({ value: 1 });
    const foreignSignal = brandForeign({ value: 1, peek: () => 1 });
    const state = deepSignal({ box, map, nestedSignal, foreignSignal });

    expect(state.value.box).toBe(box);
    expect(state.value.map).not.toBe(map);
    expect(new Map(state.value.map)).toEqual(map);
    expect(state.peek().map).toBe(map);
    expect(state.value.nestedSignal).toBe(nestedSignal);
    expect(state.value.foreignSignal).toBe(foreignSignal);
  });

  it("does not let deep state answer the signal identity probe", () => {
    const state = deepSignal({ user: { name: "Ada" }, tags: ["a"] });

    expect(isSignal(state)).toBe(true);
    expect(isSignal(state.value)).toBe(false);
    expect(isSignal(state.value.user)).toBe(false);
    expect(isSignal(state.value.tags)).toBe(false);
    expect(Object.getOwnPropertySymbols(state.value)).toEqual([]);
    expect(
      (state.value.user as unknown as Record<symbol, unknown>)[SIGNAL_BRAND],
    ).toBeUndefined();
  });

  it("rejects branding deep state as a signal", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const user = state.value.user as unknown as Record<symbol, unknown>;

    expect(() => {
      user[SIGNAL_BRAND] = 1;
    }).toThrow(TypeError);
    expect(isSignal(state.value.user)).toBe(false);
    expect(Object.getOwnPropertySymbols(state.peek().user)).toEqual([]);
  });

  it("rejects prototype mutation through deep state", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    const user = state.value.user as unknown as Record<string, unknown>;

    expect(() => {
      user.__proto__ = { polluted: true };
    }).toThrow(TypeError);
    expect((state.value.user as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(state.peek().user)).toBe(Object.prototype);
  });

  it("keeps proxy invariants when a raw reference brands state behind its back", () => {
    const raw = { name: "Ada", peek: () => "Ada" };
    const state = deepSignal({ user: raw });
    const userProxy = state.value.user;

    brandForeign(raw);

    // The brand is now a non-configurable own value of the proxy target, so the
    // proxy has to report it rather than hide it and trip an invariant.
    expect((userProxy as unknown as Record<symbol, unknown>)[SIGNAL_BRAND]).toBe(1);
    expect(isSignal(userProxy)).toBe(true);
    // And the raw object now reads as a foreign signal, so it stays opaque.
    expect(state.value.user).toBe(raw);
  });

  it("does not collect nested dependencies through peek", () => {
    const state = deepSignal({ user: { name: "Ada" } });
    let runs = 0;

    disposers.push(effect(() => {
      state.peek().user.name;
      runs++;
    }));
    state.value.user.name = "Grace";
    state.value = { user: { name: "Lin" } };

    expect(runs).toBe(1);
  });

  it("rejects roots that cannot be represented as deep state", () => {
    expect(() => deepSignal(null as never)).toThrow();
    expect(() => deepSignal(1 as never)).toThrow();
    expect(() => deepSignal((() => undefined) as never)).toThrow();
    expect(() => deepSignal(Object.freeze({ value: 1 }))).toThrow();
    expect(() => deepSignal(brandForeign({ value: 1, peek: () => 1 }))).toThrow();

    expect(() => deepSignal({ nested: Object.freeze({ value: 1 }) })).toThrow();

    const nestedFrozen = deepSignal({ nested: { value: 1 } });
    expect(() => {
      nestedFrozen.value.nested = Object.freeze({ value: 2 }) as never;
    }).toThrow();
    expect(nestedFrozen.peek().nested.value).toBe(1);
  });

  it("rejects descriptor, accessor, and extensibility mutations", () => {
    const accessorState = {
      get value() {
        return 1;
      },
    };
    expect(() => deepSignal(accessorState)).toThrow();

    const state = deepSignal({ value: 1 });
    expect(() => Object.defineProperty(state.value, "other", { value: 2 })).toThrow();
    expect(() => Object.freeze(state.value)).toThrow();
    expect(() => Object.setPrototypeOf(state.value, null)).toThrow();
    expect(state.value.value).toBe(1);
    state.value.value = 2;
    expect(state.value.value).toBe(2);
  });

  it("rejects accessor-bearing assignments without changing state", () => {
    const state = deepSignal<{
      nested: { value: number };
    }>({ nested: { value: 1 } });
    const accessor = Object.defineProperty({}, "value", {
      configurable: true,
      enumerable: true,
      get: () => 2,
    }) as { value: number };

    expect(() => {
      state.value.nested = accessor;
    }).toThrow(TypeError);
    expect(state.peek().nested.value).toBe(1);

    expect(() => {
      state.value = { nested: accessor };
    }).toThrow(TypeError);
    expect(state.peek().nested.value).toBe(1);

    const accessorRoot = Object.defineProperty({}, "nested", {
      configurable: true,
      enumerable: true,
      get: () => ({ value: 2 }),
    }) as { nested: { value: number } };
    expect(() => {
      state.value = accessorRoot;
    }).toThrow(TypeError);
    expect(state.peek().nested.value).toBe(1);

    const deeplyInvalid = {
      nested: {
        valid: { value: 2 },
        invalid: Object.preventExtensions({ value: 3 }),
      },
    };
    expect(() => {
      state.value = deeplyInvalid as never;
    }).toThrow(TypeError);
    expect(state.peek().nested.value).toBe(1);
  });

  it("does not mint version signals for inherited prototype members", () => {
    const state = deepSignal({ list: ["a", "b", "c"], label: "x" });

    disposers.push(effect(() => {
      state.value.list.map((entry) => entry.toUpperCase());
      state.value.list.includes("a");
      "map" in state.value.list;
      String(state.value.label);
    }));

    const list = metadataOf(state.value.list);
    // Only real data keys: the indices the read touched, plus `length`.
    expect(new Set(list.properties)).toEqual(new Set(["0", "1", "2", "length"]));
    expect(list.properties).not.toContain("map");
    expect(list.properties).not.toContain("includes");
    expect(list.properties).not.toContain(Symbol.iterator);
    expect(list.existence).not.toContain("map");

    // A key that shadows a prototype member as real own data stays reactive.
    const shadowing = deepSignal({ map: 1 });
    const seen: number[] = [];
    disposers.push(effect(() => {
      seen.push(shadowing.value.map);
    }));
    expect(metadataOf(shadowing.value).properties).toContain("map");
    shadowing.value.map = 2;
    expect(seen).toEqual([1, 2]);
  });

  it("prunes per-key metadata for removed keys once nothing subscribes", () => {
    const state = deepSignal({
      list: Array.from({ length: 40 }, (_, index) => `row-${index}`),
      removable: "here" as string | undefined,
    });

    const dispose = effect(() => {
      for (const entry of state.value.list) String(entry);
      "removable" in state.value;
      String(state.value.removable);
    });

    const before = metadataOf(state.value.list);
    expect(before.propertyIndices).toHaveLength(40);
    expect(before.properties).toHaveLength(41);

    // With the subscriber gone, the version signals for keys that no longer
    // exist are garbage. Pre-fix they were retained for the life of the proxy.
    dispose();
    state.value.list.length = 0;

    const afterTruncation = metadataOf(state.value.list);
    expect(afterTruncation.propertyIndices).toEqual([]);
    expect(afterTruncation.properties).toEqual(["length"]);

    const rootBefore = metadataOf(state.value);
    expect(rootBefore.properties).toContain("removable");
    expect(rootBefore.existence).toContain("removable");
    delete (state.value as { removable?: string }).removable;
    const rootAfter = metadataOf(state.value);
    expect(rootAfter.properties).not.toContain("removable");
    expect(rootAfter.existence).not.toContain("removable");
  });

  it("keeps a removed key's version signal while a subscriber still reads it", () => {
    const state = deepSignal({ list: ["a", "b", "c"] });
    const seen: Array<string | undefined> = [];

    // This subscriber keeps reading index 2 even after it is truncated away,
    // so its version signal must survive — dropping it would strand the
    // effect on a `RenderSubscription` the property map no longer reaches.
    disposers.push(effect(() => {
      seen.push(state.value.list[2]);
    }));
    expect(seen).toEqual(["c"]);

    state.value.list.length = 2;
    expect(seen).toEqual(["c", undefined]);
    expect(metadataOf(state.value.list).properties).toContain("2");

    // Still wired up: restoring the index notifies the same subscriber.
    state.value.list[2] = "c2";
    expect(seen).toEqual(["c", undefined, "c2"]);
  });

  it("reports a frozen collection-valued property with the library's own error", () => {
    // `wrap()` substitutes a readonly view for a Map/Set exactly as it
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
    const mapState = deepSignal(withMap);
    expect(() => mapState.value.collection).toThrow(
      /non-configurable, non-writable object property/,
    );

    const withSet = Object.defineProperty({}, "collection", {
      value: new Set([1]),
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { collection: Set<number> };
    const setState = deepSignal(withSet);
    expect(() => setState.value.collection).toThrow(
      /non-configurable, non-writable object property/,
    );

    // An opaque value needs no substitution, so it is still readable.
    const withDate = Object.defineProperty({}, "at", {
      value: new Date(0),
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { at: Date };
    expect(deepSignal(withDate).value.at.getTime()).toBe(0);
  });

  it("keeps a sparse carrier's identity across repeated assignment", () => {
    const state = deepSignal({
      source: { count: 1 },
      left: undefined as unknown[] | undefined,
      right: undefined as unknown[] | undefined,
    });

    // A carrier containing one of our proxies must be copied before storage;
    // pre-fix that copy densified the array (`Array.from({ length })`), so the
    // clone had more own keys than its source and the cache could never match
    // it again — every re-assignment produced a new identity.
    const carrier: unknown[] = [];
    carrier[3] = state.value.source;

    state.value.left = carrier;
    state.value.right = carrier;

    expect(state.peek().left).toBe(state.peek().right);
    expect(state.peek().left?.[3]).toBe(state.peek().source);
    // Holes stay holes rather than becoming own `undefined` properties.
    expect(Object.hasOwn(state.peek().left as object, "0")).toBe(false);
    expect(Reflect.ownKeys(state.peek().left as object)).toEqual(["3", "length"]);
    expect((state.peek().left as unknown[]).length).toBe(4);
  });

  it("tracks and wraps values read through getOwnPropertyDescriptor", () => {
    const state = deepSignal({ nested: { count: 1 }, list: [1] });
    const counts: number[] = [];

    // Pre-fix there was no `getOwnPropertyDescriptor` trap, so the descriptor
    // carried the raw nested object: this read subscribed to nothing and the
    // effect never re-ran, while `get`, spread, `Object.entries` and
    // `JSON.stringify` all wrapped and tracked the very same property.
    disposers.push(effect(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        state.value,
        "nested",
      ) as PropertyDescriptor;
      counts.push((descriptor.value as { count: number }).count);
    }));
    expect(counts).toEqual([1]);

    state.value.nested.count = 2;
    expect(counts).toEqual([1, 2]);

    const descriptor = Object.getOwnPropertyDescriptor(state.value, "nested");
    expect(descriptor?.value).toBe(state.value.nested);
    expect(descriptor?.value).not.toBe(state.peek().nested);
    // The reported descriptor still describes the property faithfully.
    expect(descriptor).toMatchObject({ writable: true, enumerable: true, configurable: true });

    // One call used to hand out every top-level raw reference at once.
    const all = Object.getOwnPropertyDescriptors(state.value);
    expect(all.nested.value).toBe(state.value.nested);
    expect(all.list.value).toBe(state.value.list);
    expect(all.nested.value).not.toBe(state.peek().nested);

    // A missing key reports nothing, but the read is still a subscription.
    const seen: unknown[] = [];
    disposers.push(effect(() => {
      seen.push(Object.getOwnPropertyDescriptor(state.value, "added")?.value);
    }));
    expect(seen).toEqual([undefined]);
    (state.value as { added?: number }).added = 7;
    expect(seen).toEqual([undefined, 7]);
  });

  it("reports a non-configurable property through the descriptor trap without breaking invariants", () => {
    // A proxy may not report a different value for a non-configurable,
    // non-writable property: substituting the wrapper makes the engine itself
    // throw at the call site. `get` refuses such a property with the library's
    // own error, but refusing here would break `getOwnPropertyDescriptors()`
    // for the whole object, so the property is reported exactly as it is.
    const frozenSlot = Object.defineProperty({}, "nested", {
      value: { count: 1 },
      writable: false,
      configurable: false,
      enumerable: true,
    }) as { nested: { count: number } };
    const frozenState = deepSignal(frozenSlot);

    const descriptor = Object.getOwnPropertyDescriptor(frozenState.value, "nested");
    expect(descriptor?.value).toBe(frozenState.peek().nested);
    expect(() => Object.getOwnPropertyDescriptors(frozenState.value)).not.toThrow();
    // `get` keeps rejecting it with the library's message rather than lying.
    expect(() => frozenState.value.nested).toThrow(
      /non-configurable, non-writable object property/,
    );

    // Non-configurable but writable: the invariant permits a substituted
    // value, so this one is wrapped and tracked like any other property.
    const writableSlot = Object.defineProperty({}, "nested", {
      value: { count: 1 },
      writable: true,
      configurable: false,
      enumerable: true,
    }) as { nested: { count: number } };
    const writableState = deepSignal(writableSlot);
    const writableDescriptor = Object.getOwnPropertyDescriptor(writableState.value, "nested");
    expect(writableDescriptor?.value).toBe(writableState.value.nested);
    expect(writableDescriptor?.value).not.toBe(writableState.peek().nested);

    // An array's own `length` is non-configurable too, and still readable.
    const listState = deepSignal({ list: ["a", "b"] });
    expect(Object.getOwnPropertyDescriptor(listState.value.list, "length")?.value).toBe(2);
  });

  it("rejects built-in prototype objects as deep state", () => {
    const message = /built-in prototype object/;

    // `Array.prototype` used to slip through every check: `Array.isArray`
    // short-circuits the prototype test, and it is extensible with only data
    // properties, so the `set` trap would have written to the real intrinsic.
    expect(() => deepSignal({ p: Array.prototype })).toThrow(message);
    expect(() => deepSignal({ list: [Array.prototype] })).toThrow(message);
    expect(() => deepSignal(Array.prototype as unknown as object)).toThrow(message);
    // `Object.prototype` was only ever caught by accident, through its
    // `__proto__` accessor tripping the accessor check; now it is deliberate.
    expect(() => deepSignal({ p: Object.prototype })).toThrow(message);
    expect(() => deepSignal(Object.prototype)).toThrow(message);
    // These pass the accessor check outright and were accepted before.
    expect(() => deepSignal({ p: Error.prototype })).toThrow(message);
    expect(() => deepSignal({ p: Date.prototype })).toThrow(message);
    expect(() => deepSignal({ p: Promise.prototype })).toThrow(message);
    expect(() => deepSignal({ p: String.prototype })).toThrow(message);
    expect(() => deepSignal({ p: WeakMap.prototype })).toThrow(message);
    // And these now report the same deliberate reason as the rest.
    expect(() => deepSignal({ p: Map.prototype })).toThrow(message);
    expect(() => deepSignal({ p: Set.prototype })).toThrow(message);
    expect(() => deepSignal({ p: RegExp.prototype })).toThrow(message);
    expect(() => deepSignal({ p: Function.prototype })).toThrow(message);

    // Assigning one later is rejected the same way, and nothing lands on the
    // shared intrinsic on the way out.
    const state = deepSignal({ p: 1 as unknown });
    expect(() => {
      state.value.p = Array.prototype;
    }).toThrow(message);
    expect(() => {
      state.value = { p: Object.prototype };
    }).toThrow(message);
    expect(state.peek().p).toBe(1);
    expect(Object.hasOwn(Array.prototype, "p")).toBe(false);

    // Instances of those builtins, and a constructor's own `.prototype` reached
    // through an opaque value, stay perfectly storable.
    expect(deepSignal({ d: new Date(0) }).value.d.getTime()).toBe(0);
    expect(deepSignal({ e: new Error("boom") }).value.e.message).toBe("boom");
    expect(deepSignal({ m: new Map([["a", 1]]) }).value.m.get("a")).toBe(1);
    expect(deepSignal({ ctor: Array as unknown as object }).peek().ctor).toBe(Array);
  });
});
