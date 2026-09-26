// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import React from "react";
import {
  attachReadableInterop,
  getReadableInterop,
  getSharedInteropContext,
  READABLE_INTEROP_V1,
  withInteropSpeculativeMode,
  withoutInteropSpeculativeMode,
  type ReadableInteropV1,
} from "../../src/core/interop.js";
import { useSignalTracking } from "../../src/react/use-signals.js";
import { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function instrumentForeignReadable<T>(source: { readonly value: T }, onSubscribe?: () => void) {
  const sourceProtocol = getReadableInterop(source)!;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  let listenerCount = 0;
  const protocol: ReadableInteropV1 = {
    version: 1,
    runtimeToken: sourceProtocol.runtimeToken,
    getRevision: () => sourceProtocol.getRevision(),
    subscribe(listener) {
      subscribeCount += 1;
      listenerCount += 1;
      const subscription = sourceProtocol.subscribe(listener);
      onSubscribe?.();
      return {
        revision: subscription.revision,
        unsubscribe() {
          unsubscribeCount += 1;
          listenerCount -= 1;
          subscription.unsubscribe();
        },
      };
    },
  };
  const readable = Object.defineProperty({}, "value", { get() {
    const observedRevision = sourceProtocol.getRevision();
    const context = getSharedInteropContext();
    const graphCollector = context.graphCollector;
    context.graphCollector = undefined;
    let value: T;
    try {
      value = source.value;
    } finally {
      context.graphCollector = graphCollector;
    }
    graphCollector?.add(protocol, observedRevision);
    return value;
  } });
  attachReadableInterop(readable, protocol);
  return {
    readable: readable as { readonly value: T },
    get subscribeCount() { return subscribeCount; },
    get unsubscribeCount() { return unsubscribeCount; },
    get listenerCount() { return listenerCount; },
  };
}

describe("Prototype A cross-runtime interop", () => {
  it("restores nested shared speculative depth when suspended durable work throws", () => {
    const context = getSharedInteropContext();
    const baseline = context.speculativeDepth;
    expect(() => withInteropSpeculativeMode(() => {
      expect(context.speculativeDepth).toBe(baseline + 1);
      withInteropSpeculativeMode(() => {
        expect(context.speculativeDepth).toBe(baseline + 2);
        expect(() => withoutInteropSpeculativeMode(() => {
          expect(context.speculativeDepth).toBe(0);
          withInteropSpeculativeMode(() => {
            expect(context.speculativeDepth).toBe(1);
            throw new Error("nested failure");
          });
        })).toThrow("nested failure");
        expect(context.speculativeDepth).toBe(baseline + 2);
      });
    })).not.toThrow();
    expect(context.speculativeDepth).toBe(baseline);
  });

  it("attaches one stable non-enumerable V1 protocol per readable and unique runtime tokens", () => {
    const first = createLeanRuntime();
    const second = createLeanRuntime();
    const source = first.signal(1);
    const computed = first.computed(() => source.value + 1);
    const sourceProtocol = getReadableInterop(source)!;
    const computedProtocol = getReadableInterop(computed)!;
    expect(sourceProtocol.getRevision()).toBe(0);
    expect(sourceProtocol.version).toBe(1);
    expect(sourceProtocol).toBe(getReadableInterop(source));
    expect(computedProtocol).toBe(getReadableInterop(computed));
    expect(sourceProtocol.runtimeToken).toBe(computedProtocol.runtimeToken);
    expect(sourceProtocol.runtimeToken).not.toBe(getReadableInterop(second.signal(1))!.runtimeToken);
    expect(Object.getOwnPropertyDescriptor(source, READABLE_INTEROP_V1)?.enumerable).toBe(false);
    expect(Object.keys(source)).not.toContain(String(READABLE_INTEROP_V1));
    expect(Reflect.ownKeys({ ...source })).not.toContain(READABLE_INTEROP_V1);
  });

  it("tracks foreign source writes and prunes dynamic branches", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const chooseLeft = runtimeA.signal(true);
    const left = runtimeB.signal("left");
    const right = runtimeB.signal("right");
    const seen: string[] = [];
    const dispose = runtimeA.effect(() => { seen.push(chooseLeft.value ? left.value : right.value); });
    expect(seen).toEqual(["left"]);
    left.value = "left-2";
    expect(seen).toEqual(["left", "left-2"]);
    chooseLeft.value = false;
    expect(seen).toEqual(["left", "left-2", "right"]);
    left.value = "stale";
    expect(seen).toEqual(["left", "left-2", "right"]);
    right.value = "right-2";
    expect(seen).toEqual(["left", "left-2", "right", "right-2"]);
    dispose();
  });

  it("suspends a foreign speculative scope while a durable effect tracks deep state", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const trigger = runtimeB.signal(0);
    const state = runtimeB.deepSignal({ user: { name: "Ada" } });
    const seen: Array<[number, string]> = [];
    runtimeB.effect(() => { seen.push([trigger.value, state.value.user.name]); });
    const epoch = getSharedInteropContext().speculativeDeepReadEpoch;
    let shouldTrigger = true;
    const evaluate = vi.fn(() => {
      if (shouldTrigger) {
        shouldTrigger = false;
        trigger.value = 1;
      }
      return 9;
    });
    const outer = runtimeA.computed(evaluate);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return React.createElement("output", { "aria-label": "foreign-deep-scope" }, outer.value);
    }
    render(React.createElement(Reader));
    expect(seen).toEqual([[0, "Ada"], [1, "Ada"]]);
    expect(getSharedInteropContext().speculativeDeepReadEpoch).toBe(epoch);
    act(() => { state.value.user.name = "Grace"; });
    expect(seen).toEqual([[0, "Ada"], [1, "Ada"], [1, "Grace"]]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    expect(getSharedInteropContext().speculativeDeepReadEpoch).toBe(epoch);
  });

  it("preserves foreign source Object.is and semantic batch notification boundaries", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(0);
    const protocol = getReadableInterop(source)!;
    const seen: number[] = [];
    const dispose = runtimeA.effect(() => { seen.push(source.value); });
    source.value = -0;
    expect(seen).toHaveLength(2);
    expect(protocol.getRevision()).toBe(1);
    runtimeB.batch(() => { source.value = 1; source.value = -0; });
    expect(seen).toHaveLength(2);
    expect(protocol.getRevision()).toBe(3);
    source.value = Number.NaN;
    source.value = Number.NaN;
    expect(protocol.getRevision()).toBe(4);
    expect(seen).toHaveLength(3);
    expect(Number.isNaN(seen[2])).toBe(true);
    dispose();
  });

  it("pulls cold foreign-dependent computed chains fresh", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(1);
    const foreign = instrumentForeignReadable(source);
    const inner = runtimeA.computed(() => foreign.readable.value * 2);
    const outer = runtimeA.computed(() => inner.value + 1);
    expect(outer.value).toBe(3);
    expect(foreign.subscribeCount).toBe(0);
    source.value = 4;
    expect(outer.value).toBe(9);
    expect(foreign.subscribeCount).toBe(0);
  });

  it("keeps a foreign computed equality boundary", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(1);
    const parity = runtimeB.computed(() => source.value % 2);
    const seen: number[] = [];
    const dispose = runtimeA.effect(() => { seen.push(parity.value); });
    source.value = 3;
    expect(seen).toEqual([1]);
    source.value = 4;
    expect(seen).toEqual([1, 0]);
    dispose();
  });

  it("keeps an errored foreign computed subscribed and recovers", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(1);
    const firstError = new Error("foreign first error");
    const secondError = new Error("foreign second error");
    const derived = runtimeB.computed(() => {
      if (source.value === 2) throw firstError;
      if (source.value === 3) throw secondError;
      return source.value;
    });
    const seen: Array<number | string> = [];
    const dispose = runtimeA.effect(() => {
      try { seen.push(derived.value); }
      catch (error) { seen.push(error === firstError ? "first" : "second"); }
    });
    source.value = 2;
    source.value = 3;
    source.value = 4;
    expect(seen).toEqual([1, "first", "second", 4]);
    expect(getReadableInterop(derived)!.getRevision()).toBe(3);
    dispose();
  });

  it("does not track foreign reads performed through untracked or peek", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(1);
    const derived = runtimeB.computed(() => source.value * 2);
    let runs = 0;
    const dispose = runtimeA.effect(() => {
      runs += 1;
      runtimeA.untracked(() => source.value);
      derived.peek();
    });
    source.value = 2;
    expect(runs).toBe(1);
    dispose();
  });

  it("shares one ExternalNode subscription across local consumers and releases it at zero", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeToken = {};
    let value = 1;
    let revision = 0;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const listeners = new Set<(revision: number) => void>();
    const protocol: ReadableInteropV1 = {
      version: 1,
      runtimeToken,
      getRevision: () => revision,
      subscribe(listener) {
        subscribeCount += 1;
        listeners.add(listener);
        return {
          revision,
          unsubscribe() {
            unsubscribeCount += 1;
            listeners.delete(listener);
          },
        };
      },
    };
    const foreign = Object.defineProperty({
      get value() {
        getSharedInteropContext().graphCollector?.add(protocol, revision);
        return value;
      },
    }, "value", { enumerable: true, configurable: true, get() {
      getSharedInteropContext().graphCollector?.add(protocol, revision);
      return value;
    } });
    attachReadableInterop(foreign, protocol);
    const firstSeen: number[] = [];
    const secondSeen: number[] = [];
    const disposeFirst = runtimeA.effect(() => { firstSeen.push(Reflect.get(foreign, "value")); });
    const disposeSecond = runtimeA.effect(() => { secondSeen.push(Reflect.get(foreign, "value")); });
    expect(subscribeCount).toBe(1);
    value = 2;
    revision += 1;
    for (const listener of Array.from(listeners)) listener(revision);
    expect(firstSeen).toEqual([1, 2]);
    expect(secondSeen).toEqual([1, 2]);
    disposeFirst();
    expect(unsubscribeCount).toBe(0);
    disposeSecond();
    expect(unsubscribeCount).toBe(1);
  });

  it("invalidates a read-to-subscribe revision race", () => {
    const runtime = createLeanRuntime(() => undefined);
    const runtimeToken = {};
    let value = 1;
    let revision = 4;
    let raceOnce = true;
    const listeners = new Set<(revision: number) => void>();
    const protocol: ReadableInteropV1 = {
      version: 1,
      runtimeToken,
      getRevision: () => revision,
      subscribe(listener) {
        listeners.add(listener);
        if (raceOnce) {
          raceOnce = false;
          value = 2;
          revision += 1;
        }
        return { revision, unsubscribe: () => { listeners.delete(listener); } };
      },
    };
    const foreign = Object.defineProperty({}, "value", { get() {
      const observedValue = value;
      const observedRevision = revision;
      getSharedInteropContext().graphCollector?.add(protocol, observedRevision);
      return observedValue;
    } });
    attachReadableInterop(foreign, protocol);
    const seen: number[] = [];
    const dispose = runtime.effect(() => { seen.push(Reflect.get(foreign, "value")); });
    expect(seen).toEqual([1, 2]);
    dispose();
  });

  it("tracks foreign source and computed reads in an actual React component", () => {
    const runtimeB = createLeanRuntime(() => undefined);
    const source = runtimeB.signal(1);
    const doubled = runtimeB.computed(() => source.value * 2);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return React.createElement("output", { "aria-label": "foreign-react" }, doubled.value);
    }
    render(React.createElement(Reader));
    expect(screen.getByLabelText("foreign-react").textContent).toBe("2");
    act(() => { source.value = 2; });
    expect(screen.getByLabelText("foreign-react").textContent).toBe("4");
    expect(renders.mock.calls.length).toBeGreaterThan(1);
  });

  it("activates a newly foreign dependency of an already-live computed in React", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const chooseForeign = runtimeA.signal(false);
    const local = runtimeA.signal(1);
    const foreignSource = runtimeB.signal(10);
    const foreign = instrumentForeignReadable(foreignSource);
    const selected = runtimeA.computed(() => chooseForeign.value ? foreign.readable.value : local.value);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return React.createElement("output", { "aria-label": "dynamic-foreign" }, selected.value);
    }
    render(React.createElement(Reader));
    expect(screen.getByLabelText("dynamic-foreign").textContent).toBe("1");
    expect(foreign.subscribeCount).toBe(0);
    act(() => { chooseForeign.value = true; });
    expect(screen.getByLabelText("dynamic-foreign").textContent).toBe("10");
    expect(foreign.subscribeCount).toBe(1);
    act(() => { foreignSource.value = 11; });
    expect(screen.getByLabelText("dynamic-foreign").textContent).toBe("11");
    expect(renders.mock.calls.length).toBeGreaterThan(2);
  });

  it("activates, releases, and reactivates foreign liveness through a live protocol-watched computed chain", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const runtimeC = createLeanRuntime(() => undefined);
    const chooseForeign = runtimeA.signal(false);
    const local = runtimeA.signal(1);
    const foreignSource = runtimeB.signal(10);
    const foreign = instrumentForeignReadable(foreignSource);
    const inner = runtimeA.computed(() => chooseForeign.value ? foreign.readable.value : local.value);
    const outer = runtimeA.computed(() => inner.value + 1);
    const seen: number[] = [];
    const dispose = runtimeC.effect(() => { seen.push(outer.value); });
    expect(seen).toEqual([2]);
    expect(foreign.subscribeCount).toBe(0);

    chooseForeign.value = true;
    expect(seen).toEqual([2, 11]);
    expect(foreign.subscribeCount).toBe(1);
    expect(foreign.listenerCount).toBe(1);
    foreignSource.value = 11;
    expect(seen).toEqual([2, 11, 12]);

    chooseForeign.value = false;
    expect(seen).toEqual([2, 11, 12, 2]);
    expect(foreign.unsubscribeCount).toBe(1);
    expect(foreign.listenerCount).toBe(0);
    const runsAfterLocalBranch = seen.length;
    foreignSource.value = 12;
    expect(seen).toHaveLength(runsAfterLocalBranch);

    chooseForeign.value = true;
    expect(foreign.subscribeCount).toBe(2);
    foreignSource.value = 13;
    expect(seen.at(-1)).toBe(14);
    dispose();
    expect(foreign.unsubscribeCount).toBe(2);
    expect(foreign.listenerCount).toBe(0);
  });

  it("swaps live subscriptions from foreign B to foreign C and prunes the inactive branch", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const runtimeC = createLeanRuntime(() => undefined);
    const chooseB = runtimeA.signal(true);
    const leftSource = runtimeB.signal("B1");
    const rightSource = runtimeC.signal("C1");
    const left = instrumentForeignReadable(leftSource);
    const right = instrumentForeignReadable(rightSource);
    const selected = runtimeA.computed(() => chooseB.value ? left.readable.value : right.readable.value);
    const seen: string[] = [];
    const dispose = runtimeA.effect(() => { seen.push(selected.value); });
    expect(seen).toEqual(["B1"]);
    expect([left.subscribeCount, right.subscribeCount]).toEqual([1, 0]);

    chooseB.value = false;
    expect(seen).toEqual(["B1", "C1"]);
    expect([left.unsubscribeCount, right.subscribeCount]).toEqual([1, 1]);
    leftSource.value = "B-stale";
    expect(seen).toEqual(["B1", "C1"]);
    rightSource.value = "C2";
    expect(seen).toEqual(["B1", "C1", "C2"]);

    dispose();
    expect([left.subscribeCount, left.unsubscribeCount, left.listenerCount]).toEqual([1, 1, 0]);
    expect([right.subscribeCount, right.unsubscribeCount, right.listenerCount]).toEqual([1, 1, 0]);
  });

  it("retains read-to-subscribe race invalidation when a live local branch becomes foreign", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const chooseForeign = runtimeA.signal(false);
    const local = runtimeA.signal(1);
    const foreignSource = runtimeB.signal(10);
    let race = true;
    const foreign = instrumentForeignReadable(foreignSource, () => {
      if (race) {
        race = false;
        foreignSource.value = 11;
      }
    });
    const selected = runtimeA.computed(() => chooseForeign.value ? foreign.readable.value : local.value);
    const seen: number[] = [];
    const dispose = runtimeA.effect(() => { seen.push(selected.value); });
    chooseForeign.value = true;
    expect(seen.at(-1)).toBe(11);
    expect(foreign.subscribeCount).toBe(1);
    expect(foreign.listenerCount).toBe(1);
    dispose();
    expect(foreign.unsubscribeCount).toBe(1);
    expect(foreign.listenerCount).toBe(0);
  });

  it("makes speculative foreign dependencies live when the cached graph is promoted", () => {
    const runtimeA = createLeanRuntime(() => undefined);
    const runtimeB = createLeanRuntime(() => undefined);
    const foreignSource = runtimeB.signal(4);
    const foreign = instrumentForeignReadable(foreignSource);
    const selected = runtimeA.computed(() => foreign.readable.value * 2);
    const candidate = runtimeA.speculate(() => selected.value);
    expect(candidate.value).toBe(8);
    expect(candidate.isCurrent()).toBe(true);
    expect(foreign.subscribeCount).toBe(0);
    const seen: number[] = [];
    const dispose = runtimeA.effect(() => { seen.push(selected.value); });
    expect(seen).toEqual([8]);
    expect(foreign.subscribeCount).toBe(1);
    foreignSource.value = 5;
    expect(seen).toEqual([8, 10]);
    dispose();
    expect(foreign.unsubscribeCount).toBe(1);
  });

  it("tracks foreign deep properties through the shared per-key protocol", () => {
    const localRuntime = createLeanRuntime(() => undefined);
    const foreignRuntime = createLeanRuntime(() => undefined);
    const state = foreignRuntime.deepSignal({ user: { name: "Ada", age: 1 } });
    const rootProtocol = getReadableInterop(state)!;
    const initialRootRevision = rootProtocol.getRevision();
    const seen: string[] = [];
    const dispose = localRuntime.effect(() => { seen.push(state.value.user.name); });
    state.value.user.age = 2;
    state.value.user.name = "Grace";
    expect(rootProtocol.getRevision()).toBe(initialRootRevision);
    expect(seen).toEqual(["Ada", "Grace"]);
    state.value = { user: { name: "Lin", age: 3 } };
    expect(rootProtocol.getRevision()).toBeGreaterThan(initialRootRevision);
    expect(seen).toEqual(["Ada", "Grace", "Lin"]);
    dispose();
    state.value.user.name = "stale";
    expect(seen).toHaveLength(3);
  });

  it("tracks foreign existence and iteration through their own version protocols", () => {
    const localRuntime = createLeanRuntime(() => undefined);
    const foreignRuntime = createLeanRuntime(() => undefined);
    const state = foreignRuntime.deepSignal({ value: 0 });
    const existence: boolean[] = [];
    const keys: string[][] = [];
    localRuntime.effect(() => { existence.push("optional" in state.value); });
    localRuntime.effect(() => { keys.push(Reflect.ownKeys(state.value).map(String)); });
    (state.value as Record<string, unknown>).optional = 1;
    (state.value as Record<string, unknown>).optional = 2;
    delete (state.value as Record<string, unknown>).optional;
    expect(existence).toEqual([false, true, false]);
    expect(keys).toEqual([["value"], ["value", "optional"], ["value"]]);
  });

  it("keeps foreign deep untracked and peek reads outside local dependencies", () => {
    const localRuntime = createLeanRuntime(() => undefined);
    const foreignRuntime = createLeanRuntime(() => undefined);
    const state = foreignRuntime.deepSignal({ user: { name: "Ada" } });
    let runs = 0;
    localRuntime.effect(() => {
      localRuntime.untracked(() => state.value.user.name);
      state.peek().user.name;
      runs += 1;
    });
    state.value.user.name = "Grace";
    expect(runs).toBe(1);
  });

  it("tracks foreign deep properties in Prototype A React renders", () => {
    const localRuntime = createLeanRuntime(() => undefined);
    const foreignRuntime = createLeanRuntime(() => undefined);
    const state = foreignRuntime.deepSignal({ user: { name: "Ada" } });
    const computed = localRuntime.computed(() => state.value.user.name);
    const renders = vi.fn();
    function Reader() {
      useSignalTracking();
      renders();
      return React.createElement("output", { "aria-label": "foreign-deep" }, computed.value);
    }
    render(React.createElement(Reader));
    act(() => { state.value.user.name = "Grace"; });
    expect(screen.getByLabelText("foreign-deep").textContent).toBe("Grace");
    expect(renders).toHaveBeenCalledTimes(2);
  });
});
