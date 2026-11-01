import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executionContext,
  UNTRACKED_OWNER,
  withSynchronousExecutionOwner,
  type GraphExecutionOwner,
} from "../src/core/execution-owner.js";
import {
  activeRenderCollector,
  hasActiveRenderCollector,
  notifyListener,
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
    expect(add.mock.calls).toEqual([
      [dependency, 7],
      [dependency, 12],
    ]);
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
      expect(
        untrackedRender(() => {
          expect(hasActiveRenderCollector()).toBe(false);
          expect(executionContext.owner).toBe(UNTRACKED_OWNER);
          return trackRenderDependency(dependency);
        }),
      ).toBe(false);
      expect(hasActiveRenderCollector()).toBe(true);

      const graphOwner: GraphExecutionOwner = {
        kind: "graph",
        runtimeToken: {},
      };
      withSynchronousExecutionOwner(graphOwner, () => {
        expect(
          untrackedRender(() => {
            expect(executionContext.owner).toBe(graphOwner);
            return trackRenderDependency(dependency);
          }),
        ).toBe(false);
      });
    } finally {
      setActiveRenderCollector(previous);
    }
    expect(add).not.toHaveBeenCalled();
    expect(executionContext.owner).toBeUndefined();
  });

  it("contains a failing notification listener and still calls the next one", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const following = vi.fn();
    notifyListener(() => {
      throw new Error("direct notification");
    });
    notifyListener(following);
    expect(log).toHaveBeenCalledTimes(1);
    expect(following).toHaveBeenCalledTimes(1);
  });
});
