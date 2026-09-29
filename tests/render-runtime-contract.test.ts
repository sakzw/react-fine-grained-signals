import { afterEach, describe, expect, it, vi } from "vitest";
import { executionContext, pushExecutionOwner } from "../src/core/execution-owner.js";
import { createReactiveRuntime } from "../src/core/reactive-runtime.js";

afterEach(() => {
  executionContext.owner = undefined;
  executionContext.frames.length = 0;
});

describe("render adapter contracts", () => {
  it("captures render snapshots and resolves supported dependency versions", () => {
    const runtime = createReactiveRuntime();
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
    const runtime = createReactiveRuntime();
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
});
