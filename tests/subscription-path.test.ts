import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, effect, signal } from "../src/core/index.js";
import { attachReadableInterop, getReadableInterop } from "../src/core/interop.js";
import { subscribeReadableV1 } from "../src/core/readable-subscription.js";
import type { ReadableInteropV1 } from "../src/core/interop.js";

afterEach(() => vi.restoreAllMocks());

describe("ReadableInterop V1 subscription path", () => {
  it("matches the effect bridge for signal/computed notifications and disposal", () => {
    const source = signal(1);
    const parity = computed(() => source.value % 2);
    const protocol = getReadableInterop(parity)!;
    const legacyListener = vi.fn();
    const directListener = vi.fn();
    let initial = true;
    const disposeLegacy = effect(() => {
      parity.value;
      if (!initial) legacyListener();
      initial = false;
    });
    const direct = protocol.subscribe(() => directListener());

    source.value = 3; // computed equality suppression
    source.value = 2;
    expect(directListener).toHaveBeenCalledTimes(1);
    expect(legacyListener).toHaveBeenCalledTimes(1);
    direct.unsubscribe();
    disposeLegacy();
    source.value = 4;
    expect(directListener).toHaveBeenCalledTimes(1);
    expect(legacyListener).toHaveBeenCalledTimes(1);
  });

  it("notifies across success/error/recovery without letting writes throw", () => {
    const source = signal(1);
    const firstError = new Error("computed failure");
    const secondError = new Error("different computed failure");
    const value = computed(() => {
      if (source.value === 2) throw firstError;
      if (source.value === 3) throw secondError;
      return source.value;
    });
    const protocol = getReadableInterop(value)!;
    const notify = vi.fn();
    const subscription = protocol.subscribe(notify);

    expect(() => { source.value = 2; }).not.toThrow();
    expect(() => value.value).toThrow(firstError);
    expect(() => { source.value = 3; }).not.toThrow();
    expect(() => value.value).toThrow(secondError);
    expect(() => { source.value = 4; }).not.toThrow();
    expect(value.value).toBe(4);
    expect(notify).toHaveBeenCalledTimes(3);
    subscription.unsubscribe();
  });

  it("supports many independent listeners and releases each subscription", () => {
    const source = signal(0);
    const protocol = getReadableInterop(source)!;
    const listeners = Array.from({ length: 64 }, () => vi.fn());
    const subscriptions = listeners.map((listener) => protocol.subscribe(listener));
    source.value = 1;
    expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true);
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    source.value = 2;
    expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true);
  });

  it("follows a computed's dynamically selected branch", () => {
    const chooseLeft = signal(true);
    const left = signal("left");
    const right = signal("right");
    const selected = computed(() => chooseLeft.value ? left.value : right.value);
    const protocol = getReadableInterop(selected)!;
    const notify = vi.fn();
    const subscription = protocol.subscribe(notify);

    left.value = "left updated";
    chooseLeft.value = false;
    left.value = "ignored";
    right.value = "right updated";
    expect(notify).toHaveBeenCalledTimes(3);
    subscription.unsubscribe();
  });

  it("preserves the subscription receiver while returning its disposer", () => {
    const readable = { value: 0, peek: () => 0 };
    const subscription = {
      revision: 0,
      unsubscribeCount: 0,
      unsubscribe() { this.unsubscribeCount += 1; },
    };
    const protocol: ReadableInteropV1 = {
      version: 1,
      runtimeToken: {},
      getRevision: () => 0,
      subscribe: () => subscription,
    };
    attachReadableInterop(readable, protocol);

    const unsubscribe = subscribeReadableV1(readable, vi.fn());
    unsubscribe?.();
    expect(subscription.unsubscribeCount).toBe(1);
  });
});
