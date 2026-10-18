import { afterEach, describe, expect, it, vi } from "vitest";
import { executionContext, pushExecutionOwner } from "../src/core/execution-owner.js";
import { createAlienDerivedRenderAdapter } from "../src/core/render-runtime.mjs";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";

function createRenderRuntime() {
  const runtime = createReactiveRuntime();
  runtime.initializeRenderAdapter(createAlienDerivedRenderAdapter);
  return runtime;
}

afterEach(() => {
  executionContext.owner = undefined;
  executionContext.frames.length = 0;
});

describe("render adapter contracts", () => {
  it("initializes the render adapter only when requested and reuses it", () => {
    const runtime = createReactiveRuntime();
    const source = runtime.signal(1);
    expect(source.value).toBe(1);
    expect(runtime.isSpeculative()).toBe(false);
    expect(() => runtime.markSpeculativeDeepRead()).not.toThrow();

    const factory = vi.fn(createAlienDerivedRenderAdapter);
    const first = runtime.initializeRenderAdapter(factory);
    const second = runtime.initializeRenderAdapter(factory);

    expect(first).toBe(second);
    expect(runtime.renderAdapter).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("captures render snapshots and resolves supported dependency versions", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(2);
    const doubled = runtime.computed(() => source.value * 2);
    const { value, dependencies } = runtime.renderAdapter.captureRenderSnapshot(doubled);

    expect(value).toBe(4);
    expect(dependencies.has(source)).toBe(false);
    expect(dependencies.has(doubled)).toBe(true);
    expect(runtime.renderAdapter.hasActiveRenderOwner()).toBe(false);
    expect(runtime.renderAdapter.getRenderVersion(source)).toBe(0);
    expect(runtime.renderAdapter.getRenderVersion({ getRenderVersion: () => 17 })).toBe(17);
    expect(() => runtime.renderAdapter.getRenderVersion({})).toThrow("Unknown render dependency");
  });

  it("tracks subscription notifications and speculative deep-read epochs", () => {
    const runtime = createRenderRuntime();
    const source = runtime.signal(0);
    const notify = vi.fn();
    const unsubscribe = runtime.renderAdapter.subscribeReadables([source], notify);
    expect(notify).not.toHaveBeenCalled();
    source.value = 1;
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe();

    const attempt = runtime.renderAdapter.createRenderAttempt();
    runtime.renderAdapter.withRenderScope(attempt, () => {
      expect(runtime.renderAdapter.hasActiveRenderOwner()).toBe(true);
      expect(runtime.renderAdapter.isSpeculative()).toBe(false);
      runtime.markSpeculativeDeepRead();
      expect(attempt.speculativeDeepReadEpoch).toBe(1);
    });
    expect(runtime.renderAdapter.getExecutionOwner()).toBeUndefined();

    const owner = runtime.renderAdapter.createRenderOwner(attempt);
    const restore = pushExecutionOwner(owner as Parameters<typeof pushExecutionOwner>[0]);
    try {
      runtime.markSpeculativeDeepRead();
      expect(attempt.speculativeDeepReadEpoch).toBe(2);
    } finally {
      restore();
    }
  });

  it("keeps per-attempt dependencies isolated when render work resumes after a yield", async () => {
    const runtime = createRenderRuntime();
    const left = runtime.signal("left");
    const right = runtime.signal("right");
    const leftAttempt = runtime.renderAdapter.createRenderAttempt();
    const rightAttempt = runtime.renderAdapter.createRenderAttempt();

    runtime.renderAdapter.withRenderScope(leftAttempt, () => {
      expect(left.value).toBe("left");
    });

    // React may yield between fibers/capture expressions. No ambient owner is
    // left active while the first attempt is suspended outside its sync scope.
    await Promise.resolve();
    expect(runtime.renderAdapter.hasActiveRenderOwner()).toBe(false);

    runtime.renderAdapter.withRenderScope(rightAttempt, () => {
      expect(right.value).toBe("right");
    });

    await Promise.resolve();
    runtime.renderAdapter.withRenderScope(leftAttempt, () => {
      expect(left.value).toBe("left");
    });

    expect([...leftAttempt.dependencies.keys()]).toEqual([left]);
    expect([...rightAttempt.dependencies.keys()]).toEqual([right]);
    expect(runtime.renderAdapter.hasActiveRenderOwner()).toBe(false);
  });
});
