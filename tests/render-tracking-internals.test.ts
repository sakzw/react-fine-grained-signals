import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executionContext,
  UNTRACKED_OWNER,
  withSynchronousExecutionOwner,
  type GraphExecutionOwnerV2,
} from "../src/core/execution-owner.js";
import { attachReadableInterop, type ReadableInteropV1 } from "../src/core/interop.js";
import {
  activeRenderCollector,
  getForeignReadableRenderDependency,
  getForeignRenderDependency,
  hasActiveRenderCollector,
  notifyListener,
  RenderSubscription,
  setActiveRenderCollector,
  trackRenderDependency,
  untrackedRender,
  type RenderDependency,
} from "../src/core/render-tracking.js";

afterEach(() => {
  setActiveRenderCollector(undefined);
  executionContext.owner = undefined;
  executionContext.frames.length = 0;
  vi.restoreAllMocks();
});

function foreignProtocol(): ReadableInteropV1 {
  return {
    version: 1,
    runtimeToken: {},
    getRevision: () => 9,
    subscribe(listener) {
      return { revision: 9, unsubscribe: () => listener(9) };
    },
  };
}

describe("render tracking internals", () => {
  it("tracks dependencies with current or explicit versions only under an active collector", () => {
    const dependency: RenderDependency = {
      getRenderVersion: () => 7,
      subscribeRender: () => () => undefined,
    };
    const add = vi.fn();
    expect(hasActiveRenderCollector()).toBe(false);
    expect(trackRenderDependency(dependency)).toBe(false);
    const previous = setActiveRenderCollector({ add });
    try {
      expect(hasActiveRenderCollector()).toBe(true);
      expect(trackRenderDependency(dependency)).toBe(true);
      expect(trackRenderDependency(dependency, 12)).toBe(true);
    } finally {
      setActiveRenderCollector(previous);
    }
    expect(add.mock.calls).toEqual([[dependency, 7], [dependency, 12]]);
    expect(activeRenderCollector).toBeUndefined();
  });

  it("pauses render collection while preserving graph ownership for untracked reads", () => {
    const dependency: RenderDependency = {
      getRenderVersion: () => 1,
      subscribeRender: () => () => undefined,
    };
    const add = vi.fn();
    const collector = { add };
    const previous = setActiveRenderCollector(collector);
    try {
      expect(untrackedRender(() => {
        expect(hasActiveRenderCollector()).toBe(false);
        expect(executionContext.owner).toBe(UNTRACKED_OWNER);
        return trackRenderDependency(dependency);
      })).toBe(false);
      expect(hasActiveRenderCollector()).toBe(true);

      const graphOwner: GraphExecutionOwnerV2 = {
        version: 2,
        kind: "graph",
        runtimeToken: {},
        add() {},
      };
      withSynchronousExecutionOwner(graphOwner, () => {
        expect(untrackedRender(() => {
          expect(executionContext.owner).toBe(graphOwner);
          return trackRenderDependency(dependency);
        })).toBe(false);
      });
    } finally {
      setActiveRenderCollector(previous);
    }
    expect(add).not.toHaveBeenCalled();
    expect(executionContext.owner).toBeUndefined();
  });

  it("adapts foreign readable protocols once and resolves invalid candidates to undefined", () => {
    const foreign = { value: 1 };
    expect(getForeignReadableRenderDependency(foreign)).toBeUndefined();
    const protocol = foreignProtocol();
    attachReadableInterop(foreign, protocol);
    const dependency = getForeignReadableRenderDependency(foreign);
    expect(dependency).toBeDefined();
    expect(getForeignReadableRenderDependency(foreign)).toBe(dependency);
    expect(getForeignRenderDependency(protocol)).toBe(dependency);
    expect(dependency?.getRenderVersion()).toBe(9);
    const listener = vi.fn();
    const unsubscribe = dependency?.subscribeRender(listener);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe?.();
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });

  it("versions subscriptions, notifies a stable listener snapshot, and releases hooks", () => {
    const firstSubscriber = vi.fn();
    const lastSubscriber = vi.fn();
    const subscription = new RenderSubscription(firstSubscriber, lastSubscriber);
    expect(subscription.getRenderVersion()).toBe(0);
    expect(subscription.hasListeners()).toBe(false);

    let unsubscribeSecond: () => void = () => undefined;
    let unsubscribeThird: () => void = () => undefined;
    const third = vi.fn();
    const second = vi.fn();
    const first = vi.fn(() => {
      unsubscribeSecond();
      unsubscribeThird = subscription.subscribeRender(third);
    });
    const unsubscribeFirst = subscription.subscribeRender(first);
    unsubscribeSecond = subscription.subscribeRender(second);
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(subscription.hasListeners()).toBe(true);
    expect(subscription.track()).toBe(false);
    subscription.bumpVersion();
    expect(subscription.getRenderVersion()).toBe(1);
    subscription.notify();
    expect(subscription.getRenderVersion()).toBe(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    subscription.notify();
    expect(third).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeThird();
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(lastSubscriber).toHaveBeenCalledTimes(1);
    expect(subscription.hasListeners()).toBe(false);
    expect(subscription.notify()).toBeUndefined();
  });

  it("contains listener errors and makes duplicate unsubscribe safe", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const subscription = new RenderSubscription();
    const failing = vi.fn(() => { throw new Error("subscriber"); });
    const following = vi.fn();
    const stopFailing = subscription.subscribeRender(failing);
    subscription.subscribeRender(following);
    subscription.notify();
    expect(following).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "react-fine-grained-signals: a render-subscription listener threw; continuing with the remaining listeners.",
      { cause: expect.any(Error) },
    );
    stopFailing();
    stopFailing();
  });

  it("returns false from tracking without a collector", () => {
    const dependency = new RenderSubscription();
    expect(dependency.track()).toBe(false);
    const previous = setActiveRenderCollector({ add: vi.fn() });
    try {
      expect(dependency.track()).toBe(true);
    } finally {
      setActiveRenderCollector(previous);
    }
  });

  it("contains a failing notification listener and still calls the next one", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const following = vi.fn();
    notifyListener(() => { throw new Error("direct notification"); });
    notifyListener(following);
    expect(log).toHaveBeenCalledTimes(1);
    expect(following).toHaveBeenCalledTimes(1);
  });
});
