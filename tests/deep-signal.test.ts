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

    const nestedFrozen = deepSignal({ nested: Object.freeze({ value: 1 }) });
    expect(() => nestedFrozen.value.nested).toThrow();
    expect(() => {
      nestedFrozen.value.nested = Object.freeze({ value: 2 }) as never;
    }).toThrow();
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
});
