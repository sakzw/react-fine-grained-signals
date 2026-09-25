import { afterEach, describe, expect, it, vi } from "vitest";
import { createLowLevelRuntime } from "../src/core/low-level-runtime.js";
import {
  setActiveRenderCollector,
  type RenderDependency,
} from "../src/core/render-tracking.js";

function collect(read: () => void): RenderDependency[] {
  const dependencies: RenderDependency[] = [];
  const previous = setActiveRenderCollector({
    add: (dependency) => dependencies.push(dependency),
  });
  try {
    read();
  } finally {
    setActiveRenderCollector(previous);
  }
  return dependencies;
}

function collectWithVersions(read: () => void): Array<{
  dependency: RenderDependency;
  version: number;
}> {
  const dependencies: Array<{ dependency: RenderDependency; version: number }> = [];
  const previous = setActiveRenderCollector({
    add: (dependency) => dependencies.push({
      dependency,
      version: dependency.getRenderVersion(),
    }),
  });
  try {
    read();
  } finally {
    setActiveRenderCollector(previous);
  }
  return dependencies;
}

interface GraphNodeInspection {
  deps?: GraphLinkInspection;
  subs?: GraphLinkInspection;
}

interface GraphLinkInspection {
  dep: GraphNodeInspection;
  sub: GraphNodeInspection;
  nextDep?: GraphLinkInspection;
  nextSub?: GraphLinkInspection;
}

function graphNodeOf(readable: object): GraphNodeInspection {
  const [nodeKey] = Object.getOwnPropertySymbols(readable);
  if (nodeKey === undefined) throw new Error("Candidate readable has no graph node");
  return Reflect.get(readable, nodeKey) as GraphNodeInspection;
}

describe("private low-level runtime spike", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("implements writable source reads, peeks, and Object.is changes natively", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(source.value);
    });

    source.value = 0;
    expect(source.getRenderVersion()).toBe(0);
    source.value = -0;
    expect(source.getRenderVersion()).toBe(1);
    source.value = Number.NaN;
    expect(source.getRenderVersion()).toBe(2);
    source.value = Number.NaN;
    expect(source.getRenderVersion()).toBe(2);

    expect(Object.is(source.peek(), Number.NaN)).toBe(true);
    expect(seen).toHaveLength(3);
    expect(Object.is(seen[0], 0)).toBe(true);
    expect(Object.is(seen[1], -0)).toBe(true);
    expect(Number.isNaN(seen[2])).toBe(true);
    dispose();
  });

  it("evaluates computeds lazily, caches them, and composes derived nodes", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(2);
    let firstCalls = 0;
    let secondCalls = 0;
    const doubled = runtime.computed(() => {
      firstCalls += 1;
      return source.value * 2;
    });
    const plusOne = runtime.computed(() => {
      secondCalls += 1;
      return doubled.value + 1;
    });

    expect(firstCalls).toBe(0);
    expect(plusOne.value).toBe(5);
    expect(plusOne.value).toBe(5);
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    source.value = 3;
    expect(plusOne.value).toBe(7);
    expect([firstCalls, secondCalls]).toEqual([2, 2]);
  });

  it("switches computed and effect dependencies and unlinks the old branch", () => {
    const runtime = createLowLevelRuntime();
    const chooseLeft = runtime.signal(true);
    const left = runtime.signal("left");
    const right = runtime.signal("right");
    const selected = runtime.computed(() => chooseLeft.value ? left.value : right.value);
    const seen: string[] = [];
    const dispose = runtime.effect(() => {
      seen.push(selected.value);
    });

    left.value = "left updated";
    chooseLeft.value = false;
    left.value = "left ignored";
    right.value = "right updated";

    expect(seen).toEqual(["left", "left updated", "right", "right updated"]);
    dispose();
  });

  it("propagates a diamond graph once and supports nested computed reads", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const left = runtime.computed(() => source.value + 1);
    const right = runtime.computed(() => source.value * 2);
    const total = runtime.computed(() => left.value + right.value);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(total.value);
    });

    source.value = 2;
    expect(seen).toEqual([4, 7]);
    dispose();
  });

  it("runs effects synchronously, reruns on writes, and disposes idempotently", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(source.value);
    });

    expect(seen).toEqual([1]);
    source.value = 2;
    dispose();
    dispose();
    source.value = 3;
    expect(seen).toEqual([1, 2]);
  });

  it("runs and disposes effect cleanups before the next body", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const order: string[] = [];
    const dispose = runtime.effect(() => {
      const value = source.value;
      order.push(`run:${value}`);
      return () => order.push(`cleanup:${value}`);
    });

    source.value = 2;
    dispose();
    expect(order).toEqual(["run:1", "cleanup:1", "run:2", "cleanup:2"]);
  });

  it("self-disposes without collecting later reads and runs returned cleanup once", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const laterRead = runtime.signal(0);
    const cleanupRead = runtime.signal(0);
    const seen: number[] = [];
    const cleanupValues: number[] = [];
    let dispose: (() => void) | undefined;
    dispose = runtime.effect(() => {
      const value = source.value;
      seen.push(value);
      if (value === 1) {
        dispose?.();
        laterRead.value;
      }
      return () => cleanupValues.push(cleanupRead.value);
    });

    source.value = 1;
    expect(seen).toEqual([0, 1]);
    expect(cleanupValues).toEqual([0, 0]);
    dispose();
    dispose();
    source.value = 2;
    laterRead.value = 1;
    cleanupRead.value = 1;
    expect(seen).toEqual([0, 1]);
    expect(cleanupValues).toEqual([0, 0]);
    expect(graphNodeOf(laterRead).subs).toBeUndefined();
  });

  it("fully detaches old source and computed dependencies when self-disposing before rereads", () => {
    const runtime = createLowLevelRuntime();
    const a = runtime.signal(0);
    const upstream = runtime.signal(1);
    const b = runtime.computed(() => upstream.value * 2);
    let runs = 0;
    let dispose: (() => void) | undefined;
    dispose = runtime.effect(() => {
      runs += 1;
      if (runs === 2) {
        dispose?.();
        return;
      }
      a.value;
      b.value;
    });

    const reaction = graphNodeOf(a).subs?.sub;
    expect(reaction).toBeDefined();
    expect(graphNodeOf(b).subs).toBeDefined();
    expect(graphNodeOf(b).deps).toBeDefined();
    expect(graphNodeOf(upstream).subs).toBeDefined();

    a.value = 1;

    expect(runs).toBe(2);
    expect(reaction!.deps).toBeUndefined();
    expect(graphNodeOf(a).subs).toBeUndefined();
    expect(graphNodeOf(b).subs).toBeUndefined();
    expect(graphNodeOf(b).deps).toBeUndefined();
    expect(graphNodeOf(upstream).subs).toBeUndefined();
    upstream.value = 2;
    a.value = 2;
    expect(runs).toBe(2);
    dispose?.();
  });

  it("fully detaches partially retracked dependencies when self-disposing", () => {
    const runtime = createLowLevelRuntime();
    const a = runtime.signal(0);
    const b = runtime.signal(0);
    const c = runtime.signal(0);
    let secondRun = false;
    let runs = 0;
    let dispose: (() => void) | undefined;
    dispose = runtime.effect(() => {
      runs += 1;
      if (secondRun) {
        a.value;
        dispose?.();
        return;
      }
      a.value;
      b.value;
      c.value;
    });
    const reaction = graphNodeOf(a).subs?.sub;
    expect(reaction).toBeDefined();

    secondRun = true;
    a.value = 1;

    expect(runs).toBe(2);
    expect(reaction!.deps).toBeUndefined();
    expect(graphNodeOf(a).subs).toBeUndefined();
    expect(graphNodeOf(b).subs).toBeUndefined();
    expect(graphNodeOf(c).subs).toBeUndefined();
    b.value = 1;
    c.value = 1;
    expect(runs).toBe(2);
    dispose?.();
  });

  it("contains a throwing cleanup returned by a self-disposing effect", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: number[] = [];
    let dispose: (() => void) | undefined;
    dispose = runtime.effect(() => {
      const value = source.value;
      seen.push(value);
      if (value === 1) dispose?.();
      return () => {
        if (value === 1) throw new Error("self-dispose cleanup failed");
      };
    });

    source.value = 1;
    expect(seen).toEqual([0, 1]);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]?.[0]).toContain("cleanup callback threw");
    dispose();
    source.value = 2;
    expect(seen).toEqual([0, 1]);
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it("does not run a queued reaction after it is disposed", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const seen: number[] = [];
    let disposeQueued: (() => void) | undefined;
    disposeQueued = runtime.effect(() => {
      seen.push(source.value);
    });
    const disposeFirst = runtime.effect(() => {
      const value = source.value;
      if (value === 1) disposeQueued?.();
    });

    runtime.batch(() => {
      source.value = 1;
      disposeQueued?.();
    });
    source.value = 2;
    expect(seen).toEqual([0]);
    disposeFirst();
    disposeQueued();
  });

  it("keeps nested candidate effects flat unless their disposer is returned", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const seen: number[] = [];
    let disposeInner: (() => void) | undefined;
    const disposeOuter = runtime.effect(() => {
      source.value;
      disposeInner ??= runtime.effect(() => {
        seen.push(source.value);
      });
    });

    disposeOuter();
    source.value = 1;
    expect(seen).toEqual([0, 1]);
    disposeInner?.();
  });

  it("composes nested effect lifetime through returned cleanup", () => {
    const runtime = createLowLevelRuntime();
    const generation = runtime.signal(0);
    const child = runtime.signal(0);
    const events: string[] = [];
    const disposeOuter = runtime.effect(() => {
      const id = generation.value;
      events.push(`outer:${id}`);
      const disposeInner = runtime.effect(() => {
        const value = child.value;
        events.push(`inner:${id}:${value}`);
        return () => events.push(`cleanup:${id}`);
      });
      return disposeInner;
    });

    expect(events).toEqual(["outer:0", "inner:0:0"]);
    generation.value = 1;
    expect(events).toEqual(["outer:0", "inner:0:0", "cleanup:0", "outer:1", "inner:1:0"]);
    child.value = 1;
    expect(events.at(-1)).toBe("inner:1:1");
    expect(events.filter((event) => event === "inner:0:1")).toHaveLength(0);

    disposeOuter();
    expect(events.at(-1)).toBe("cleanup:1");
    const eventCount = events.length;
    expect(graphNodeOf(child).subs).toBeUndefined();
    child.value = 2;
    expect(events).toHaveLength(eventCount);
  });

  it("coalesces nested batches and restores depth after a thrown callback", () => {
    const runtime = createLowLevelRuntime();
    const left = runtime.signal(1);
    const right = runtime.signal(2);
    const total = runtime.computed(() => left.value + right.value);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(total.value);
    });

    runtime.batch(() => {
      left.value = 2;
      runtime.batch(() => {
        right.value = 3;
      });
      expect(seen).toEqual([3]);
    });
    expect(seen).toEqual([3, 5]);
    expect(() => runtime.batch(() => {
      left.value = 4;
      throw new Error("batch failed");
    })).toThrow("batch failed");
    right.value = 4;
    expect(seen).toEqual([3, 5, 7, 8]);
    dispose();
  });

  it("compares batched final source values with Object.is", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(source.value);
    });

    runtime.batch(() => {
      source.value = 1;
      expect(source.peek()).toBe(1);
      runtime.batch(() => {
        source.value = 2;
      });
      source.value = 0;
    });
    expect(seen).toEqual([0]);
    expect(source.getRenderVersion()).toBe(3);

    runtime.batch(() => {
      source.value = -0;
    });
    expect(seen).toHaveLength(2);
    expect(Object.is(seen[1], -0)).toBe(true);

    runtime.batch(() => {
      source.value = 0;
    });
    expect(seen).toHaveLength(3);
    expect(Object.is(seen[2], 0)).toBe(true);
    dispose();

    const nanRuntime = createLowLevelRuntime();
    const nanSource = nanRuntime.signal(Number.NaN);
    const nanSeen: number[] = [];
    const disposeNan = nanRuntime.effect(() => {
      nanSeen.push(nanSource.value);
    });
    nanRuntime.batch(() => {
      nanSource.value = 1;
      nanSource.value = Number.NaN;
    });
    expect(nanSeen).toHaveLength(1);
    expect(Number.isNaN(nanSource.peek())).toBe(true);
    expect(nanSource.getRenderVersion()).toBe(2);
    disposeNan();
  });

  it("keeps nested computed reads coherent across an intermediate batch revert", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const first = runtime.computed(() => source.value);
    const second = runtime.computed(() => first.value * 10);
    const revisions: number[] = [];
    const [initial] = collectWithVersions(() => {
      expect(second.value).toBe(0);
    });
    revisions.push(initial!.version);

    runtime.batch(() => {
      source.value = 1;
      expect(second.value).toBe(10);
      expect(second.peek()).toBe(10);
      revisions.push(second.getRenderVersion());
      source.value = 0;
    });

    expect(second.value).toBe(0);
    expect(second.getRenderVersion()).toBeGreaterThan(revisions[1]!);
    source.value = 2;
    expect(second.value).toBe(20);
  });

  it("handles writes from inside reactions without corrupting propagation", () => {
    const runtime = createLowLevelRuntime();
    const trigger = runtime.signal(0);
    const output = runtime.signal(0);
    const seen: number[] = [];
    const disposeWriter = runtime.effect(() => {
      const value = trigger.value;
      if (value > 0) output.value = value * 2;
    });
    const disposeReader = runtime.effect(() => {
      seen.push(output.value);
    });

    trigger.value = 1;
    expect(seen).toEqual([0, 2]);
    expect(output.value).toBe(2);
    disposeWriter();
    disposeReader();
  });

  it("supports untracked reads and restores tracking after errors", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const other = runtime.signal(2);
    const seen: number[] = [];
    const dispose = runtime.effect(() => {
      seen.push(source.value);
      runtime.untracked(() => other.value);
    });

    other.value = 3;
    expect(seen).toEqual([1]);
    expect(() => runtime.untracked(() => {
      throw new Error("untracked failure");
    })).toThrow("untracked failure");
    source.value = 2;
    expect(seen).toEqual([1, 2]);
    dispose();
  });

  it("caches computed errors, rethrows on reads, and recovers downstream", () => {
    const runtime = createLowLevelRuntime();
    const shouldThrow = runtime.signal(false);
    const source = runtime.signal(2);
    const derived = runtime.computed(() => {
      if (shouldThrow.value) throw new Error("computed failed");
      return source.value * 2;
    });
    const seen: Array<number | string> = [];
    const dispose = runtime.effect(() => {
      try {
        seen.push(derived.value);
      } catch {
        seen.push("error");
      }
    });

    shouldThrow.value = true;
    expect(() => derived.value).toThrow("computed failed");
    shouldThrow.value = false;
    source.value = 3;
    expect(seen).toEqual([4, "error", 4, 6]);
    dispose();
  });

  it("recovers from a computed self-cycle after a caught cycle error", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    let value: { readonly value: number };
    value = runtime.computed(() => {
      if (source.value === 0) {
        try {
          return value.value;
        } catch {
          return -1;
        }
      }
      return source.value;
    });

    expect(value.value).toBe(-1);
    source.value = 1;
    expect(value.value).toBe(1);
  });

  it("contains effect-body failures and continues healthy queued work", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = runtime.effect(() => {
      source.value;
      if (source.peek() > 0) throw new Error("effect failed");
    });
    const healthyValues: number[] = [];
    const healthy = runtime.effect(() => {
      healthyValues.push(source.value);
    });

    source.value = 1;
    expect(healthyValues).toEqual([0, 1]);
    expect(reported).toHaveBeenCalled();
    source.value = 2;
    expect(healthyValues).toEqual([0, 1, 2]);
    failing();
    healthy();
  });

  it("contains cleanup failures before rerun and during disposal", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const values: number[] = [];
    const dispose = runtime.effect(() => {
      const value = source.value;
      values.push(value);
      return () => {
        throw new Error(`cleanup ${value}`);
      };
    });

    source.value = 1;
    expect(values).toEqual([0, 1]);
    expect(reported).toHaveBeenCalledTimes(1);
    dispose();
    expect(reported).toHaveBeenCalledTimes(2);
    source.value = 2;
    expect(values).toEqual([0, 1]);
  });

  it("subscribes directly to source and computed nodes without effect bridges", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const sourceListener = vi.fn();
    const computedListener = vi.fn();
    const disposeSource = runtime.subscribe(source, sourceListener);
    const disposeComputed = runtime.subscribe(parity, computedListener);

    source.value = 3;
    expect(sourceListener).toHaveBeenCalledTimes(1);
    expect(computedListener).not.toHaveBeenCalled();
    source.value = 4;
    expect(sourceListener).toHaveBeenCalledTimes(2);
    expect(computedListener).toHaveBeenCalledTimes(1);
    disposeComputed();
    disposeSource();
    source.value = 5;
    expect(sourceListener).toHaveBeenCalledTimes(2);
    expect(computedListener).toHaveBeenCalledTimes(1);
  });

  it("keeps direct computed subscriptions on their dynamically selected branch", () => {
    const runtime = createLowLevelRuntime();
    const useLeft = runtime.signal(true);
    const left = runtime.signal("left");
    const right = runtime.signal("right");
    const selected = runtime.computed(() => useLeft.value ? left.value : right.value);
    const listener = vi.fn();
    const dispose = runtime.subscribe(selected, listener);

    left.value = "left updated";
    useLeft.value = false;
    left.value = "left ignored";
    right.value = "right updated";
    expect(listener).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("notifies direct computed subscribers for value-error-error-value transitions", () => {
    const runtime = createLowLevelRuntime();
    const shouldThrow = runtime.signal(false);
    const revision = runtime.signal(0);
    const reusedError = new Error("computed failed");
    const derived = runtime.computed(() => {
      revision.value;
      if (shouldThrow.value) throw reusedError;
      return revision.value;
    });
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listener = vi.fn();
    const dispose = runtime.subscribe(derived, listener);

    shouldThrow.value = true;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reported).not.toHaveBeenCalled();
    expect(() => derived.value).toThrow(reusedError);

    revision.value = 1;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reported).not.toHaveBeenCalled();
    expect(() => derived.value).toThrow(reusedError);

    shouldThrow.value = false;
    expect(listener).toHaveBeenCalledTimes(3);
    expect(reported).not.toHaveBeenCalled();
    expect(derived.value).toBe(1);
    dispose();
  });

  it("exposes source and computed nodes to render collection with coherent versions", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const [sourceDependency] = collect(() => source.value);
    const [computedDependency] = collect(() => parity.value);
    expect(sourceDependency).toBeDefined();
    expect(computedDependency).toBeDefined();

    const sourceListener = vi.fn();
    const computedListener = vi.fn();
    const sourceVersion = sourceDependency!.getRenderVersion();
    const computedVersion = computedDependency!.getRenderVersion();
    const disposeSource = sourceDependency!.subscribeRender(sourceListener);
    const disposeComputed = computedDependency!.subscribeRender(computedListener);

    source.value = 3;
    expect(sourceListener).toHaveBeenCalledTimes(1);
    expect(sourceDependency!.getRenderVersion()).toBe(sourceVersion + 1);
    expect(computedListener).not.toHaveBeenCalled();
    expect(computedDependency!.getRenderVersion()).toBe(computedVersion);
    source.value = 4;
    expect(computedListener).toHaveBeenCalledTimes(1);
    expect(computedDependency!.getRenderVersion()).toBe(computedVersion + 1);
    disposeSource();
    disposeComputed();
    source.value = 5;
    expect(sourceListener).toHaveBeenCalledTimes(2);
    expect(computedListener).toHaveBeenCalledTimes(1);
  });

  it("defers computed graph subscription until render commit and catches render-to-commit changes", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const [dependency] = collect(() => {
      expect(parity.value).toBe(1);
    });
    const listener = vi.fn();
    expect(dependency).toBeDefined();

    source.value = 2;
    const versionBeforeCommit = dependency!.getRenderVersion();
    const dispose = dependency!.subscribeRender(listener);
    expect(listener).not.toHaveBeenCalled();
    expect(dependency!.getRenderVersion()).toBeGreaterThan(versionBeforeCommit);
    if (dependency!.getRenderVersion() !== versionBeforeCommit) listener();
    expect(listener).toHaveBeenCalledTimes(1);

    source.value = 4;
    expect(listener).toHaveBeenCalledTimes(1);
    source.value = 5;
    expect(listener).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("observes computed snapshots before registering the render dependency", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    const value = runtime.computed(() => source.value);
    let capturedVersion = -1;
    const previous = setActiveRenderCollector({
      add: (dependency) => {
        capturedVersion = dependency.getRenderVersion();
      },
    });
    try {
      expect(value.value).toBe(0);
    } finally {
      setActiveRenderCollector(previous);
    }
    expect(capturedVersion).toBe(value.getRenderVersion());
  });

  it("uses monotonic computed revisions for competing and reverted render attempts", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal("A");
    const value = runtime.computed(() => source.value);
    const [renderA] = collectWithVersions(() => {
      expect(value.value).toBe("A");
    });
    expect(renderA).toBeDefined();
    const revisionA = renderA!.version;

    source.value = "B";
    const [renderB] = collectWithVersions(() => {
      expect(value.value).toBe("B");
    });
    expect(renderB!.version).toBeGreaterThan(revisionA);
    const revisionB = value.getRenderVersion();

    source.value = "A";
    const [renderAfterRevert] = collectWithVersions(() => {
      expect(value.value).toBe("A");
    });
    expect(renderAfterRevert!.version).toBeGreaterThan(revisionB);
    expect(value.getRenderVersion()).toBeGreaterThan(revisionB);

    const committedListener = vi.fn();
    const dispose = renderA!.dependency.subscribeRender(committedListener);
    if (renderA!.dependency.getRenderVersion() !== renderA!.version) {
      committedListener();
    }
    expect(committedListener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("suppresses computed render revision changes when the result is Object.is-equal", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(1);
    const parity = runtime.computed(() => source.value % 2);
    const [firstRender] = collectWithVersions(() => {
      expect(parity.value).toBe(1);
    });
    source.value = 3;
    const [sameResultRender] = collectWithVersions(() => {
      expect(parity.value).toBe(1);
    });
    expect(sameResultRender!.version).toBe(firstRender!.version);
    expect(parity.getRenderVersion()).toBe(firstRender!.version);
  });

  it("advances computed observation revision for speculative error transitions", () => {
    const runtime = createLowLevelRuntime();
    const shouldThrow = runtime.signal(false);
    const source = runtime.signal(0);
    const error = new Error("rendered computed failure");
    const value = runtime.computed(() => {
      if (shouldThrow.value) throw error;
      return source.value;
    });
    const [render] = collectWithVersions(() => {
      expect(value.value).toBe(0);
    });
    const initialRevision = render!.version;
    shouldThrow.value = true;
    collectWithVersions(() => {
      expect(() => value.value).toThrow(error);
    });
    expect(value.getRenderVersion()).toBeGreaterThan(initialRevision);

    const listener = vi.fn();
    const dispose = render!.dependency.subscribeRender(listener);
    if (render!.dependency.getRenderVersion() !== render!.version) listener();
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not subscribe abandoned speculative renders to the graph", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    let getterCalls = 0;
    const value = runtime.computed(() => {
      getterCalls += 1;
      return source.value;
    });
    collect(() => {
      expect(value.value).toBe(0);
    });

    expect(graphNodeOf(source).subs).toBeUndefined();
    expect(graphNodeOf(value).deps).toBeUndefined();
    source.value = 1;
    expect(getterCalls).toBe(1);
    expect(value.peek()).toBe(1);
    expect(getterCalls).toBe(2);
  });

  it("settles identity-unstable computed render subscriptions after one cache fill", () => {
    const runtime = createLowLevelRuntime();
    const source = runtime.signal(0);
    let getterCalls = 0;
    const value = runtime.computed(() => {
      getterCalls += 1;
      return { value: source.value };
    });
    const [render] = collectWithVersions(() => {
      expect(value.value).toEqual({ value: 0 });
    });
    const listener = vi.fn();
    const dispose = render!.dependency.subscribeRender(listener);
    expect(value.getRenderVersion()).toBeGreaterThan(render!.version);
    expect(graphNodeOf(value).deps).toBeDefined();
    const settledRevision = value.getRenderVersion();
    const callsAfterCommit = getterCalls;
    const [nextRender] = collectWithVersions(() => {
      expect(value.value).toEqual({ value: 0 });
    });
    expect(nextRender!.version).toBe(settledRevision);
    expect(getterCalls).toBe(callsAfterCommit);
    dispose();
    expect(graphNodeOf(value).deps).toBeUndefined();
  });

  it("keeps candidate runtime instances independent", () => {
    const a = createLowLevelRuntime();
    const b = createLowLevelRuntime();
    const source = a.signal(1);
    const seen: number[] = [];
    const dispose = b.effect(() => {
      seen.push(source.value);
    });

    source.value = 2;
    expect(seen).toEqual([1]);
    expect(() => b.subscribe(source, () => undefined)).toThrow(
      "subscribe() expects a signal or computed from this runtime",
    );
    dispose();
  });
});
