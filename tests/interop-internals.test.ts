import { afterEach, describe, expect, it } from "vitest";
import {
  attachReadableInterop,
  getReadableInterop,
  getSharedInteropContext,
  isInteropSpeculative,
  markInteropSpeculativeDeepRead,
  READABLE_INTEROP_V1,
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

  it("advances deep-read epochs", () => {
    expect(isInteropSpeculative()).toBe(false);
    const initialEpoch = context.speculativeDeepReadEpoch;
    markInteropSpeculativeDeepRead();
    expect(context.speculativeDeepReadEpoch).toBe(initialEpoch + 1);
  });

});
