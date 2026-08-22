import { afterEach, describe, expect, it } from "vitest";
import { batch, deepSignal, effect, isSignal } from "../src/index.js";

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
    const state = deepSignal({ box, map, nestedSignal });

    expect(state.value.box).toBe(box);
    expect(state.value.map).toBe(map);
    expect(state.value.nestedSignal).toBe(nestedSignal);
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
});
