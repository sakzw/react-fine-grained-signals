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

  it("keeps first-observed sidecar revisions when a speculative scope rereads after a write", () => {
    const runtime = createLeanRuntime(() => undefined, { renderRevisionSidecar: true });
    const source = runtime.signal(0);
    const snapshot = runtime.speculate(() => {
      expect(source.value).toBe(0);
      source.value = 1;
      return source.value;
    });
    expect(snapshot.value).toBe(1);
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("peeks pending source values before and during batch commits", () => {
    const runtime = createLeanRuntime(() => undefined);
    const pending = runtime.signal(0);
    pending.value = 1;
    expect(pending.peek()).toBe(1);

    const source = runtime.signal(0);
    const seen: number[] = [];
    let peekEffectRuns = 0;
    runtime.effect(() => { seen.push(source.value); });
    runtime.effect(() => { source.peek(); peekEffectRuns += 1; });
    source.value = 1;
    expect(source.peek()).toBe(1);
    runtime.batch(() => {
      source.value = 2;
      expect(source.peek()).toBe(2);
      source.value = 3;
      expect(source.peek()).toBe(3);
      expect(source.value).toBe(3);
      source.value = 4;
      source.value = 3;
      expect(source.peek()).toBe(3);
    });
    expect(source.peek()).toBe(3);
    expect(source.value).toBe(3);
    expect(seen).toEqual([0, 1, 3]);
    expect(peekEffectRuns).toBe(1);
  });

  it("keeps computed peek lazy, cached, untracked, and coherent across batches", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const trigger = runtime.signal(0);
    let getterCalls = 0;
    const doubled = runtime.computed(() => { getterCalls += 1; return source.value * 2; });
    const outerRuns: number[] = [];
    runtime.effect(() => { outerRuns.push(trigger.value); doubled.peek(); });
    expect(getterCalls).toBe(1);
    source.value = 2;
    expect(outerRuns).toEqual([0]);
    expect(doubled.peek()).toBe(4);
    expect(getterCalls).toBe(2);
    runtime.batch(() => {
      source.value = 3;
      expect(doubled.peek()).toBe(6);
      source.value = 2;
      expect(doubled.peek()).toBe(4);
    });
    expect(doubled.value).toBe(4);
    expect(outerRuns).toEqual([0]);
    trigger.value = 1;
    expect(outerRuns).toEqual([0, 1]);
    expect(getterCalls).toBe(4);
  });

  it("keeps nested effect ownership flat unless the disposer is returned as cleanup", () => {
    const runtime = createLeanRuntime(() => undefined);
    const outerSource = runtime.signal(0);
    const childSource = runtime.signal(0);
    const childRuns: number[] = [];
    const childDisposers: Array<() => void> = [];
    const disposeOuter = runtime.effect(() => {
      outerSource.value;
      childDisposers.push(runtime.effect(() => { childRuns.push(childSource.value); }));
    });
    outerSource.value = 1;
    expect(childDisposers).toHaveLength(2);
    expect(childRuns).toEqual([0, 0]);
    childSource.value = 1;
    expect(childRuns).toEqual([0, 0, 1, 1]);
    disposeOuter();
    childSource.value = 2;
    expect(childRuns).toEqual([0, 0, 1, 1, 2, 2]);

    const explicitRuns: number[] = [];
    const parent = runtime.effect(() => {
      outerSource.value;
      return runtime.effect(() => { explicitRuns.push(childSource.value); });
    });
    outerSource.value = 2;
    expect(explicitRuns).toEqual([2, 2]);
    parent();
    childSource.value = 3;
    expect(explicitRuns).toEqual([2, 2]);
  });

  it("self-disposes before rereads without retaining old or new dependencies and runs cleanup once", () => {
    const runtime = createLeanRuntime(() => undefined);
    const oldSource = runtime.signal(0);
    const newSource = runtime.signal(0);
    const cleanups: number[] = [];
    let dispose = () => {};
    let runs = 0;
    dispose = runtime.effect(() => {
      const current = oldSource.value;
      runs += 1;
      if (current === 1) {
        dispose();
        oldSource.value;
        newSource.value;
        return () => { cleanups.push(current); };
      }
      return () => { cleanups.push(current); };
    });
    oldSource.value = 1;
    oldSource.value = 2;
    newSource.value = 1;
    dispose();
    expect(runs).toBe(2);
    expect(cleanups).toEqual([0, 1]);
  });

  it("contains synchronous reentrant writes and settles self writes deterministically", () => {
    const runtime = createLeanRuntime(() => undefined);
    const sourceA = runtime.signal(0);
    const sourceB = runtime.signal(0);
    const bSeen: number[] = [];
    runtime.effect(() => { bSeen.push(sourceB.value); });
    runtime.effect(() => {
      if (sourceA.value === 1) sourceB.value = 2;
    });
    sourceA.value = 1;
    expect(bSeen).toEqual([0, 2]);

    const self = runtime.signal(0);
    const selfSeen: number[] = [];
    runtime.effect(() => {
      const value = self.value;
      selfSeen.push(value);
      if (value === 1) self.value = 2;
    });
    self.value = 1;
    expect(selfSeen).toEqual([0, 1]);
    expect(self.peek()).toBe(2);
  });

  it("handles cleanup transitions, untracked cleanup reads, failures, and later recovery", () => {
    const errors: unknown[] = [];
    const runtime = createLeanRuntime((error) => { errors.push(error); });
    const step = runtime.signal(1);
    const cleanupDependency = runtime.signal(0);
    const order: string[] = [];
    let failCleanup = false;
    const dispose = runtime.effect(() => {
      const value = step.value;
      order.push(`body:${value}`);
      if (value === 1) return;
      if (value === 2) return () => { order.push(`cleanup:${cleanupDependency.value}`); };
      if (value === 3) return () => {
        order.push(`cleanup:${cleanupDependency.value}`);
        if (failCleanup) throw new Error("cleanup failed");
      };
      if (value === 5) return () => { order.push("cleanup:dispose"); };
      return;
    });
    step.value = 2;
    step.value = 3;
    failCleanup = true;
    step.value = 4;
    expect(order).toEqual([
      "body:1", "body:2", "cleanup:0", "body:3", "cleanup:0", "body:4",
    ]);
    expect(errors).toHaveLength(1);
    cleanupDependency.value = 1;
    expect(order).toHaveLength(6);
    step.value = 5;
    dispose();
    expect(order.at(-1)).toBe("cleanup:dispose");
    dispose();
    expect(order.filter((entry) => entry === "cleanup:dispose")).toHaveLength(1);
  });

  it("retains dynamic dependencies for computed branches", () => {
    const runtime = createLeanRuntime(() => undefined);
    const chooseLeft = runtime.signal(true);
    const left = runtime.signal(1);
    const right = runtime.signal(10);
    const selected = runtime.computed(() => chooseLeft.value ? left.value : right.value);
    const seen: number[] = [];
    runtime.effect(() => { seen.push(selected.value); });
    chooseLeft.value = false;
    left.value = 2;
    right.value = 11;
    expect(seen).toEqual([1, 10, 11]);
  });

  it("preserves nested computed equality, batch revert, and error recovery", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(1);
    const fail = runtime.signal(false);
    const parity = runtime.computed(() => {
      if (fail.value) throw new Error("chain error");
      return source.value % 2;
    });
    const label = runtime.computed(() => parity.value ? "odd" : "even");
    const seen: string[] = [];
    runtime.effect(() => { seen.push(label.value); });
    source.value = 3;
    expect(seen).toEqual(["odd"]);
    source.value = 4;
    expect(seen).toEqual(["odd", "even"]);
    runtime.batch(() => { source.value = 5; source.value = 4; });
    expect(seen).toEqual(["odd", "even"]);
    fail.value = true;
    expect(seen.at(-1)).toBe("even");
    fail.value = false;
    source.value = 5;
    expect(seen.at(-1)).toBe("odd");
  });

  it("flushes batched writes after callback throws and restores nested batch state", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const seen: number[] = [];
    runtime.effect(() => { seen.push(source.value); });
    const failure = new Error("batch callback");
    expect(() => runtime.batch(() => {
      source.value = 1;
      runtime.batch(() => { source.value = 2; });
      throw failure;
    })).toThrow(failure);
    expect(seen).toEqual([0, 2]);
    source.value = 3;
    expect(seen).toEqual([0, 2, 3]);
  });

  it("restores untracked state through nesting and a throwing callback", () => {
    const runtime = createLeanRuntime(() => undefined);
    const source = runtime.signal(0);
    const fail = runtime.signal(false);
    const trackedAfter = runtime.signal(0);
    const seen: Array<[boolean, number]> = [];
    const nestedErrors: unknown[] = [];
    runtime.effect(() => {
      if (fail.value) {
        try {
          runtime.untracked(() => runtime.untracked(() => { throw new Error("nested"); }));
        } catch (error) {
          nestedErrors.push(error);
        }
      }
      runtime.untracked(() => source.value);
      seen.push([fail.value, trackedAfter.value]);
    });
    source.value = 1;
    expect(seen).toEqual([[false, 0]]);
    fail.value = true;
    source.value = 2;
    expect(nestedErrors).toHaveLength(1);
    expect(nestedErrors[0]).toMatchObject({ message: "nested" });
    expect(seen).toEqual([[false, 0], [true, 0]]);
    trackedAfter.value = 1;
    expect(seen).toEqual([[false, 0], [true, 0], [true, 1]]);
  });

  it("reevaluates cached computed errors after invalidation and recovers dependents", () => {
    const runtime = createLeanRuntime(() => undefined);
    const mode = runtime.signal(2);
    const firstFailure = new Error("first");
    const secondFailure = new Error("second");
    let evaluations = 0;
    const value = runtime.computed(() => {
      const current = mode.value;
      evaluations += 1;
      if (current === 0) throw firstFailure;
      if (current === 1) throw secondFailure;
      return 42;
    });
    const seen: number[] = [];
    const errors: unknown[] = [];
    runtime.effect(() => {
      try { seen.push(value.value); } catch (error) { errors.push(error); }
    });
    expect(seen).toEqual([42]);
    expect(evaluations).toBe(1);
    mode.value = 0;
    expect(evaluations).toBe(2);
    expect(errors).toEqual([firstFailure]);
    expect(() => value.value).toThrow(firstFailure);
    expect(() => value.peek()).toThrow(firstFailure);
    expect(evaluations).toBe(2);
    mode.value = 1;
    expect(errors.at(-1)).toBe(secondFailure);
    mode.value = 2;
    expect(seen.at(-1)).toBe(42);
    expect(errors).toEqual([firstFailure, secondFailure]);
  });

  it("contains a throwing error reporter without aborting queued effects", () => {
    const runtime = createLeanRuntime(() => { throw new Error("reporter failed"); });
    const source = runtime.signal(0);
    const values: number[] = [];
    runtime.effect(() => { if (source.value > 0) throw new Error("body failed"); });
    runtime.effect(() => { values.push(source.value); });
    source.value = 1;
    expect(values).toEqual([0, 1]);
    source.value = 2;
    expect(values).toEqual([0, 1, 2]);
  });

  it("contains repeated same-error reevaluations and notifies dependents", () => {
    const runtime = createLeanRuntime(() => undefined);
    const mode = runtime.signal(0);
    const failure = new Error("same identity");
    let computedRuns = 0;
    let effectRuns = 0;
    const value = runtime.computed(() => {
      mode.value;
      computedRuns += 1;
      throw failure;
    });
    runtime.effect(() => {
      effectRuns += 1;
      try { value.value; } catch {}
    });
    expect([computedRuns, effectRuns]).toEqual([1, 1]);
    mode.value = 1;
    expect([computedRuns, effectRuns]).toEqual([2, 2]);
  });

  it("bounds an indirect computed cycle and recovers after the cycle is disabled", () => {
    const runtime = createLeanRuntime(() => undefined);
    const cycleEnabled = runtime.signal(false);
    let first: ReturnType<typeof runtime.computed<number>>;
    let second: ReturnType<typeof runtime.computed<number>>;
    first = runtime.computed(() => cycleEnabled.value ? second.value + 1 : 1);
    second = runtime.computed(() => first.value + 1);
    expect(first.value).toBe(1);
    cycleEnabled.value = true;
    expect(() => first.value).toThrow("Computed cycle detected");
    cycleEnabled.value = false;
    expect(first.value).toBe(1);
  });
});
