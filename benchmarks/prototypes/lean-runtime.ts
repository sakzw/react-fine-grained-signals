/**
 * Experimental local-only runtime for Phase 5 architecture comparison.
 *
 * This is deliberately not exported from the package. It implements the local
 * signal/computed/effect core over alien-signals/system and omits React and
 * cross-runtime support so their costs can be measured separately later.
 */
import * as alienSystem from "alien-signals/system";
import type { Link, ReactiveNode } from "alien-signals/system";
import { activeRenderCollector, hasActiveRenderCollector, notifyListener, untrackedRender } from "../../src/core/render-tracking.js";

// alien-signals/system declares these as a const enum, so keep the runtime
// values local just as alien-signals' high-level entry does.
const Mutable = 1;
const Watching = 2;
const RecursedCheck = 4;
const Dirty = 16;
const Pending = 32;
const { createReactiveSystem } = alienSystem;

type PrototypeNode = Omit<ReactiveNode, "deps" | "depsTail" | "subs" | "subsTail"> & {
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
};

type SignalNode<T> = PrototypeNode & {
  currentValue: T;
  pendingValue: T;
  revision: number;
  renderListeners: Set<() => void> | undefined;
  renderWatcher: RenderWatcherNode | undefined;
};
type SourceNode<T> = SignalNode<T>;

type ComputedNode<T> = PrototypeNode & {
  getter: () => T;
  initialized: boolean;
  hasError: boolean;
  value: T | undefined;
  error: unknown;
  revision: number;
  observedInitialized: boolean;
  observedHasError: boolean;
  observedValue: T | undefined;
  speculativeResult: { hasError: boolean; value: T | undefined; error: unknown } | undefined;
  speculativeDeps: Map<PrototypeNode, number> | undefined;
  renderListeners: Set<() => void> | undefined;
  renderWatcher: RenderWatcherNode | undefined;
};

type EffectNode = PrototypeNode & {
  fn: () => void | (() => void);
  cleanup: (() => void) | undefined;
  active: boolean;
  running: boolean;
  scheduled: boolean;
};

type RenderWatcherNode = PrototypeNode & {
  listener: () => void;
  scheduled: boolean;
  active: boolean;
};

export interface LeanReadonlySignal<T> {
  readonly value: T;
  peek(): T;
  getRenderVersion(): number;
  subscribeRender(listener: () => void): () => void;
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
): LeanRuntime {
  let activeSub: PrototypeNode | undefined;
  let cycle = 0;
  let runDepth = 0;
  let batchDepth = 0;
  let notifyIndex = 0;
  let queuedLength = 0;
  const queue: Array<(EffectNode | RenderWatcherNode) | undefined> = [];
  let activeRenderReads: Map<PrototypeNode, number> | undefined;
  let speculativeReads: Map<PrototypeNode, number> | undefined;
  let activeSpeculativeComputed: ComputedNode<unknown> | undefined;
  const renderingComputeds = new Set<PrototypeNode>();
  const bumpRenderRevision = (node: SourceNode<unknown> | ComputedNode<unknown>) => {
    node.revision += 1;
  };
  const getRenderVersion = (node: SourceNode<unknown> | ComputedNode<unknown>) => node.revision;
  const withoutRenderCollection = <T>(callback: () => T): T =>
    hasActiveRenderCollector() ? untrackedRender(callback) : callback();

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
      let effect = node as EffectNode | RenderWatcherNode;
      let writeIndex = queuedLength;
      let firstWrite = writeIndex;
      for (;;) {
        effect.scheduled = true;
        queue[writeIndex++] = effect;
        effect.flags &= ~Watching;
        const next = effect.subs?.sub as (EffectNode | RenderWatcherNode) | undefined;
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
    unwatched(node) {
      if (!("getter" in node) || node.depsTail === undefined) return;
      const computed = node as ComputedNode<unknown>;
      computed.flags = Mutable | Dirty;
      let dependency = computed.depsTail;
      while (dependency !== undefined) {
        const previous = dependency.prevDep;
        unlink(dependency, asReactiveNode(computed));
        dependency = previous;
      }
    },
  });

  const { link, unlink, propagate, checkDirty, shallowPropagate } = system;
  const asReactiveNode = (node: PrototypeNode): ReactiveNode => node as unknown as ReactiveNode;

  function track(node: PrototypeNode): void {
    const subscriber = activeSub;
    if (subscriber === undefined || subscriber === node) return;
    if ("fn" in subscriber) {
      const effect = subscriber as EffectNode;
      if (!effect.active) return;
    }
    link(asReactiveNode(node), asReactiveNode(subscriber), cycle);
  }

  function purgeDeps(subscriber: PrototypeNode): void {
    let depLink = subscriber.depsTail !== undefined
      ? subscriber.depsTail.nextDep
      : subscriber.deps;
    while (depLink !== undefined) depLink = unlink(depLink, asReactiveNode(subscriber));
  }

  function updateComputed<T>(node: ComputedNode<T>): boolean {
    if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
    const hadResult = node.initialized;
    const oldHadError = node.hasError;
    const oldValue = node.value;
    const oldError = node.error;
    node.depsTail = undefined;
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
      const changed = !hadResult || node.hasError || oldHadError || !Object.is(oldValue, node.value);
      settleComputedRevision(node, node.hasError, node.value, node.error, hadResult && (node.hasError || oldHadError));
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

  function settleComputedRevision<T>(
    node: ComputedNode<T>,
    hasError: boolean,
    value: T | undefined,
    error: unknown,
    repeatedErrorIsChange = false,
  ): void {
    if (node.observedInitialized) {
      const changed = repeatedErrorIsChange ||
        node.observedHasError !== hasError ||
        (!hasError && !Object.is(node.observedValue, value));
      if (changed) bumpRenderRevision(node as ComputedNode<unknown>);
    }
    node.observedInitialized = true;
    node.observedHasError = hasError;
    node.observedValue = value;
    void error;
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

  function readComputedCore<T>(node: ComputedNode<T>): T {
    if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
    const flags = node.flags;
    if (
      (flags & Dirty) ||
      ((flags & Pending) && node.deps !== undefined && checkDirty(node.deps, asReactiveNode(node)))
    ) {
      if (updateComputed(node) && node.subs !== undefined) shallowPropagate(node.subs);
    } else if (!node.initialized) {
      updateComputed(node);
    }
    track(node);
    if (node.hasError) throw node.error;
    return node.value as T;
  }

  function speculativeDependenciesAreCurrent(node: ComputedNode<unknown>): boolean {
    const deps = node.speculativeDeps;
    if (node.speculativeResult === undefined || deps === undefined) return false;
    for (const [dependency, revision] of deps) {
      if ("getter" in dependency) {
        const computed = dependency as ComputedNode<unknown>;
        if (!computedIsCurrent(computed)) return false;
      }
      if (getRenderVersion(dependency as SourceNode<unknown> | ComputedNode<unknown>) !== revision) return false;
    }
    return true;
  }

  function computedIsCurrent(node: ComputedNode<unknown>): boolean {
    if (node.initialized && !(node.flags & (Dirty | Pending))) return true;
    if (speculativeDependenciesAreCurrent(node)) return true;
    try { readComputedForRender(node); } catch { /* Errors are represented in the settled cache. */ }
    return speculativeDependenciesAreCurrent(node) || (node.initialized && !(node.flags & (Dirty | Pending)));
  }

  function evaluateSpeculatively<T>(node: ComputedNode<T>): { hasError: boolean; value: T | undefined; error: unknown } {
    if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
    renderingComputeds.add(node);
    const previousSub = activeSub;
    const previousReads = speculativeReads;
    const previousSpeculativeComputed = activeSpeculativeComputed;
    activeSub = undefined;
    const deps = new Map<PrototypeNode, number>();
    speculativeReads = deps;
    activeSpeculativeComputed = node as ComputedNode<unknown>;
    let result: { hasError: boolean; value: T | undefined; error: unknown };
    try {
      result = withoutRenderCollection(() => {
        try { return { hasError: false, value: node.getter(), error: undefined }; }
        catch (error) { return { hasError: true, value: undefined, error }; }
      });
    } finally {
      speculativeReads = previousReads;
      activeSpeculativeComputed = previousSpeculativeComputed;
      activeSub = previousSub;
      renderingComputeds.delete(node);
    }
    node.speculativeResult = result;
    node.speculativeDeps = deps;
    settleComputedRevision(node, result.hasError, result.value, result.error, result.hasError);
    return result;
  }

  function readComputedForRender<T>(node: ComputedNode<T>): T {
    if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
    const cleanGraph = node.initialized && !(node.flags & (Dirty | Pending));
    let result: { hasError: boolean; value: T | undefined; error: unknown };
    if (cleanGraph) {
      result = { hasError: node.hasError, value: node.value, error: node.error };
    } else if (speculativeDependenciesAreCurrent(node)) {
      result = node.speculativeResult as { hasError: boolean; value: T | undefined; error: unknown };
    } else {
      result = evaluateSpeculatively(node);
    }
    if (activeRenderReads !== undefined && !activeRenderReads.has(node)) {
      activeRenderReads.set(node, getRenderVersion(node));
    }
    if (speculativeReads !== undefined && node !== activeSpeculativeComputed && !speculativeReads.has(node)) {
      speculativeReads.set(node, getRenderVersion(node));
    }
    if (result.hasError) throw result.error;
    return result.value as T;
  }

  function promoteSpeculativeCache<T>(node: ComputedNode<T>): boolean {
    if (node.initialized && !(node.flags & (Dirty | Pending))) return true;
    if (!speculativeDependenciesAreCurrent(node)) return false;
    const result = node.speculativeResult as { hasError: boolean; value: T | undefined; error: unknown };
    const deps = node.speculativeDeps as Map<PrototypeNode, number>;
    for (const dependency of deps.keys()) {
      if ("getter" in dependency) promoteSpeculativeCache(dependency as ComputedNode<unknown>);
    }
    node.value = result.value;
    node.error = result.error;
    node.hasError = result.hasError;
    node.initialized = true;
    node.depsTail = undefined;
    node.flags = Mutable | RecursedCheck;
    const previousSub = activeSub;
    activeSub = node;
    cycle += 1;
    try {
      for (const dependency of deps.keys()) link(asReactiveNode(dependency), asReactiveNode(node), cycle);
    } finally {
      activeSub = previousSub;
      node.flags &= ~RecursedCheck;
    }
    purgeDeps(node);
    return true;
  }

  function readComputed<T>(node: ComputedNode<T>): T {
    if (activeRenderReads !== undefined || hasActiveRenderCollector()) return readComputedForRender(node);
    if (speculativeReads !== undefined) return readComputedForRender(node);
    if (!node.initialized || node.flags & (Dirty | Pending)) promoteSpeculativeCache(node);
    return readComputedCore(node);
  }

  function runCleanup(effect: EffectNode): void {
    const cleanup = effect.cleanup;
    effect.cleanup = undefined;
    if (cleanup === undefined) return;
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      withoutRenderCollection(cleanup);
    } catch (error) {
      safelyReport(error);
    } finally {
      activeSub = previousSub;
    }
  }

  function run(effect: EffectNode): void {
    if (!effect.active || effect.running) return;
    const flags = effect.flags;
    if (!(flags & Dirty) && (!(flags & Pending) || effect.deps === undefined || !checkDirty(effect.deps, asReactiveNode(effect)))) {
      if (effect.deps !== undefined) effect.flags = Watching;
      return;
    }
    if (effect.cleanup !== undefined) {
      runCleanup(effect);
      if (!effect.active) return;
    }
    effect.depsTail = undefined;
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

  function runRenderWatcher(watcher: RenderWatcherNode): void {
    if (!watcher.active || !watcher.scheduled) return;
    watcher.scheduled = false;
    const flags = watcher.flags;
    if (!(flags & Dirty) && (!(flags & Pending) || watcher.deps === undefined || !checkDirty(watcher.deps, asReactiveNode(watcher)))) {
      if (watcher.deps !== undefined) watcher.flags = Watching;
      return;
    }
    watcher.flags = Watching;
    if (watcher.listener !== undefined) withoutRenderCollection(watcher.listener);
    if (watcher.scheduled) watcher.flags &= ~Watching;
  }

  function subscribeRenderNode(
    node: SignalNode<unknown> | ComputedNode<unknown>,
    listener: () => void,
  ): () => void {
    const listeners = (node.renderListeners ??= new Set());
    const wasEmpty = listeners.size === 0;
    listeners.add(listener);
    if (wasEmpty) {
      const watcher: RenderWatcherNode = {
        listener: () => {
          const activeListeners = node.renderListeners;
          if (activeListeners === undefined) return;
          // Snapshot before invoking React so subscriber mutation is safe.
          // oxlint-disable-next-line unicorn/no-useless-spread
          for (const renderListener of [...activeListeners]) {
            notifyListener(renderListener);
          }
        },
        scheduled: false,
        active: true,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Watching | RecursedCheck,
      };
      node.renderWatcher = watcher;
      const previousSub = activeSub;
      activeSub = watcher;
      try {
        cycle += 1;
        if ("getter" in node) {
          const computed = node as ComputedNode<unknown>;
          promoteSpeculativeCache(computed);
          readComputedCore(computed);
        }
        else readSignalCore(node as SignalNode<unknown>);
      } finally {
        activeSub = previousSub;
        watcher.flags &= ~RecursedCheck;
        purgeDeps(watcher);
        if (watcher.deps !== undefined) watcher.flags |= Watching;
      }
    }

    return () => {
      const current = node.renderListeners;
      if (current === undefined || !current.delete(listener)) return;
      if (current.size !== 0) return;
      node.renderListeners = undefined;
      const watcher = node.renderWatcher;
      node.renderWatcher = undefined;
      if (watcher === undefined) return;
      watcher.active = false;
      watcher.scheduled = false;
      watcher.flags = 0;
      let dep = watcher.depsTail;
      while (dep !== undefined) {
        const previous = dep.prevDep;
        unlink(dep, asReactiveNode(watcher));
        dep = previous;
      }
    };
  }

  function flush(): void {
    if (hasActiveRenderCollector()) {
      untrackedRender(flushQueue);
      return;
    }
    flushQueue();
  }

  function flushQueue(): void {
    try {
      while (notifyIndex < queuedLength) {
        const effect = queue[notifyIndex];
        queue[notifyIndex++] = undefined;
        if (effect !== undefined) {
          if ("fn" in effect) run(effect);
          else runRenderWatcher(effect);
        }
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
      return withoutRenderCollection(fn);
    } finally {
      activeSub = previousSub;
    }
  }

  function speculate<T>(fn: () => T): { value: T; isCurrent(): boolean } {
    const reads = new Map<PrototypeNode, number>();
    const previousReads = activeRenderReads;
    activeRenderReads = reads;
    let value: T;
    try {
      value = withoutRenderCollection(fn);
    } finally {
      activeRenderReads = previousReads;
    }
    return {
      value,
      isCurrent() {
        for (const [node, version] of reads) {
          if (getRenderVersion(node as SourceNode<unknown> | ComputedNode<unknown>) !== version) return false;
        }
        return true;
      },
    };
  }

  function runCleanupValue(cleanup: () => void): void {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      withoutRenderCollection(cleanup);
    } catch (error) {
      safelyReport(error);
    } finally {
      activeSub = previousSub;
    }
  }

  return {
    signal<T>(initialValue: T): LeanSignal<T> {
      const node: SignalNode<T> = {
        currentValue: initialValue,
        pendingValue: initialValue,
        revision: 0,
        renderListeners: undefined,
        renderWatcher: undefined,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Mutable,
      };
      const source: LeanSignal<T> = {
        get value() {
          if (speculativeReads !== undefined) {
            if (!speculativeReads.has(node)) speculativeReads.set(node, getRenderVersion(node));
            return node.flags & Dirty ? node.pendingValue : node.currentValue;
          }
          if (activeRenderReads !== undefined) {
            const reads = activeRenderReads;
            if (!reads.has(node)) reads.set(node, getRenderVersion(node));
            const value = node.flags & Dirty ? node.pendingValue : node.currentValue;
            activeRenderCollector?.add(source, reads.get(node)!);
            return value;
          }
          if (activeRenderCollector === undefined) return readSignalCore(node);
          activeRenderCollector.add(source, getRenderVersion(node));
          const value = node.flags & Dirty ? node.pendingValue : node.currentValue;
          return value;
        },
        set value(next: T) {
          if (Object.is(node.pendingValue, next)) return;
          node.pendingValue = next;
          bumpRenderRevision(node);
          node.flags = Mutable | Dirty;
          if (node.subs !== undefined) {
            propagate(node.subs, runDepth > 0);
            if (batchDepth === 0 && runDepth === 0) flush();
          }
        },
        peek() { return node.pendingValue; },
        getRenderVersion() { return getRenderVersion(node); },
        subscribeRender(listener) { return subscribeRenderNode(node, listener); },
      };
      return source;
    },
    computed<T>(getter: () => T): LeanReadonlySignal<T> {
      const node: ComputedNode<T> = {
        getter,
        initialized: false,
        hasError: false,
        value: undefined,
        error: undefined,
        revision: 0,
        observedInitialized: false,
        observedHasError: false,
        observedValue: undefined,
        speculativeResult: undefined,
        speculativeDeps: undefined,
        renderListeners: undefined,
        renderWatcher: undefined,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: 0,
      };
      const computed: LeanReadonlySignal<T> = {
        get value() {
          if (activeRenderReads !== undefined || speculativeReads !== undefined || activeRenderCollector !== undefined) {
            const value = readComputedForRender(node);
            if (activeRenderReads !== undefined) {
              const reads = activeRenderReads;
              if (!reads.has(node)) reads.set(node, getRenderVersion(node));
              activeRenderCollector?.add(computed, reads.get(node)!);
            } else if (activeRenderCollector !== undefined) {
              activeRenderCollector.add(computed, getRenderVersion(node));
            }
            return value;
          }
          if (!node.initialized || node.flags & (Dirty | Pending)) promoteSpeculativeCache(node);
          return readComputedCore(node);
        },
        peek() { return untracked(() => readComputed(node)); },
        getRenderVersion() { return getRenderVersion(node); },
        subscribeRender(listener) { return subscribeRenderNode(node, listener); },
      };
      return computed;
    },
    effect(fn) {
      const effect: EffectNode = {
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
      };
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
          unlink(dep, asReactiveNode(effect));
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
        if (batchDepth === 0 && runDepth === 0) flush();
      }
    },
    untracked<T>(fn: () => T): T {
      return untracked(fn);
    },
    speculate,
  };

  function runInitial(effect: EffectNode): void {
    effect.depsTail = undefined;
    const previousSub = activeSub;
    activeSub = effect;
    effect.running = true;
    runDepth += 1;
    try {
      try {
        effect.cleanup = withoutRenderCollection(effect.fn) || undefined;
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
    if (runDepth === 0 && batchDepth === 0) flush();
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
