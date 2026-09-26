/**
 * Experimental local-only runtime for Phase 5 architecture comparison.
 *
 * This is deliberately not exported from the package. It implements the local
 * signal/computed/effect core over alien-signals/system and omits React and
 * cross-runtime support so their costs can be measured separately later.
 */
import * as alienSystem from "alien-signals/system";
import type { ReactiveNode } from "alien-signals/system";

// alien-signals/system declares these as a const enum, so keep the runtime
// values local just as alien-signals' high-level entry does.
const Mutable = 1;
const Watching = 2;
const RecursedCheck = 4;
const Dirty = 16;
const Pending = 32;
const { createReactiveSystem } = alienSystem;

type SignalNode<T> = ReactiveNode & {
  currentValue: T;
  pendingValue: T;
};

type ComputedNode<T> = ReactiveNode & {
  getter: () => T;
  initialized: boolean;
  hasError: boolean;
  value: T | undefined;
  error: unknown;
};

type EffectNode = ReactiveNode & {
  fn: () => void | (() => void);
  cleanup: (() => void) | undefined;
  active: boolean;
  running: boolean;
  scheduled: boolean;
};

export interface LeanReadonlySignal<T> {
  readonly value: T;
  peek(): T;
  getRenderVersion(): number;
}

export interface LeanSignal<T> extends LeanReadonlySignal<T> {
  value: T;
}

export interface LeanRuntime {
  signal<T>(value: T): LeanSignal<T>;
  computed<T>(getter: () => T): LeanReadonlySignal<T>;
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
  speculate<T>(fn: () => T): { value: T; isCurrent(): boolean };
}

export function createLeanRuntime(
  onEffectError: (error: unknown) => void = reportError,
  options: { renderRevisionSidecar?: boolean } = {},
): LeanRuntime {
  let activeSub: ReactiveNode | undefined;
  let cycle = 0;
  let runDepth = 0;
  let batchDepth = 0;
  let notifyIndex = 0;
  let queuedLength = 0;
  const queue: Array<EffectNode | undefined> = [];
  const renderRevisions = options.renderRevisionSidecar
    ? new WeakMap<ReactiveNode, number>()
    : undefined;
  let activeRenderReads: Map<ReactiveNode, number> | undefined;
  const renderingComputeds = new Set<ReactiveNode>();

  const bumpRenderRevision = renderRevisions === undefined
    ? (_node: ReactiveNode) => {}
    : (node: ReactiveNode) => renderRevisions.set(node, (renderRevisions.get(node) ?? 0) + 1);
  const getRenderVersion = renderRevisions === undefined
    ? (_node: ReactiveNode) => 0
    : (node: ReactiveNode) => renderRevisions.get(node) ?? 0;

  const system = createReactiveSystem({
    update(node) {
      if ("getter" in node) return updateComputed(node as ComputedNode<unknown>);
      if ("currentValue" in node) {
        const source = node as SignalNode<unknown>;
        const changed = !Object.is(source.currentValue, source.pendingValue);
        source.currentValue = source.pendingValue;
        source.flags = Mutable;
        return changed;
      }
      node.flags = Mutable;
      return true;
    },
    notify(node) {
      let effect = node as EffectNode;
      let writeIndex = queuedLength;
      let firstWrite = writeIndex;
      for (;;) {
        effect.scheduled = true;
        queue[writeIndex++] = effect;
        effect.flags &= ~Watching;
        const next = effect.subs?.sub as EffectNode | undefined;
        if (next === undefined || !(next.flags & Watching)) break;
        effect = next;
      }
      queuedLength = writeIndex;
      while (firstWrite < --writeIndex) {
        const left = queue[firstWrite];
        queue[firstWrite++] = queue[writeIndex];
        queue[writeIndex] = left;
      }
    },
    unwatched() {},
  });

  const { link, unlink, propagate, checkDirty, shallowPropagate } = system;

  function track(node: ReactiveNode): void {
    const subscriber = activeSub;
    if (subscriber === undefined || subscriber === node) return;
    if ("fn" in subscriber) {
      const effect = subscriber as EffectNode;
      if (!effect.active) return;
    }
    link(node, subscriber, cycle);
  }

  function purgeDeps(subscriber: ReactiveNode): void {
    let depLink = subscriber.depsTail !== undefined
      ? subscriber.depsTail.nextDep
      : subscriber.deps;
    while (depLink !== undefined) depLink = unlink(depLink, subscriber);
  }

  function clearDepsTail(node: ReactiveNode): void {
    Object.assign(node, { depsTail: undefined });
  }

  function updateComputed<T>(node: ComputedNode<T>): boolean {
    if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
    const hadResult = node.initialized;
    const oldHadError = node.hasError;
    const oldValue = node.value;
    const oldError = node.error;
    clearDepsTail(node);
    node.flags = Mutable | RecursedCheck;
    const previousSub = activeSub;
    activeSub = node;
    try {
      cycle += 1;
      try {
        node.value = node.getter();
        node.error = undefined;
        node.hasError = false;
      } catch (error) {
        node.value = undefined;
        node.error = error;
        node.hasError = true;
      }
      node.initialized = true;
      if (!hadResult) return true;
      const changed = node.hasError || oldHadError || !Object.is(oldValue, node.value);
      if (changed) bumpRenderRevision(node);
      return changed;
    } finally {
      activeSub = previousSub;
      node.flags &= ~RecursedCheck;
      purgeDeps(node);
      // Retain these reads to make error->error equality behavior explicit in
      // this prototype: every reevaluation that throws invalidates dependents.
      void oldError;
    }
  }

  function readSignalCore<T>(node: SignalNode<T>): T {
    if (node.flags & Dirty) {
      const changed = !Object.is(node.currentValue, node.pendingValue);
      node.currentValue = node.pendingValue;
      node.flags = Mutable;
      if (changed && node.subs !== undefined) shallowPropagate(node.subs);
    }
    track(node);
    return node.currentValue;
  }

  function readSignalWithRender<T>(node: SignalNode<T>): T {
    if (activeRenderReads !== undefined) {
      activeRenderReads.set(node, getRenderVersion(node));
      return node.flags & Dirty ? node.pendingValue : node.currentValue;
    }
    return readSignalCore(node);
  }

  const readSignal = renderRevisions === undefined ? readSignalCore : readSignalWithRender;

  function readComputedCore<T>(node: ComputedNode<T>): T {
    if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
    const flags = node.flags;
    if (
      (flags & Dirty) ||
      ((flags & Pending) && node.deps !== undefined && checkDirty(node.deps, node))
    ) {
      if (updateComputed(node) && node.subs !== undefined) shallowPropagate(node.subs);
    } else if (!node.initialized) {
      updateComputed(node);
    }
    track(node);
    if (node.hasError) throw node.error;
    return node.value as T;
  }

  function readComputedWithRender<T>(node: ComputedNode<T>): T {
    if (activeRenderReads !== undefined) {
      if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
      activeRenderReads.set(node, getRenderVersion(node));
      const previousSub = activeSub;
      activeSub = undefined;
      renderingComputeds.add(node);
      try {
        return node.getter();
      } finally {
        renderingComputeds.delete(node);
        activeSub = previousSub;
      }
    }
    return readComputedCore(node);
  }

  const readComputed = renderRevisions === undefined ? readComputedCore : readComputedWithRender;

  function runCleanup(effect: EffectNode): void {
    const cleanup = effect.cleanup;
    effect.cleanup = undefined;
    if (cleanup === undefined) return;
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      cleanup();
    } catch (error) {
      safelyReport(error);
    } finally {
      activeSub = previousSub;
    }
  }

  function run(effect: EffectNode): void {
    if (!effect.active || effect.running) return;
    const flags = effect.flags;
    if (!(flags & Dirty) && (!(flags & Pending) || effect.deps === undefined || !checkDirty(effect.deps, effect))) {
      if (effect.deps !== undefined) effect.flags = Watching;
      return;
    }
    if (effect.cleanup !== undefined) {
      runCleanup(effect);
      if (!effect.active) return;
    }
    clearDepsTail(effect);
    effect.flags = Watching | RecursedCheck;
    effect.scheduled = false;
    effect.running = true;
    const previousSub = activeSub;
    activeSub = effect;
    try {
      cycle += 1;
      runDepth += 1;
      try {
        const cleanup = effect.fn();
        if (effect.active) effect.cleanup = cleanup || undefined;
        else if (typeof cleanup === "function") runCleanupValue(cleanup);
      } catch (error) {
        safelyReport(error);
      }
    } finally {
      runDepth -= 1;
      activeSub = previousSub;
      effect.running = false;
      effect.flags &= ~RecursedCheck;
      purgeDeps(effect);
      if (effect.active && !effect.scheduled) effect.flags |= Watching;
    }
  }

  function flush(): void {
    try {
      while (notifyIndex < queuedLength) {
        const effect = queue[notifyIndex];
        queue[notifyIndex++] = undefined;
        if (effect !== undefined) run(effect);
      }
    } finally {
      while (notifyIndex < queuedLength) {
        const effect = queue[notifyIndex];
        queue[notifyIndex++] = undefined;
        if (effect !== undefined) effect.flags |= Watching | Dirty;
      }
      notifyIndex = 0;
      queuedLength = 0;
    }
  }

  function safelyReport(error: unknown): void {
    try {
      onEffectError(error);
    } catch {
      // A failing reporter cannot break the graph flush.
    }
  }

  function untracked<T>(fn: () => T): T {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      return fn();
    } finally {
      activeSub = previousSub;
    }
  }

  function speculate<T>(fn: () => T): { value: T; isCurrent(): boolean } {
    if (renderRevisions === undefined) {
      throw new Error("speculate() requires renderRevisionSidecar");
    }
    const reads = new Map<ReactiveNode, number>();
    const previousReads = activeRenderReads;
    activeRenderReads = reads;
    let value: T;
    try {
      value = fn();
    } finally {
      activeRenderReads = previousReads;
    }
    return {
      value,
      isCurrent() {
        for (const [node, version] of reads) {
          if (getRenderVersion(node) !== version) return false;
        }
        return true;
      },
    };
  }

  function runCleanupValue(cleanup: () => void): void {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      cleanup();
    } catch (error) {
      safelyReport(error);
    } finally {
      activeSub = previousSub;
    }
  }

  return {
    signal<T>(initialValue: T): LeanSignal<T> {
      const node = {
        currentValue: initialValue,
        pendingValue: initialValue,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Mutable,
      } as unknown as SignalNode<T>;
      return {
        get value() { return readSignal(node); },
        set value(next: T) {
          if (Object.is(node.pendingValue, next)) return;
          node.pendingValue = next;
          bumpRenderRevision(node);
          node.flags = Mutable | Dirty;
          if (node.subs !== undefined) {
            propagate(node.subs, runDepth > 0);
            if (batchDepth === 0) flush();
          }
        },
        peek() { return untracked(() => node.currentValue); },
        getRenderVersion() { return getRenderVersion(node); },
      };
    },
    computed<T>(getter: () => T): LeanReadonlySignal<T> {
      const node = {
        getter,
        initialized: false,
        hasError: false,
        value: undefined,
        error: undefined,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: 0,
      } as unknown as ComputedNode<T>;
      return {
        get value() { return readComputed(node); },
        peek() { return untracked(() => readComputed(node)); },
        getRenderVersion() { return getRenderVersion(node); },
      };
    },
    effect(fn) {
      const effect = {
        fn,
        cleanup: undefined,
        active: true,
        running: false,
        scheduled: false,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Watching | RecursedCheck,
      } as unknown as EffectNode;
      // Unlike alien effect ownership, nested effects are flat unless the
      // caller explicitly returns their disposer as cleanup.
      effect.flags &= ~RecursedCheck;
      runInitial(effect);
      return () => {
        if (!effect.active) return;
        effect.active = false;
        effect.flags = 0;
        let dep = effect.depsTail;
        while (dep !== undefined) {
          const previous = dep.prevDep;
          unlink(dep, effect);
          dep = previous;
        }
        runCleanup(effect);
      };
    },
    batch<T>(fn: () => T): T {
      batchDepth += 1;
      try {
        return fn();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0) flush();
      }
    },
    untracked<T>(fn: () => T): T {
      return untracked(fn);
    },
    speculate,
  };

  function runInitial(effect: EffectNode): void {
    clearDepsTail(effect);
    const previousSub = activeSub;
    activeSub = effect;
    effect.running = true;
    runDepth += 1;
    try {
      try {
        effect.cleanup = effect.fn() || undefined;
      } catch (error) {
        safelyReport(error);
      }
    } finally {
      runDepth -= 1;
      activeSub = previousSub;
      effect.running = false;
      purgeDeps(effect);
      if (effect.active && !effect.scheduled) effect.flags |= Watching;
    }
  }
}

function reportError(error: unknown): void {
  try {
    console.error("Prototype A effect error (contained)", error);
  } catch {
    // Intentionally contained.
  }
  try {
    const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch {
    // Intentionally contained.
  }
}
