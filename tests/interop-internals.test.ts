import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachReadableInterop,
  getReadableInterop,
  getSharedInteropContext,
  isInteropSpeculative,
  markInteropSpeculativeDeepRead,
  publishInteropGraphRead,
  publishInteropRenderRead,
  pushInteropRenderScope,
  READABLE_INTEROP_V1,
  withInteropGraphCollector,
  withInteropRenderCollector,
  withInteropSpeculativeMode,
  withoutInteropGraphCollector,
  withoutInteropRenderCollector,
  withoutInteropSpeculativeMode,
  type ReadableInteropV1,
} from "../src/core/interop.js";

const context = getSharedInteropContext();

function protocol(runtimeToken: object = {}): ReadableInteropV1 {
  return {
    version: 1,
    runtimeToken,
    getRevision: () => 3,
    subscribe: () => ({ revision: 3, unsubscribe() {} }),
  };
}

afterEach(() => {
  context.graphCollector = undefined;
  context.renderCollector = undefined;
  context.renderScope = undefined;
  context.speculativeDepth = 0;
  context.speculativeDeepReadEpoch = 0;
});

describe("shared readable interop context", () => {
  it("validates the optional readable protocol and attaches it privately", () => {
    expect(getReadableInterop({})).toBeUndefined();
    for (const candidate of [null, 1, {}, { version: 2 }, { version: 1 }, {
      version: 1,
      runtimeToken: {},
      getRevision: 3,
      subscribe() {},
    }, {
      version: 1,
      runtimeToken: {},
      getRevision() { return 0; },
      subscribe: 3,
    }, {
      version: 1,
      runtimeToken: null,
      getRevision() { return 0; },
      subscribe() {},
    }, {
      version: 1,
      runtimeToken: 3,
      getRevision() { return 0; },
      subscribe() {},
    }]) {
      expect(getReadableInterop({ [READABLE_INTEROP_V1]: candidate })).toBeUndefined();
    }

    const readable = { value: 1 };
    const attached = protocol();
    attachReadableInterop(readable, attached);
    expect(getReadableInterop(readable)).toBe(attached);
    expect(Object.keys(readable)).toEqual(["value"]);
    expect(Object.getOwnPropertyDescriptor(readable, READABLE_INTEROP_V1)).toMatchObject({
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(() => attachReadableInterop(readable, protocol())).toThrow(TypeError);
  });

  it("restores nested graph collectors and publishes only foreign graph reads", () => {
    const localToken = {};
    const foreign = protocol({});
    const sameRuntime = protocol(localToken);
    const outer = { runtimeToken: localToken, add: vi.fn() };
    const inner = { runtimeToken: {}, add: vi.fn() };

    expect(withInteropGraphCollector(outer, () => {
      publishInteropGraphRead(foreign, 4);
      publishInteropGraphRead(sameRuntime, 5);
      return withoutInteropGraphCollector(() => {
        publishInteropGraphRead(foreign, 6);
        return "done";
      });
    })).toBe("done");
    expect(outer.add).toHaveBeenCalledExactlyOnceWith(foreign, 4);
    expect(getSharedInteropContext().graphCollector).toBeUndefined();

    withInteropGraphCollector(outer, () => {
      withInteropGraphCollector(inner, () => publishInteropGraphRead(foreign, 7));
      publishInteropGraphRead(foreign, 8);
      expect(() => withoutInteropGraphCollector(() => { throw new Error("graph"); })).toThrow("graph");
      publishInteropGraphRead(foreign, 9);
    });
    expect(inner.add).toHaveBeenCalledExactlyOnceWith(foreign, 7);
    expect(outer.add.mock.calls.map((call) => call[1])).toEqual([4, 8, 9]);
  });

  it("restores render collectors and only restores active parent scopes", () => {
    const foreign = protocol();
    const first = { add: vi.fn() };
    const second = { add: vi.fn() };
    withInteropRenderCollector(first, () => {
      publishInteropRenderRead(foreign, 2);
      withInteropRenderCollector(second, () => publishInteropRenderRead(foreign, 3));
      publishInteropRenderRead(foreign, 4);
      withoutInteropRenderCollector(() => publishInteropRenderRead(foreign, 5));
      publishInteropRenderRead(foreign, 6);
    });
    expect(first.add.mock.calls.map((call) => call[1])).toEqual([2, 4, 6]);
    expect(second.add).toHaveBeenCalledExactlyOnceWith(foreign, 3);

    const parent = { token: {}, managed: true, isActive: () => true, finish() {} };
    const child = { token: {}, managed: false, isActive: () => true, finish() {} };
    const restoreParent = pushInteropRenderScope(parent, first);
    const restoreChild = pushInteropRenderScope(child, second);
    restoreChild();
    restoreChild();
    expect(context.renderScope).toBe(parent);
    expect(context.renderCollector).toBe(first);
    restoreParent();
    expect(context.renderScope).toBeUndefined();
    expect(context.renderCollector).toBeUndefined();

    const inactive = { ...parent, isActive: () => false };
    const restoreInactive = pushInteropRenderScope(inactive, first);
    const restoreNested = pushInteropRenderScope(child, second);
    restoreNested();
    expect(context.renderScope).toBeUndefined();
    expect(context.renderCollector).toBeUndefined();
    restoreInactive();
  });

  it("nests speculative mode, restores it after errors, and advances deep-read epochs", () => {
    expect(isInteropSpeculative()).toBe(false);
    const initialEpoch = context.speculativeDeepReadEpoch;
    markInteropSpeculativeDeepRead();
    expect(context.speculativeDeepReadEpoch).toBe(initialEpoch + 1);

    expect(withInteropSpeculativeMode(() => {
      expect(isInteropSpeculative()).toBe(true);
      return withoutInteropSpeculativeMode(() => {
        expect(isInteropSpeculative()).toBe(false);
        withInteropSpeculativeMode(() => expect(isInteropSpeculative()).toBe(true));
        expect(isInteropSpeculative()).toBe(false);
      });
    })).toBeUndefined();
    expect(isInteropSpeculative()).toBe(false);
    expect(() => withInteropSpeculativeMode(() => {
      throw new Error("speculative");
    })).toThrow("speculative");
    expect(context.speculativeDepth).toBe(0);
  });

});
