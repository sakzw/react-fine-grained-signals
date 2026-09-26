// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import React from "react";
import {
  attachReadableInterop,
  getReadableInterop,
  getSharedInteropContext,
  READABLE_INTEROP_V1,
  type ReadableInteropV1,
} from "../../src/core/interop.js";
import { useSignalTracking } from "../../src/react/use-signals.js";
import { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Prototype A cross-runtime interop", () => {
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
    const inner = runtimeA.computed(() => source.value * 2);
    const outer = runtimeA.computed(() => inner.value + 1);
    expect(outer.value).toBe(3);
    source.value = 4;
    expect(outer.value).toBe(9);
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
});
