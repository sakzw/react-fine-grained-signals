import { describe, expect, it } from "vitest";
import { createDeepSignalFactory } from "../src/core/deep-signal-engine.js";
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

/** Watched (read since the last write) and linked (a committed subscriber) are tracked separately. */
function makeHarness() {
  const watched = new Set<object>();
  const linked = new Set<object>();
  const versions: object[] = [];
  const adapter: DeepSignalRuntimeAdapter = {
    createSignal: makeSource,
    createVersionSignal<T>(initial: T) {
      const source = makeSource(initial);
      versions.push(source);
      return source;
    },
    markWatched(source) {
      watched.add(source);
    },
    hasSubscribers: (source) => watched.has(source),
    hasLinkedSubscribers: (source) => linked.has(source),
    batch: (callback) => callback(),
    untracked: (callback) => callback(),
    isSignal: () => false,
    hasActiveSubscriber: () => true,
    getBatchDepth: () => 0,
  };
  return { ...createDeepSignalFactory(adapter), watched, linked, versions };
}

const settle = async (rounds = 20) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe("deep property metadata sweeps", () => {
  it("revisits candidates an unsettled chunk kept, like the collection sweep", async () => {
    const harness = makeHarness();
    const state = harness.deepSignal({ present: 0 } as Record<string, number | undefined>);
    const keys = Array.from({ length: 300 }, (_, index) => `missing-${index}`);
    // Committed readers: the settled sweep the reads schedule keeps every key.
    for (const key of keys) state.value[key];
    for (const version of harness.versions) harness.linked.add(version);
    await settle();
    const allocated = harness.versions.length;
    for (const key of keys) state.value[key];
    expect(harness.versions).toHaveLength(allocated);

    // The readers unsubscribe, but the keys were read again by a render that
    // never commits: watched, not linked. A write runs the synchronous chunk,
    // which defers its first 128 candidates; later chunks resume in tasks.
    harness.linked.clear();
    state.value.present = 1;
    await settle();

    // Every key was dropped, the first chunk's included: re-reading allocates.
    state.value[keys[0]!];
    expect(harness.versions.length).toBeGreaterThan(allocated);
  });
});
