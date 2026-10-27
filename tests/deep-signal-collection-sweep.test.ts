import { describe, expect, it, vi } from "vitest";
import { createDeepSignalFactory } from "../src/core/deep-signal-engine.js";
import { createCollectionSupport } from "../src/core/deep-collections.js";
import type { DeepSignalRuntimeAdapter, DeepSignalSource } from "../src/core/deep-signal-engine.js";

const makeSource = <T>(initial: T): DeepSignalSource<T> => {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(next) {
      value = next;
    },
    peek() {
      return value;
    },
  };
};

function makeHarness() {
  const active = new Set<object>();
  const checked: object[] = [];
  const versions: object[] = [];
  const adapter: DeepSignalRuntimeAdapter = {
    createSignal: makeSource,
    createVersionSignal<T>(initial: T) {
      const source = makeSource(initial);
      versions.push(source);
      return source;
    },
    markWatched(source) {
      active.add(source);
    },
    hasSubscribers(source) {
      checked.push(source);
      return active.has(source);
    },
    batch: (callback) => callback(),
    untracked: (callback) => callback(),
    isSignal: () => false,
    hasActiveSubscriber: () => true,
    getBatchDepth: () => 0,
  };
  const factory = createDeepSignalFactory(adapter);
  const deepCollectionSignal = <T extends object>(initial: T) =>
    factory.deepCollectionSignal(initial, createCollectionSupport);
  return { ...factory, deepCollectionSignal, active, checked, versions };
}

describe("reactive collection metadata sweeps", () => {
  it("skips empty primitive metadata sweeps for unrelated collection mutations", () => {
    const harness = makeHarness();
    const map = harness.deepCollectionSignal(new Map<string, number>()).value;
    const set = harness.deepCollectionSignal(new Set<string>()).value;
    const weakMap = harness.deepCollectionSignal(new WeakMap<object, number>()).value;
    const weakSet = harness.deepCollectionSignal(new WeakSet<object>()).value;
    const key = {};
    const nativeEntries = Map.prototype.entries;
    let emptyEntriesCalls = 0;
    const entriesSpy = vi.spyOn(Map.prototype, "entries").mockImplementation(function (this: Map<unknown, unknown>) {
      if (this.size === 0) emptyEntriesCalls += 1;
      return Reflect.apply(nativeEntries, this, []);
    });
    try {
      map.set("entry", 1);
      set.add("member");
      weakMap.set(key, 1);
      weakSet.add(key);
    } finally {
      entriesSpy.mockRestore();
    }
    expect(emptyEntriesCalls).toBe(0);
  });

  it("cleans up large registered-symbol subscriptions after unsubscribe", async () => {
    const harness = makeHarness();
    const collection = harness.deepCollectionSignal(new Map<symbol, number>()).value;
    const keys = Array.from({ length: 300 }, (_, index) => Symbol.for(`cleanup-symbol-${index}`));
    for (const key of keys) collection.get(key);
    expect(harness.versions).toHaveLength(keys.length);

    collection.set(Symbol.for("first-symbol-mutation"), 1);
    expect(harness.checked).toHaveLength(128);
    const deadline = Date.now() + 2_000;
    while (harness.checked.length < keys.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(harness.checked).toHaveLength(keys.length);

    // All 300 simulated effect subscriptions now dispose. The next mutation
    // must sweep the remaining candidates asynchronously without retaining
    // their strong symbol keys indefinitely.
    harness.active.clear();
    collection.set(Symbol.for("second-symbol-mutation"), 1);
    const cleanupDeadline = Date.now() + 2_000;
    while (harness.checked.length < keys.length * 2 && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(harness.checked.length).toBeGreaterThanOrEqual(keys.length * 2);

    const beforeReuse = harness.versions.length;
    collection.get(keys[0]!);
    expect(harness.versions).toHaveLength(beforeReuse + 1);
  });

  it("bounds synchronous work and rechecks changed candidates before eventual cleanup", async () => {
    const harness = makeHarness();
    const collection = harness.deepCollectionSignal(new Map<string, number>()).value;
    for (let index = 0; index < 300; index += 1) collection.get(`key-${index}`);
    const retainedVersion = harness.versions[0]!;
    harness.active.clear();
    harness.active.add(retainedVersion);

    collection.set("trigger", 1);
    expect(harness.checked).toHaveLength(128);

    // Add a category to an already visited key, then append another key. Both
    // must be revisited before the sweep reports completion.
    collection.has("key-0");
    const retainedExistenceVersion = harness.versions.at(-1)!;
    harness.active.add(retainedExistenceVersion);
    collection.get("added-during-sweep");
    const addedVersion = harness.versions.at(-1)!;
    harness.active.delete(addedVersion);
    const initialCandidateCount = harness.versions.length;
    const deadline = Date.now() + 2_000;
    while (new Set(harness.checked).size < initialCandidateCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(new Set(harness.checked).size).toBe(initialCandidateCount);
    expect(harness.checked).toContain(addedVersion);
    expect(harness.checked).toContain(retainedExistenceVersion);

    const versionsAfterSweep = harness.versions.length;
    collection.get("key-0");
    collection.has("key-0");
    expect(harness.versions).toHaveLength(versionsAfterSweep);

    // Disposed candidates were removed. Re-reading one allocates a new source.
    collection.get("key-1");
    expect(harness.versions).toHaveLength(versionsAfterSweep + 1);

    // A subscribed key stays live through unrelated mutations; after its
    // subscriber disappears, the next sweep removes both categories.
    collection.set("another-mutation", 1);
    const withRetainedVersion = harness.versions.length;
    collection.get("key-0");
    collection.has("key-0");
    expect(harness.versions).toHaveLength(withRetainedVersion);
    harness.active.delete(retainedVersion);
    harness.active.delete(retainedExistenceVersion);
    collection.set("last-mutation", 1);
    const afterRetainedCleanup = harness.versions.length;
    collection.get("key-0");
    collection.has("key-0");
    expect(harness.versions).toHaveLength(afterRetainedCleanup + 2);
  });
});
