import { describe, expect, it } from "vitest";
import { coreRuntime } from "../src/core/core-runtime.js";
import {
  getReadableInterop,
  READABLE_INTEROP_V1,
} from "../src/core/interop.js";
import {
  setActiveRenderCollector,
  type RenderDependency,
} from "../src/core/render-tracking.js";
import { SIGNAL_BRAND } from "../src/core/signal-brand.js";
import { computed, isSignal, signal } from "../src/index.js";

const publicGraphNames = /^(?:deps|depsTail|subs|subsTail|runtimeToken|node|kind|flags|revision|renderListeners|protocolListeners)$/i;

function ownReadableShape(value: object) {
  const prototype = Object.getPrototypeOf(value) as object;
  return {
    keys: Object.keys(value),
    ownNames: Object.getOwnPropertyNames(value),
    ownSymbols: Object.getOwnPropertySymbols(value),
    ownKeys: Reflect.ownKeys(value),
    prototypeNames: Object.getOwnPropertyNames(prototype),
    prototypeSymbols: Object.getOwnPropertySymbols(prototype),
  };
}

describe("public runtime readable surface", () => {
  it("keeps signal and computed state behind their public contracts", () => {
    const source = signal(2);
    const doubled = computed(() => source.value * 2);

    expect(source.value).toBe(2);
    expect(source.peek()).toBe(2);
    source.value = 3;
    expect(doubled.value).toBe(6);
    expect(doubled.peek()).toBe(6);
    expect(isSignal(source)).toBe(true);
    expect(isSignal(doubled)).toBe(true);
    expect(Reflect.set(doubled, "value", 10)).toBe(false);

    for (const readable of [source, doubled]) {
      const shape = ownReadableShape(readable);
      expect(shape.keys).toEqual([]);
      expect(shape.ownNames).toEqual([]);
      expect(new Set(shape.ownSymbols)).toEqual(new Set([SIGNAL_BRAND, READABLE_INTEROP_V1]));
      expect(new Set(shape.ownKeys)).toEqual(new Set([SIGNAL_BRAND, READABLE_INTEROP_V1]));
      expect(shape.prototypeNames).toEqual(expect.arrayContaining(["constructor", "value", "peek"]));
      expect(shape.prototypeNames.some((name) => publicGraphNames.test(name))).toBe(false);
      expect(shape.prototypeNames).not.toEqual(expect.arrayContaining([
        "getRenderVersion", "subscribeRender", "markWatched", "hasSubscribers",
      ]));
      expect(shape.prototypeSymbols).toEqual([]);
      expect("getRenderVersion" in readable).toBe(false);
      expect("subscribeRender" in readable).toBe(false);

      const protocol = getReadableInterop(readable);
      expect(protocol).toBe(Reflect.get(readable, READABLE_INTEROP_V1));
      expect(protocol?.version).toBe(1);
      expect(protocol?.runtimeToken).toEqual(expect.any(Object));
      expect(typeof protocol?.getRevision).toBe("function");
      expect(typeof protocol?.subscribe).toBe("function");
    }
  });

  it("passes the private graph dependency to render collection", () => {
    const readable = signal(1);
    let dependency: RenderDependency | undefined;
    const previous = setActiveRenderCollector({
      add(next) { dependency = next; },
    });
    try {
      expect(readable.value).toBe(1);
    } finally {
      setActiveRenderCollector(previous);
    }

    expect(dependency).toBeDefined();
    expect(dependency).not.toBe(readable);
    expect(typeof dependency?.getRenderVersion).toBe("function");
    expect(typeof dependency?.subscribeRender).toBe("function");
  });

  it("keeps internal deep runtime sources unbranded while retaining V1 ownership", () => {
    const source = coreRuntime.createDeepSignal(1);
    expect(isSignal(source)).toBe(false);
    expect(Object.getOwnPropertySymbols(source)).toContain(READABLE_INTEROP_V1);

    const seen: number[] = [];
    const stop = coreRuntime.effect(() => {
      seen.push(source.value);
    });
    try {
      source.value = 2;
      expect(seen).toEqual([1, 2]);
    } finally {
      stop();
    }
  });
});
