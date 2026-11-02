import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { deepCollectionSignal, deepSignal } from "../src/index.js";

describe("deep signal errors name the API the state belongs to", () => {
  it("names deepSignal() for plain deep state", () => {
    const state = deepSignal({ a: 1 });
    expect(() => Object.setPrototypeOf(state.value, null)).toThrow(
      /^deepSignal\(\) does not support prototype mutation$/,
    );
    expect(() =>
      deepSignal({
        get a() {
          return 1;
        },
      }),
    ).toThrow(/^deepSignal\(\) does not support accessor properties$/);
  });

  it("names deepCollectionSignal() for collection-mode state, plain objects included", () => {
    const state = deepCollectionSignal({ map: new Map<string, number>(), plain: { a: 1 } });
    expect(() => Object.setPrototypeOf(state.value.plain, null)).toThrow(
      /^deepCollectionSignal\(\) does not support prototype mutation$/,
    );
    expect(() => Object.setPrototypeOf(state.value.map, null)).toThrow(
      /^deepCollectionSignal\(\) does not support prototype mutation$/,
    );
    expect(() => {
      (state.value.map as unknown as Record<string, unknown>).extra = 1;
    }).toThrow(/^deepCollectionSignal\(\) reactive collections do not support own properties$/);
    expect(() =>
      deepCollectionSignal({
        get a() {
          return 1;
        },
      }),
    ).toThrow(/^deepCollectionSignal\(\) does not support accessor properties$/);
  });

  it("points a collection root from another realm at deepCollectionSignal()", () => {
    const foreign = runInNewContext("new Map()") as object;
    expect(() => deepSignal(foreign as never)).toThrow(/use deepCollectionSignal\(\) for a collection root/);
  });
});

describe("array searches and collection lookups share one identity rule", () => {
  it("finds a stored carrier again with includes/indexOf, as Set.has does", () => {
    const state = deepCollectionSignal({ inner: { id: 1 }, list: [] as object[], set: new Set<object>() });
    const carrier = { inner: state.value.inner };
    state.value.list.push(carrier);
    state.value.set.add(carrier);
    expect(state.value.set.has(carrier)).toBe(true);
    expect(state.value.list.includes(carrier)).toBe(true);
    expect(state.value.list.indexOf(carrier)).toBe(0);
    expect(state.value.list.lastIndexOf(carrier)).toBe(0);
  });

  it("does the same in plain deepSignal state", () => {
    const state = deepSignal({ inner: { id: 1 }, list: [] as object[] });
    const carrier = { inner: state.value.inner };
    state.value.list.push(carrier);
    expect(state.value.list.indexOf(carrier)).toBe(0);
  });
});

describe("one collection test for both modes", () => {
  it("stores empty null-prototype dictionaries without probing collection brands", () => {
    // Telling one from a Map whose prototype was set to null would take four
    // throwing internal-slot probes per dictionary; plain objects skip them.
    const probes = vi.spyOn(Map.prototype, "has");
    try {
      const state = deepSignal({ dicts: [] as Record<string, number>[] });
      state.value.dicts = Array.from({ length: 100 }, () => Object.create(null) as Record<string, number>);
      state.value.dicts[0]!.a = 1;
      expect(state.value.dicts[0]!.a).toBe(1);
      expect(probes).not.toHaveBeenCalled();
    } finally {
      probes.mockRestore();
    }
  });

  it("finds a deep proxy inside a Map from another realm in plain mode", () => {
    const state = deepSignal({ inner: { id: 1 }, opaque: undefined as unknown });
    const foreign = runInNewContext("new Map()") as Map<string, unknown>;
    Map.prototype.set.call(foreign, "inner", state.value.inner);
    expect(() => {
      state.value.opaque = foreign;
    }).toThrow(/^deepSignal\(\) cannot store a deep proxy inside an opaque value$/);
    const local = new Map<string, unknown>([["inner", state.value.inner]]);
    expect(() => {
      state.value.opaque = local;
    }).toThrow(/cannot store a deep proxy inside an opaque value/);
  });
});
