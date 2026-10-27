import { afterEach, describe, expect, it, vi } from "vitest";
import { deepCollectionSignal, effect } from "../src/index.js";

type Composable = Set<unknown> & {
  union(other: unknown): Set<unknown>;
  intersection(other: unknown): Set<unknown>;
  difference(other: unknown): Set<unknown>;
  symmetricDifference(other: unknown): Set<unknown>;
  isSubsetOf(other: unknown): boolean;
  isSupersetOf(other: unknown): boolean;
  isDisjointFrom(other: unknown): boolean;
};

describe("reactive Set composition results (C3)", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("returns a plain Set whose receiver members are reactive proxies", () => {
    const state = deepCollectionSignal({ tags: new Set([{ name: "a" }]) });
    const seen: string[] = [];
    disposers.push(
      effect(() => {
        for (const tag of state.value.tags) seen.push(tag.name);
      }),
    );
    const tags = state.value.tags as unknown as Composable;
    const result = tags.union(new Set());
    expect(result).toBeInstanceOf(Set);
    expect(Object.getPrototypeOf(result)).toBe(Set.prototype);
    expect((result as unknown) === (tags as unknown)).toBe(false);
    const [member] = [...result] as Array<{ name: string }>;
    expect(member).toBe([...state.value.tags][0]);
    member!.name = "b";
    expect(seen).toEqual(["a", "b"]);
  });

  it.each(["union", "intersection", "difference", "symmetricDifference"] as const)(
    "wraps receiver members for %s",
    (method) => {
      const a = { n: "a" };
      const b = { n: "b" };
      const state = deepCollectionSignal({ left: new Set([a, b]), right: new Set([a]) });
      const left = state.value.left as unknown as Composable;
      for (const other of [state.value.right, new Set([state.value.right.values().next().value])]) {
        for (const member of left[method](other)) {
          expect(member).toBe([...state.value.left].find((item) => item.n === (member as { n: string }).n));
        }
      }
    },
  );

  it("keeps the identity the argument held for members that only came from it", () => {
    const outsider = { n: "outsider" };
    const state = deepCollectionSignal({ left: new Set([{ n: "a" }]), right: new Set([{ n: "r" }]) });
    const left = state.value.left as unknown as Composable;
    // A plain Set of unrelated objects: they are not reactive state, so they stay raw.
    const result = left.union(new Set([outsider]));
    expect([...result].includes(outsider)).toBe(true);
    // A reactive collection's members are proxies.
    const fromReactive = [...left.union(state.value.right)];
    expect(fromReactive[1]).toBe([...state.value.right][0]);
    // A plain Set that holds proxies keeps those proxies.
    const proxyMember = [...state.value.right][0];
    const fromPlain = [...left.union(new Set([proxyMember]))];
    expect(fromPlain[1]).toBe(proxyMember);
  });
});

type Log = string[];

function instrument(
  log: Log,
  spec: {
    size?: unknown;
    sizeThrows?: boolean;
    has?: unknown;
    keys?: unknown;
    items?: unknown[];
    present?: unknown[];
    nextNonObject?: boolean;
    doneThrows?: boolean;
    valueThrows?: boolean;
    returnKind?: "absent" | "ok" | "non-object" | "throws";
    keysNonObject?: boolean;
  },
): object {
  const items = spec.items ?? [];
  const present = new Set(spec.present ?? items);
  const target = {
    get size() {
      log.push("get size");
      if (spec.sizeThrows) throw new RangeError("size boom");
      return "size" in spec ? spec.size : present.size;
    },
    get has() {
      log.push("get has");
      if ("has" in spec) return spec.has;
      return function (this: unknown, value: unknown) {
        log.push(`has(${String(value)}) this=${this === target}`);
        return present.has(value);
      };
    },
    get keys() {
      log.push("get keys");
      if ("keys" in spec) return spec.keys;
      return function (this: unknown) {
        log.push(`keys() this=${this === target}`);
        if (spec.keysNonObject) return 1;
        let index = 0;
        const iterator: Record<string, unknown> = {
          get next() {
            log.push("get next");
            return function (this: unknown) {
              log.push(`next() this=${this === iterator}`);
              if (spec.nextNonObject) return 1;
              const step = {
                get done() {
                  log.push("get done");
                  if (spec.doneThrows) throw new Error("done boom");
                  return index >= items.length;
                },
                get value() {
                  log.push("get value");
                  if (spec.valueThrows) throw new Error("value boom");
                  return items[index++];
                },
              };
              return step;
            };
          },
        };
        if (spec.returnKind !== "absent") {
          Object.defineProperty(iterator, "return", {
            get() {
              log.push("get return");
              return function () {
                log.push("return()");
                if (spec.returnKind === "throws") throw new Error("return boom");
                return spec.returnKind === "non-object" ? 1 : {};
              };
            },
          });
        }
        return iterator;
      };
    },
  };
  return target;
}

const METHODS = [
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
] as const;

function outcome(subject: Composable, method: (typeof METHODS)[number], other: unknown, log: Log): string {
  try {
    const result = subject[method](other) as unknown;
    return `ok ${result instanceof Set ? JSON.stringify([...result].sort()) : String(result)} | ${log.join("; ")}`;
  } catch (error) {
    return `throw ${(error as Error).constructor.name}:${(error as Error).message.startsWith("size boom") || /boom/.test((error as Error).message) ? (error as Error).message : ""} | ${log.join("; ")}`;
  }
}

describe("reactive Set set-like argument protocol matches native (C4)", () => {
  const specs: Array<[string, Parameters<typeof instrument>[1]]> = [
    ["plain", { items: [1, 2, 9] }],
    ["empty other", { items: [] }],
    ["superset other", { items: [1, 2, 3, 4] }],
    ["disjoint other", { items: [7, 8] }],
    ["single hit", { items: [3] }],
    ["size string", { size: "3", items: [1, 2, 9] }],
    ["size fractional", { size: 2.9, items: [1, 2] }],
    ["size -0.5", { size: -0.5, items: [] }],
    ["size Infinity", { size: Infinity, items: [1, 2, 3] }],
    ["size NaN", { size: NaN, items: [1] }],
    ["size undefined", { size: undefined, items: [1] }],
    ["size negative", { size: -1, items: [1] }],
    ["size -Infinity", { size: -Infinity, items: [1] }],
    ["size bigint", { size: 1n, items: [1] }],
    [
      "size object",
      {
        size: {
          valueOf() {
            return 2;
          },
        },
        items: [1, 2],
      },
    ],
    ["size throws", { sizeThrows: true, items: [1] }],
    ["has not callable", { has: 1, items: [1] }],
    ["has undefined", { has: undefined, items: [1] }],
    ["keys not callable", { keys: "x", items: [1] }],
    ["NaN size and bad has", { size: NaN, has: 1, items: [1] }],
    ["negative size and bad keys", { size: -3, keys: 1, items: [1] }],
    ["bad has and bad keys", { has: 1, keys: 1 }],
    ["keys returns non-object", { keysNonObject: true, items: [1] }],
    ["next returns non-object", { nextNonObject: true, items: [1] }],
    ["done throws", { doneThrows: true, items: [1] }],
    ["value throws", { valueThrows: true, items: [1] }],
    ["no return", { returnKind: "absent", items: [1, 2, 9] }],
    ["return non-object", { returnKind: "non-object", items: [1, 2, 9] }],
    ["return throws", { returnKind: "throws", items: [1, 2, 9] }],
    ["early stop with absent return", { returnKind: "absent", items: [9, 1, 2] }],
  ];

  for (const method of METHODS) {
    for (const [name, spec] of specs) {
      it(`${method}: ${name}`, () => {
        const nativeLog: Log = [];
        const reactiveLog: Log = [];
        const native = new Set([1, 2, 3]) as unknown as Composable;
        const reactive = deepCollectionSignal(new Set([1, 2, 3])).value as unknown as Composable;
        const expected = outcome(native, method, instrument(nativeLog, spec), nativeLog);
        const actual = outcome(reactive, method, instrument(reactiveLog, spec), reactiveLog);
        expect(actual).toBe(expected);
      });
    }
  }

  it("rejects non-object arguments like native", () => {
    for (const method of METHODS) {
      for (const other of [1, "x", undefined, null]) {
        const native = new Set([1]) as unknown as Composable;
        const reactive = deepCollectionSignal(new Set([1])).value as unknown as Composable;
        expect(() => reactive[method](other)).toThrow(TypeError);
        expect(() => native[method](other)).toThrow(TypeError);
      }
    }
  });

  it("reads done once per step and calls has once per member for user set-likes holding raw members", () => {
    const member = { n: 1 };
    const state = deepCollectionSignal({ s: new Set([member]) });
    const log: Log = [];
    const other = instrument(log, { items: [], present: [] });
    (state.value.s as unknown as Composable).isSubsetOf(other);
    expect(log.filter((line) => line.startsWith("has(")).length).toBe(0);
    const calls: unknown[] = [];
    (state.value.s as unknown as Composable).isSubsetOf({
      size: 5,
      has(value: unknown) {
        calls.push(value);
        return false;
      },
      keys: () => [][Symbol.iterator](),
    });
    expect(calls).toEqual([member]);
  });

  it("still matches proxies held by plain Sets and reactive collections", () => {
    const state = deepCollectionSignal({ s: new Set([{ n: 1 }, { n: 2 }]), t: new Set([{ n: 3 }]) });
    const s = state.value.s as unknown as Composable;
    expect(s.isSupersetOf(new Set(state.value.s))).toBe(true);
    expect(s.isSubsetOf(new Set(state.value.s))).toBe(true);
    expect(s.isDisjointFrom(state.value.t)).toBe(true);
    expect(s.isSubsetOf(state.value.s)).toBe(true);
  });
});

describe("collection carrier keys keep their first identity (C5)", () => {
  it("does not duplicate a Map key carrier after the caller mutates it", () => {
    const state = deepCollectionSignal({ users: [{ id: 1 }], map: new Map<object, string>() });
    const key: Record<string, unknown> = { user: state.value.users[0] };
    state.value.map.set(key, "first");
    key.note = "x";
    state.value.map.set(key, "second");
    expect(state.value.map.size).toBe(1);
    expect(state.value.map.get(key)).toBe("second");
    expect(state.value.map.has(key)).toBe(true);
    expect(state.value.map.delete(key)).toBe(true);
    expect(state.value.map.size).toBe(0);
  });

  it("does not duplicate a Set member carrier after the caller mutates it", () => {
    const state = deepCollectionSignal({ users: [{ id: 1 }], set: new Set<object>() });
    const member: Record<string, unknown> = { user: state.value.users[0] };
    state.value.set.add(member);
    member.note = "x";
    state.value.set.add(member);
    expect(state.value.set.size).toBe(1);
    expect(state.value.set.has(member)).toBe(true);
  });

  it("covers carriers normalized while initializing the collection", () => {
    const seed = deepCollectionSignal({ users: [{ id: 1 }] });
    const key: Record<string, unknown> = { user: seed.value.users[0] };
    const map = deepCollectionSignal(new Map<object, string>([[key, "first"]]));
    key.note = "x";
    map.value.set(key, "second");
    expect(map.value.size).toBe(1);
    expect(map.value.get(key)).toBe("second");
  });

  it("stores a fresh clone when the carrier was deleted and is re-added", () => {
    const state = deepCollectionSignal({ users: [{ id: 1 }], map: new Map<object, string>() });
    const key: Record<string, unknown> = { user: state.value.users[0] };
    state.value.map.set(key, "first");
    state.value.map.delete(key);
    key.note = "x";
    state.value.map.set(key, "again");
    expect(state.value.map.size).toBe(1);
    expect(state.value.map.get(key)).toBe("again");
    const [stored] = [...state.value.map.keys()] as Array<Record<string, unknown>>;
    expect(stored!.note).toBe("x");
  });

  it("still rejects an invalid new key", () => {
    const state = deepCollectionSignal({ map: new Map<object, number>() });
    const bad = {
      get accessor() {
        return 1;
      },
    };
    expect(() => state.value.map.set(bad, 1)).toThrow(TypeError);
  });
});

describe("Map.set on an existing key stays O(1) in the key graph (perf)", () => {
  it("does not re-walk an existing key or an unchanged value", () => {
    const state = deepCollectionSignal({ map: new Map<object, object>() });
    let node: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 1500; index++) node = { index, child: node };
    const key = node;
    const value = { v: key };
    state.value.map.set(key, value);
    const spy = vi.spyOn(Reflect, "getOwnPropertyDescriptor");
    try {
      for (let round = 0; round < 3; round++) state.value.map.set(key, value);
      expect(spy.mock.calls.length).toBeLessThan(50);
    } finally {
      spy.mockRestore();
    }
    expect(state.value.map.size).toBe(1);
  });
});

describe("getOrInsertComputed argument order (C6)", () => {
  const installed: Array<() => void> = [];
  afterEach(() => {
    while (installed.length > 0) installed.pop()?.();
  });

  // Node 22 has no native upsert methods; install a spec-shaped stand-in so the
  // reactive proxy exposes (and composes) the method.
  const install = (prototype: object) => {
    const record = prototype as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(prototype, "getOrInsertComputed");
    record.getOrInsertComputed = function () {
      throw new Error("native getOrInsertComputed must not run on the raw target");
    };
    installed.push(() => {
      if (had === undefined) delete record.getOrInsertComputed;
      else Object.defineProperty(prototype, "getOrInsertComputed", had);
    });
  };

  it("rejects an invalid WeakMap key before running the callback", () => {
    install(WeakMap.prototype);
    const weak = deepCollectionSignal(new WeakMap<object, number>()).value as unknown as {
      getOrInsertComputed(key: unknown, callback: () => number): number;
    };
    const callback = vi.fn(() => 1);
    for (const key of [1, "x", null, undefined, Symbol.for("registered")]) {
      expect(() => weak.getOrInsertComputed(key, callback)).toThrow(TypeError);
    }
    expect(callback).not.toHaveBeenCalled();
    const key = {};
    expect(weak.getOrInsertComputed(key, callback)).toBe(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes -0 to +0 before the callback sees the key", () => {
    install(Map.prototype);
    const map = deepCollectionSignal(new Map<number, string>()).value as unknown as Map<number, string> & {
      getOrInsertComputed(key: number, callback: (key: number) => string): string;
    };
    const keys: number[] = [];
    expect(
      map.getOrInsertComputed(-0, (key) => {
        keys.push(key);
        return "zero";
      }),
    ).toBe("zero");
    expect(Object.is(keys[0], 0)).toBe(true);
    expect(Object.is([...map.keys()][0], 0)).toBe(true);
    expect(
      map.getOrInsertComputed(0, () => {
        throw new Error("must hit");
      }),
    ).toBe("zero");
  });
});
