import { describe, expect, it } from "vitest";
import { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";

describe("Prototype A deepSignal", () => {
  it("tracks fine-grained nested reads, dynamic branches, and root replacement", () => {
    const runtime = createLeanRuntime(() => undefined);
    const state = runtime.deepSignal({ left: { name: "L", age: 1 }, right: { name: "R", age: 2 }, extra: 0 });
    const chooseLeft = runtime.signal(true);
    const seen: string[] = [];
    runtime.effect(() => { seen.push(chooseLeft.value ? state.value.left.name : state.value.right.name); });
    state.value.left.age += 1;
    state.value.extra += 1;
    state.value.left.name = "L2";
    chooseLeft.value = false;
    state.value.left.name = "stale";
    state.value.right.name = "R2";
    expect(seen).toEqual(["L", "L2", "R", "R2"]);
    const oldRoot = state.value;
    state.value = { left: { name: "new-L", age: 0 }, right: { name: "new-R", age: 0 }, extra: 0 };
    oldRoot.right.name = "old-root";
    expect(seen.at(-1)).toBe("new-R");
    expect(state.value.left).toBe(state.value.left);
  });

  it("tracks property existence and iteration only for structural changes", () => {
    const runtime = createLeanRuntime(() => undefined);
    const state = runtime.deepSignal({ present: 1, sibling: 0 });
    const existence: boolean[] = [];
    const keys: string[][] = [];
    runtime.effect(() => { existence.push("optional" in state.value); });
    runtime.effect(() => { keys.push(Reflect.ownKeys(state.value).map(String)); });
    state.value.present = 2;
    state.value.sibling = 1;
    (state.value as Record<string, unknown>).optional = true;
    (state.value as Record<string, unknown>).optional = false;
    delete (state.value as Record<string, unknown>).optional;
    expect(existence).toEqual([false, true, false]);
    expect(keys).toEqual([ ["present", "sibling"], ["present", "sibling", "optional"], ["present", "sibling"] ]);
  });

  it("tracks descriptors, wraps nested values, and preserves aliases", () => {
    const runtime = createLeanRuntime(() => undefined);
    const child = { count: 1 };
    const state = runtime.deepSignal({ first: child, second: child });
    const seen: number[] = [];
    runtime.effect(() => { seen.push(Object.getOwnPropertyDescriptor(state.value, "first")?.value.count); });
    expect(state.value.first).toBe(state.value.second);
    state.value.first.count = 2;
    expect(seen).toEqual([1, 2]);
    expect(Object.getOwnPropertyDescriptors(state.value).first?.value).toBe(state.value.first);
  });

  it("handles array indices, truncation, mutators, and sparse metadata", () => {
    const runtime = createLeanRuntime(() => undefined);
    const state = runtime.deepSignal(["a", "b", "c", "d"]);
    const seen: Array<[string | undefined, number]> = [];
    runtime.effect(() => { seen.push([state.value[3], state.value.length]); });
    state.value.length = 2;
    expect(seen).toEqual([["d", 4], [undefined, 2]]);
    expect(runtime.inspectDeepSignalMetadata(state.peek())?.propertyIndices).toEqual([3]);
    state.value.push("e");
    expect(seen.at(-1)).toEqual([undefined, 3]);
    state.value.splice(0, 1);
    expect(state.value.join(",")).toBe("b,e");
    state.value.unshift("z");
    expect(state.value.shift()).toBe("z");
  });

  it("keeps prototype reads lazy and untracked/peek reads out of dependencies", () => {
    const runtime = createLeanRuntime(() => undefined);
    const raw = { items: [1, 2], user: { name: "Ada" } };
    const state = runtime.deepSignal(raw);
    for (let index = 0; index < 10; index += 1) {
      state.value.items.map((value) => value);
      state.value.items[Symbol.iterator];
      state.value.user.toString;
    }
    expect(runtime.inspectDeepSignalMetadata(state.peek())?.properties).toEqual([]);
    let runs = 0;
    runtime.effect(() => { runtime.untracked(() => state.value.user.name); runs += 1; });
    state.value.user.name = "Grace";
    expect(runs).toBe(1);
    state.peek().user.name;
    expect(runtime.inspectDeepSignalMetadata(state.peek().user)?.properties).toEqual([]);
  });

  it("prunes removed property metadata after stale graph links are gone", () => {
    const runtime = createLeanRuntime(() => undefined);
    const state = runtime.deepSignal({ removed: 1, stable: 0 });
    const useRemoved = runtime.signal(true);
    const dispose = runtime.effect(() => { useRemoved.value ? state.value.removed : state.value.stable; });
    useRemoved.value = false;
    delete (state.value as Record<string, unknown>).removed;
    expect(runtime.inspectDeepSignalMetadata(state.peek())?.properties).not.toContain("removed");
    dispose();
  });

  it("owns metadata caches per runtime even when both wrap the same raw input", () => {
    const first = createLeanRuntime(() => undefined);
    const second = createLeanRuntime(() => undefined);
    const raw = { value: 1 };
    const firstState = first.deepSignal(raw);
    const secondState = second.deepSignal(raw);
    first.effect(() => { firstState.value.value; });
    expect(first.inspectDeepSignalMetadata(firstState.peek())?.properties).toEqual(["value"]);
    expect(second.inspectDeepSignalMetadata(secondState.peek())?.properties).toEqual([]);
    expect(firstState.value).not.toBe(secondState.value);
  });

  it("uses Object.is for key notifications and leaves raw mutations unobserved", () => {
    const runtime = createLeanRuntime(() => undefined);
    const child = {};
    const raw = { zero: 0, nan: Number.NaN, child };
    const state = runtime.deepSignal(raw);
    let runs = 0;
    runtime.effect(() => { state.value.zero; state.value.nan; state.value.child; runs += 1; });
    raw.zero = 1;
    expect(runs).toBe(1);
    state.value.zero = -0;
    state.value.nan = Number.NaN;
    state.value.child = child;
    expect(runs).toBe(2);
  });

  it("keeps Map and Set as readonly opaque views", () => {
    const runtime = createLeanRuntime(() => undefined);
    const state = runtime.deepSignal({ map: new Map([["k", { value: 1 }]]), set: new Set(["a"]) });
    expect(state.value.map.get("k")).toEqual({ value: 1 });
    expect(() => (state.value.map as Map<string, unknown>).set("x", 1)).toThrow(TypeError);
    expect(() => (state.value.set as Set<string>).add("b")).toThrow(TypeError);
    let runs = 0;
    runtime.effect(() => { state.value.map; runs += 1; });
    state.value.map = new Map([["k", { value: 2 }]]);
    expect(runs).toBe(2);
  });
});
