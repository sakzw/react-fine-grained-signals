import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
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
