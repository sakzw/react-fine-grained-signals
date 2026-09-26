// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSignalTracking } from "../../src/react/hooks.js";
import { READABLE_INTEROP_V1 } from "../../src/core/interop.js";
import { SIGNAL_BRAND } from "../../src/core/signal-brand.js";
import { computed as productionComputed, signal as productionSignal } from "../../src/index.js";
import { createCandidateA, createCandidateB, createCandidateC, createCandidateC1 } from "./fixtures/candidates.js";

const candidates = [
  ["A: wrapper control", createCandidateA],
  ["B: direct existing runtime", createCandidateB],
  ["C: hidden node prototype", createCandidateC],
  ["C1: private-node class + deep liveness", createCandidateC1],
] as const;

afterEach(cleanup);

function summarizeKeys(value: object) {
  return {
    keys: Object.keys(value),
    names: Object.getOwnPropertyNames(value),
    symbols: Object.getOwnPropertySymbols(value).map(String),
    prototypeNames: Object.getOwnPropertyNames(Object.getPrototypeOf(value)),
  };
}

describe.each(candidates)("Phase 6 %s", (_name, create) => {
  it("preserves writable, computed, Object.is, brand, and V1 behavior", () => {
    const api = create();
    const value = api.signal(Number.NaN);
    expect(value.value).toBeNaN();
    expect(api.isSignal(value)).toBe(true);
    expect((value as unknown as Record<PropertyKey, unknown>)[SIGNAL_BRAND]).toBe(1);
    expect(((value as unknown as Record<PropertyKey, unknown>)[READABLE_INTEROP_V1] as { version: number }).version).toBe(1);

    value.value = Number.NaN;
    expect(value.value).toBeNaN();
    value.value = 0;
    value.value = -0;
    expect(Object.is(value.value, -0)).toBe(true);
    expect(value.peek()).toBe(-0);

    const doubled = api.computed(() => value.value * 2);
    expect(doubled.value).toBe(-0);
    expect(api.isSignal(doubled)).toBe(true);
    expect((doubled as unknown as Record<PropertyKey, unknown>)[SIGNAL_BRAND]).toBe(1);
    expect(((doubled as unknown as Record<PropertyKey, unknown>)[READABLE_INTEROP_V1] as { version: number }).version).toBe(1);
    expect(Reflect.set(doubled, "value", 10)).toBe(false);
  });

  it("keeps cross-copy brand validation and rejects malformed foreign brands", () => {
    const api = create();
    const signal = api.signal(1);
    const foreignBrand = Symbol.for("react-fine-grained-signals.signal");
    const foreign = { value: 2, peek: () => 2 };
    Object.defineProperty(foreign, foreignBrand, { value: 1 });
    expect(api.isSignal(foreign)).toBe(true);
    const malformed = { value: 3, peek: 3 };
    Object.defineProperty(malformed, foreignBrand, { value: 1 });
    expect(api.isSignal(malformed)).toBe(false);
    expect(api.isSignal({ value: signal.value })).toBe(false);
  });

  it("observes foreign signal and computed values through ReadableInterop V1", () => {
    const api = create();
    const foreign = productionSignal(1);
    const foreignComputed = productionComputed(() => foreign.value * 2);
    const seen: number[] = [];
    const stop = api.effect(() => { seen.push(foreignComputed.value); });
    foreign.value = 2;
    expect(seen).toEqual([2, 4]);
    stop();

    const candidateSignal = api.signal(4);
    const productionSeen: number[] = [];
    const stopProduction = createCandidateA().effect(() => { productionSeen.push(candidateSignal.value); });
    candidateSignal.value = 5;
    expect(productionSeen).toEqual([4, 5]);
    stopProduction();
  });

  it("tracks values read during a React render", () => {
    const api = create();
    const count = api.signal(1);
    const doubled = api.computed(() => count.value * 2);
    function Reader() {
      useSignalTracking();
      return <output>{doubled.value}</output>;
    }

    render(<Reader />);
    expect(screen.getByText("2")).toBeTruthy();
    act(() => { count.value = 2; });
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("tracks deep properties and prunes an unwatched property after a write", () => {
    const api = create();
    const state = api.deepSignal({ watched: 1, cold: 2 });
    const values: number[] = [];
    const stop = api.effect(() => { values.push(state.value.watched); });
    state.value.watched = 3;
    state.value.cold = 4;
    expect(values).toEqual([1, 3]);
    const metadata = api.inspectDeepSignalMetadata(state.value);
    expect(metadata?.properties).not.toContain("cold");
    stop();
  });
});

it("records public surfaces for production and retained architecture prototypes", () => {
  const samples = [createCandidateA(), createCandidateB(), createCandidateC(), createCandidateC1()].map((api) => ({
    signal: summarizeKeys(api.signal(0)),
    computed: summarizeKeys(api.computed(() => 0)),
  }));

  expect(samples[0]!.signal.keys).toEqual([]);
  expect(samples[0]!.signal.names).toEqual([]);
  expect(samples[0]!.signal.symbols).toHaveLength(2);
  expect(samples[0]!.signal.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
  expect(samples[0]!.signal.prototypeNames).not.toEqual(expect.arrayContaining(["markWatched", "hasSubscribers", "getRenderVersion", "subscribeRender"]));
  expect(samples[0]!.computed.names).toEqual([]);
  expect(samples[0]!.computed.symbols).toHaveLength(2);
  expect(samples[1]!.signal.keys).toEqual([]);
  expect(samples[1]!.signal.names).toEqual([]);
  expect(samples[1]!.signal.symbols).toHaveLength(2);
  expect(samples[1]!.signal.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
  expect(samples[1]!.computed.names).toEqual([]);
  expect(samples[1]!.computed.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
  expect(samples[2]!.signal.names).toEqual(["value", "peek"]);
  expect(samples[2]!.signal.keys).toEqual(["value", "peek"]);
  expect(samples[2]!.signal.symbols).toEqual([
    "Symbol(react-fine-grained-signals.readable-interop.v1)",
    "Symbol(react-fine-grained-signals.signal)",
  ]);
  expect(samples[2]!.signal.prototypeNames).toContain("constructor");
  expect(samples[2]!.computed.names).toEqual(["value", "peek"]);
  expect(samples[3]!.signal.keys).toEqual([]);
  expect(samples[3]!.signal.names).toEqual([]);
  expect(samples[3]!.signal.symbols).toHaveLength(2);
  expect(samples[3]!.signal.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
  expect(samples[3]!.signal.prototypeNames).not.toEqual(expect.arrayContaining(["getRenderVersion", "subscribeRender", "markWatched", "hasSubscribers"]));
  expect(samples[3]!.computed.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
});

it("keeps production signal and computed internals behind the readable boundary", () => {
  const samples = [productionSignal(0), productionComputed(() => 1)].map(summarizeKeys);
  for (const sample of samples) {
    expect(sample.keys).toEqual([]);
    expect(sample.names).toEqual([]);
    expect(sample.symbols).toEqual(expect.arrayContaining([
      "Symbol(react-fine-grained-signals.readable-interop.v1)",
      "Symbol(react-fine-grained-signals.signal)",
    ]));
    expect(sample.symbols).toHaveLength(2);
    expect(sample.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
    expect(sample.prototypeNames).not.toEqual(expect.arrayContaining([
      "getRenderVersion", "subscribeRender", "markWatched", "hasSubscribers",
    ]));
    expect(sample.prototypeNames.some((name) => /deps|subs|runtimeToken|node/i.test(name))).toBe(false);
  }
});
