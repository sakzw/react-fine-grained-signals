import { describe, expect, it } from "vitest";
import { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";

describe("Prototype A lean local runtime", () => {
  it("uses Object.is for writes and computed equality, and supports peek/untracked", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const seen: number[] = [];
    runtime.effect(() => { seen.push(source.value); });
    source.value = -0;
    source.value = Number.NaN;
    source.value = Number.NaN;
    expect(Object.is(seen[0], 0)).toBe(true);
    expect(Object.is(seen[1], -0)).toBe(true);
    expect(Number.isNaN(seen[2])).toBe(true);
    expect(seen).toHaveLength(3);

    let calls = 0;
    const doubled = runtime.computed(() => { calls += 1; return source.value * 2; });
    expect(calls).toBe(0);
    expect(doubled.value).toBeNaN();
    expect(doubled.value).toBeNaN();
    expect(calls).toBe(1);
    expect(source.peek()).toBeNaN();
    runtime.effect(() => { runtime.untracked(() => source.value); });
    source.value = 3;
    expect(seen.at(-1)).toBe(3);
  });

  it("tracks dynamic dependencies and purges stale branches", () => {
    const runtime = createLeanRuntime(() => undefined);
    const chooseLeft = runtime.signal(true);
    const left = runtime.signal("left-0");
    const right = runtime.signal("right-0");
    const values: string[] = [];
    runtime.effect(() => { values.push(chooseLeft.value ? left.value : right.value); });
    chooseLeft.value = false;
    left.value = "left-1";
    right.value = "right-1";
    expect(values).toEqual(["left-0", "right-0", "right-1"]);
  });

  it("caches computed values, suppresses equal results, and recovers from errors and cycles", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    let getterCalls = 0;
    const parity = runtime.computed(() => { getterCalls += 1; return source.value % 2; });
    const seen: number[] = [];
    runtime.effect(() => { seen.push(parity.value); });
    source.value = 3;
    expect(getterCalls).toBe(2);
    expect(seen).toEqual([1]);
    source.value = 4;
    expect(seen).toEqual([1, 0]);

    const sameError = new Error("reused");
    const shouldThrow = runtime.signal(false);
    let errorEvaluations = 0;
    const recovered = runtime.computed(() => {
      errorEvaluations += 1;
      if (shouldThrow.value) throw sameError;
      return source.value;
    });
    expect(recovered.value).toBe(4);
    shouldThrow.value = true;
    expect(() => recovered.value).toThrow(sameError);
    shouldThrow.value = false;
    expect(recovered.value).toBe(4);
    expect(errorEvaluations).toBe(3);

    let recursive: ReturnType<typeof runtime.computed<number>>;
    const cycle = runtime.signal(false);
    recursive = runtime.computed(() => cycle.value ? recursive.value : 7);
    expect(recursive.value).toBe(7);
    cycle.value = true;
    expect(() => recursive.value).toThrow("Computed cycle detected");
    cycle.value = false;
    expect(recursive.value).toBe(7);
  });

  it("supports nested batch revert and cached computed peeks", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    let computedCalls = 0;
    const doubled = runtime.computed(() => { computedCalls += 1; return source.value * 2; });
    const seen: number[] = [];
    runtime.effect(() => { seen.push(doubled.value); });
    runtime.batch(() => {
      source.value = 1;
      runtime.batch(() => { source.value = 2; source.value = 0; });
    });
    expect(seen).toEqual([0]);
    expect(doubled.peek()).toBe(0);
    expect(computedCalls).toBe(1);
    source.value = 1;
    expect(doubled.peek()).toBe(2);
    expect(computedCalls).toBe(2);
  });

  it("orders cleanups, contains body/cleanup/reporter errors, and recovers", () => {
    const errors: unknown[] = [];
    const runtime = createLeanRuntime((error) => { errors.push(error); });
    const source = runtime.signal(0);
    const order: string[] = [];
    const bodyError = new Error("body");
    const cleanupError = new Error("cleanup");
    runtime.effect(() => {
      const value = source.value;
      order.push(`run:${value}`);
      if (value === 1) throw bodyError;
      return () => { order.push(`clean:${value}`); if (value === 0) throw cleanupError; };
    });
    source.value = 1;
    source.value = 2;
    expect(order).toEqual(["run:0", "clean:0", "run:1", "run:2"]);
    expect(errors).toEqual([cleanupError, bodyError]);
  });

  it("runs the active cleanup on disposal and reevaluates a cached computed error", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const cleanups: number[] = [];
    const dispose = runtime.effect(() => {
      const value = source.value;
      return () => { cleanups.push(value); };
    });
    source.value = 1;
    dispose();
    expect(cleanups).toEqual([0, 1]);

    const failure = new Error("cached failure");
    const invalidate = runtime.signal(0);
    let evaluations = 0;
    const broken = runtime.computed(() => {
      invalidate.value;
      evaluations += 1;
      throw failure;
    });
    expect(() => broken.value).toThrow(failure);
    expect(() => broken.value).toThrow(failure);
    expect(evaluations).toBe(1);
    invalidate.value = 1;
    expect(() => broken.value).toThrow(failure);
    expect(evaluations).toBe(2);
  });

  it("supports self-disposal, stops tracking subsequent reads, and keeps nested effects flat", () => {
    const errors: unknown[] = [];
    const runtime = createLeanRuntime((error) => { errors.push(error); });
    const source = runtime.signal(0);
    let dispose: () => void = () => {};
    let runs = 0;
    dispose = runtime.effect(() => {
      const value = source.value;
      runs += 1;
      if (value === 1) {
        dispose();
        source.value;
      }
    });
    source.value = 1;
    source.value = 2;
    expect(runs).toBe(2);
    expect(errors).toEqual([]);
  });

  it("continues independent queued effects when one body throws", () => {
    const errors: unknown[] = [];
    const runtime = createLeanRuntime((error) => { errors.push(error); });
    const source = runtime.signal(0);
    const goodRuns: number[] = [];
    runtime.effect(() => { if (source.value > 0) throw new Error("effect failure"); });
    runtime.effect(() => { goodRuns.push(source.value); });
    source.value = 1;
    expect(goodRuns).toEqual([0, 1]);
    expect(errors).toHaveLength(1);
  });

  it("handles batch return values and idempotent disposal", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    let calls = 0;
    const dispose = runtime.effect(() => { source.value; calls += 1; });
    expect(runtime.batch(() => { source.value = 1; return 42; })).toBe(42);
    dispose();
    dispose();
    source.value = 2;
    expect(calls).toBe(2);
  });

  it("tracks source writes and computed semantic changes in the optional revision sidecar", () => {
    const runtime = createLeanRuntime(() => undefined, { renderRevisionSidecar: true });
    const source = runtime.signal(0);
    const parity = runtime.computed(() => source.value % 2);

    expect(source.getRenderVersion()).toBe(0);
    expect(parity.getRenderVersion()).toBe(0);
    expect(parity.value).toBe(0);
    expect(parity.getRenderVersion()).toBe(0);

    source.value = 2;
    expect(source.getRenderVersion()).toBe(1);
    expect(parity.value).toBe(0);
    expect(parity.getRenderVersion()).toBe(0);

    source.value = 3;
    expect(source.getRenderVersion()).toBe(2);
    expect(parity.value).toBe(1);
    expect(parity.getRenderVersion()).toBe(1);

    runtime.batch(() => { source.value = 4; source.value = 3; });
    expect(source.getRenderVersion()).toBe(4);
    expect(parity.value).toBe(1);
    expect(parity.getRenderVersion()).toBe(1);
  });

  it("isolates speculative reads from graph/cache state and detects render-to-commit races", () => {
    const runtime = createLeanRuntime(() => undefined, { renderRevisionSidecar: true });
    const source = runtime.signal(1);
    let getterCalls = 0;
    const doubled = runtime.computed(() => { getterCalls += 1; return source.value * 2; });
    let effectRuns = 0;
    runtime.effect(() => { doubled.value; effectRuns += 1; });
    expect(getterCalls).toBe(1);

    const abandoned = runtime.speculate(() => doubled.value);
    const committedCandidate = runtime.speculate(() => doubled.value);
    expect(abandoned.value).toBe(2);
    expect(committedCandidate.value).toBe(2);
    expect(getterCalls).toBe(3);
    expect(effectRuns).toBe(1);
    expect(abandoned.isCurrent()).toBe(true);
    expect(committedCandidate.isCurrent()).toBe(true);

    source.value = 2;
    expect(abandoned.isCurrent()).toBe(false);
    expect(committedCandidate.isCurrent()).toBe(false);
    expect(doubled.value).toBe(4);
    expect(effectRuns).toBe(2);
    let recursive: ReturnType<typeof runtime.computed<number>>;
    recursive = runtime.computed(() => recursive.value);
    expect(() => runtime.speculate(() => recursive.value)).toThrow("Computed cycle detected");
  });
});
