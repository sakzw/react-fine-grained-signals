/** Private reactive graph used by the package's existing public wrappers. */
import * as alienSignalsSystem from "alien-signals/system";
import type { Link, ReactiveNode } from "alien-signals/system";
import {
  attachReadableInterop,
  getSharedInteropContext,
  isInteropSpeculative,
  withInteropSpeculativeMode,
  withoutInteropSpeculativeMode,
  type InteropGraphCollectorV1,
  type ReadableInteropV1,
  type SharedInteropContextV1,
} from "./interop.js";
import {
  activeRenderCollector,
  hasActiveRenderCollector,
  notifyListener,
  setActiveRenderCollector,
  type RenderDependency,
} from "./render-tracking.js";

const { createReactiveSystem } = alienSignalsSystem;
// ReactiveFlags is modeled as a const enum in the package declarations. Read
// the runtime values from the low-level system entry without importing Alien's
// high-level runtime.
const ReactiveFlags = (alienSignalsSystem as unknown as {
  readonly ReactiveFlags: {
    readonly None: number;
    readonly Mutable: number;
    readonly Watching: number;
    readonly RecursedCheck: number;
    readonly Dirty: number;
    readonly Pending: number;
  };
}).ReactiveFlags;
const Mutable = ReactiveFlags.Mutable;
const Watching = ReactiveFlags.Watching;
const RecursedCheck = ReactiveFlags.RecursedCheck;
const Dirty = ReactiveFlags.Dirty;
const Pending = ReactiveFlags.Pending;

// Hide only the component's outer collector, preserving a computed getter's
// own speculative dependency map.
function withoutComponentRenderCollection<T>(
  callback: () => T,
  sharedInterop: SharedInteropContextV1,
): T {
  if (!hasActiveRenderCollector() && sharedInterop.renderCollector === undefined) return callback();
  const previousLocal = setActiveRenderCollector();
  const previousShared = sharedInterop.renderCollector;
  sharedInterop.renderCollector = undefined;
  try {
    return callback();
  } finally {
    sharedInterop.renderCollector = previousShared;
    setActiveRenderCollector(previousLocal);
  }
}

type RuntimeNode = Omit<ReactiveNode, "deps" | "depsTail" | "subs" | "subsTail"> & {
  kind: "source" | "computed" | "reaction" | "renderWatcher" | "external";
  runtimeToken: object;
  externalProtocol?: ReadableInteropV1;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
};

type SignalNode<T> = RuntimeNode & {
  kind: "source";
  interop: ReadableInteropV1;
  currentValue: T;
  pendingValue: T;
  revision: number;
  renderListeners: Set<() => void> | undefined;
  renderWatcher: RenderWatcherNode | undefined;
  protocolListeners: Set<(revision: number) => void> | undefined;
  protocolWatcher: RenderWatcherNode | undefined;
};
type SourceNode<T> = SignalNode<T>;

type ComputedNode<T> = RuntimeNode & {
  kind: "computed";
  interop: ReadableInteropV1;
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
  speculativeDeps: Map<RuntimeNode | ReadableInteropV1, number> | undefined;
  speculativeCachePromotable: boolean;
  foreignDependent: boolean;
  live: boolean;
  renderListeners: Set<() => void> | undefined;
  renderWatcher: RenderWatcherNode | undefined;
  protocolListeners: Set<(revision: number) => void> | undefined;
  protocolWatcher: RenderWatcherNode | undefined;
};

type EffectNode = RuntimeNode & {
  kind: "reaction";
  fn: () => void | (() => void);
  cleanup: (() => void) | undefined;
  active: boolean;
  running: boolean;
  scheduled: boolean;
};

type RenderWatcherNode = RuntimeNode & {
  kind: "renderWatcher";
  listener: () => void;
  scheduled: boolean;
  active: boolean;
};

type ExternalNode = RuntimeNode & {
  kind: "external";
  externalProtocol: ReadableInteropV1;
  subscription: { unsubscribe(): void } | undefined;
  currentEpoch: number;
  pendingEpoch: number;
  lastForeignRevision: number;
};

type SpeculativeDependency = RuntimeNode | ReadableInteropV1;

export interface RuntimeReadonlySignal<T> extends RenderDependency {
  readonly value: T;
  peek(): T;
}

export interface RuntimeSignal<T> extends RuntimeReadonlySignal<T> {
  value: T;
}

export interface ReactiveRuntime {
  signal<T>(value: T): RuntimeSignal<T>;
  computed<T>(getter: () => T): RuntimeReadonlySignal<T>;
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
  subscribe<T>(source: RuntimeReadonlySignal<T>, listener: () => void): () => void;
  hasActiveSubscriber(): boolean;
  getBatchDepth(): number;
  hasSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
}

const READABLE_NODE = Symbol("reactive-runtime-readable-node");

type NodeBackedReadable<T> = RuntimeReadonlySignal<T> & {
  readonly [READABLE_NODE]: SignalNode<T> | ComputedNode<T>;
};

export function createReactiveRuntime(): ReactiveRuntime {
  const runtimeToken = {};
  const sharedInterop = getSharedInteropContext();
  let activeSub: RuntimeNode | undefined;
  let activeInteropSubscriber: RuntimeNode | undefined;
  let cycle = 0;
  let runDepth = 0;
  let batchDepth = 0;
  let notifyIndex = 0;
  let queuedLength = 0;
  const queue: Array<(EffectNode | RenderWatcherNode) | undefined> = [];
  let activeRenderReads: Map<RuntimeNode, number> | undefined;
  let speculativeReads: Map<SpeculativeDependency, number> | undefined;
  let activeSpeculativeComputed: ComputedNode<unknown> | undefined;
  const renderingComputeds = new Set<RuntimeNode>();
  const externalNodes = new WeakMap<ReadableInteropV1, ExternalNode>();
  const ownedReadables = new WeakSet<object>();
  const graphCollector: InteropGraphCollectorV1 = {
    runtimeToken,
    add(protocol, observedRevision) {
      if (protocol.runtimeToken === runtimeToken) return;
      if (speculativeReads !== undefined) {
        speculativeReads.set(protocol, observedRevision);
        return;
      }
      const subscriber = activeInteropSubscriber;
      if (subscriber === undefined || subscriber.runtimeToken !== runtimeToken) return;
      if ("fn" in subscriber && !(subscriber as EffectNode).active) return;
      const external = externalNodeFor(protocol, observedRevision);
      link(asReactiveNode(external), asReactiveNode(subscriber), cycle);
      if ("getter" in subscriber) (subscriber as ComputedNode<unknown>).foreignDependent = true;
      refreshDependencyLiveness(external);
    },
  };
  const bumpRenderRevision = (node: SourceNode<unknown> | ComputedNode<unknown>) => {
    node.revision += 1;
  };
  const getRenderVersion = (node: SourceNode<unknown> | ComputedNode<unknown>) => node.revision;
// Semantically untracked callbacks pause both runtime collectors as
  // well as the shared React collector, restoring nested scopes in a finally.
  const withoutAllRenderCollection = <T>(callback: () => T): T => {
    const previousRenderReads = activeRenderReads;
    const previousSpeculativeReads = speculativeReads;
    activeRenderReads = undefined;
    speculativeReads = undefined;
    try {
      return withoutComponentRenderCollection(callback, sharedInterop);
    } finally {
      activeRenderReads = previousRenderReads;
      speculativeReads = previousSpeculativeReads;
    }
  };

  const system = createReactiveSystem({
    update(node) {
      if ("externalProtocol" in node) {
        const external = node as ExternalNode;
        const changed = external.currentEpoch !== external.pendingEpoch;
        external.currentEpoch = external.pendingEpoch;
        external.flags = Mutable;
        return changed;
      }
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
      if ("externalProtocol" in node) {
        deactivateExternal(node as ExternalNode);
        return;
      }
      if (!("getter" in node)) return;
      const computed = node as ComputedNode<unknown>;
      setComputedLive(computed, false);
      if (computed.depsTail === undefined) return;
      computed.flags = Mutable | Dirty;
      let dependency: Link | undefined = computed.depsTail;
      while (dependency !== undefined) {
        const previous: Link | undefined = dependency.prevDep;
        unlinkDependency(dependency, computed);
        dependency = previous;
      }
    },
  });

  const { link, unlink, propagate, checkDirty, shallowPropagate } = system;
  const asReactiveNode = (node: RuntimeNode): ReactiveNode => node as unknown as ReactiveNode;

  function hasLiveConsumer(node: RuntimeNode): boolean {
    let subscriberLink = node.subs;
    while (subscriberLink !== undefined) {
      const subscriber = subscriberLink.sub as RuntimeNode;
      if ("fn" in subscriber && (subscriber as EffectNode).active) return true;
      if ("listener" in subscriber && (subscriber as RenderWatcherNode).active) return true;
      if ("getter" in subscriber && (subscriber as ComputedNode<unknown>).live) return true;
      subscriberLink = subscriberLink.nextSub;
    }
    return false;
  }

  function refreshDependencyLiveness(node: RuntimeNode): void {
    if ("externalProtocol" in node) {
      setExternalLive(node as ExternalNode, hasLiveConsumer(node));
    } else if ("getter" in node && (node as ComputedNode<unknown>).foreignDependent) {
      setComputedLive(node as ComputedNode<unknown>, hasLiveConsumer(node));
    }
  }

  function setComputedLive(node: ComputedNode<unknown>, live: boolean): void {
    if (node.live === live) return;
    node.live = live;
    let dependencyLink = node.deps;
    while (dependencyLink !== undefined) {
      refreshDependencyLiveness(dependencyLink.dep as RuntimeNode);
      dependencyLink = dependencyLink.nextDep;
    }
  }

  function synchronizeComputedLiveness(node: ComputedNode<unknown>): void {
    setComputedLive(node, node.foreignDependent && hasLiveConsumer(node));
  }

  function deactivateExternal(node: ExternalNode): void {
    const subscription = node.subscription;
    node.subscription = undefined;
    subscription?.unsubscribe();
  }

  function receiveExternalRevision(node: ExternalNode, revision: number): void {
    node.lastForeignRevision = revision;
    node.pendingEpoch += 1;
    node.flags |= Dirty;
    if (node.subs !== undefined) {
      propagate(node.subs, runDepth > 0);
      if (batchDepth === 0 && runDepth === 0) flush();
    }
  }

  function activateExternal(node: ExternalNode, observedRevision: number): void {
    node.lastForeignRevision = observedRevision;
    if (node.subscription !== undefined) return;
    const subscription = node.externalProtocol.subscribe((revision) => {
      receiveExternalRevision(node, revision);
    });
    node.subscription = subscription;
    if (subscription.revision !== observedRevision) {
      node.lastForeignRevision = subscription.revision;
      node.pendingEpoch += 1;
      node.flags |= Dirty;
      if (node.subs !== undefined) {
        propagate(node.subs, runDepth > 0);
        if (batchDepth === 0 && runDepth === 0) flush();
      }
    }
  }

  function setExternalLive(node: ExternalNode, live: boolean): void {
    if (live) activateExternal(node, node.lastForeignRevision);
    else deactivateExternal(node);
  }

  function externalNodeFor(
    protocol: ReadableInteropV1,
    observedRevision: number,
  ): ExternalNode {
    let node = externalNodes.get(protocol);
    if (node === undefined) {
      node = {
        kind: "external",
        runtimeToken,
        externalProtocol: protocol,
        subscription: undefined,
        currentEpoch: 0,
        pendingEpoch: 0,
        lastForeignRevision: observedRevision,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Mutable,
      };
      externalNodes.set(protocol, node);
    } else {
      node.lastForeignRevision = observedRevision;
    }
    return node;
  }

  function withTrackedGraph<T>(subscriber: RuntimeNode, callback: () => T): T {
    const previousSubscriber = activeInteropSubscriber;
    const previousCollector = sharedInterop.graphCollector;
    activeInteropSubscriber = subscriber;
    sharedInterop.graphCollector = graphCollector;
    try {
      return callback();
    } finally {
      activeInteropSubscriber = previousSubscriber;
      sharedInterop.graphCollector = previousCollector;
    }
  }

  function withoutGraphCollection<T>(callback: () => T): T {
    const previousCollector = sharedInterop.graphCollector;
    sharedInterop.graphCollector = undefined;
    try {
      return callback();
    } finally {
      sharedInterop.graphCollector = previousCollector;
    }
  }

  function publishForeignGraphRead(protocol: ReadableInteropV1, revision: number): void {
    const collector = sharedInterop.graphCollector;
    if (collector !== undefined && collector.runtimeToken !== protocol.runtimeToken) {
      collector.add(protocol, revision);
    }
  }

  function publishForeignRenderRead(protocol: ReadableInteropV1, revision: number): void {
    sharedInterop.renderCollector?.add(protocol, revision);
  }

  function unsubscribeGraphWatcher(watcher: RenderWatcherNode): void {
    watcher.active = false;
    watcher.scheduled = false;
    watcher.flags = 0;
    let dependency = watcher.depsTail;
    while (dependency !== undefined) {
      const previous = dependency.prevDep;
      unlinkDependency(dependency, watcher);
      dependency = previous;
    }
  }

  function createGraphWatcher(
    node: SignalNode<unknown> | ComputedNode<unknown>,
    listener: () => void,
  ): RenderWatcherNode {
    const watcher: RenderWatcherNode = {
      kind: "renderWatcher",
      runtimeToken,
      listener,
      scheduled: false,
      active: true,
      deps: undefined,
      depsTail: undefined,
      subs: undefined,
      subsTail: undefined,
      flags: Watching | RecursedCheck,
    };
    const previousSub = activeSub;
    activeSub = watcher;
    try {
      cycle += 1;
      try {
        withoutInteropSpeculativeMode(() => {
          if ("getter" in node) {
            promoteSpeculativeCache(node);
            readComputedCore(node);
          }
          else readSignalCore(node);
        });
      } catch {
        // A protocol watcher still tracks an errored computed boundary.
      }
    } finally {
      activeSub = previousSub;
      watcher.flags &= ~RecursedCheck;
      purgeDeps(watcher);
      if (watcher.deps !== undefined) watcher.flags |= Watching;
    }
    return watcher;
  }

  function subscribeProtocol(
    node: SignalNode<unknown> | ComputedNode<unknown>,
    listener: (revision: number) => void,
  ): { unsubscribe(): void; revision: number } {
    const listeners = (node.protocolListeners ??= new Set());
    const wasEmpty = listeners.size === 0;
    listeners.add(listener);
    if (wasEmpty) {
      node.protocolWatcher = createGraphWatcher(node, () => {
        const activeListeners = node.protocolListeners;
        if (activeListeners === undefined) return;
        for (const callback of Array.from(activeListeners)) {
          try { callback(node.revision); } catch { /* Keep the graph flush isolated. */ }
        }
      });
    }
    return {
      revision: node.revision,
      unsubscribe() {
        const current = node.protocolListeners;
        if (current === undefined || !current.delete(listener) || current.size !== 0) return;
        node.protocolListeners = undefined;
        const watcher = node.protocolWatcher;
        node.protocolWatcher = undefined;
        if (watcher !== undefined) unsubscribeGraphWatcher(watcher);
      },
    };
  }

  function createReadableProtocol(
    node: SignalNode<unknown> | ComputedNode<unknown>,
  ): ReadableInteropV1 {
    return Object.freeze({
      version: 1 as const,
      runtimeToken,
      getRevision: () => node.revision,
      subscribe: (listener: (revision: number) => void) => subscribeProtocol(node, listener),
    });
  }

  function track(node: RuntimeNode): void {
    const subscriber = activeSub;
    if (subscriber === undefined || subscriber === node) return;
    if ("fn" in subscriber) {
      const effect = subscriber as EffectNode;
      if (!effect.active) return;
    }
    link(asReactiveNode(node), asReactiveNode(subscriber), cycle);
    if ("externalProtocol" in node) {
      refreshDependencyLiveness(node);
      if ("getter" in subscriber) (subscriber as ComputedNode<unknown>).foreignDependent = true;
    } else if ("getter" in node && (node as ComputedNode<unknown>).foreignDependent && "getter" in subscriber) {
      (subscriber as ComputedNode<unknown>).foreignDependent = true;
    }
    if ("getter" in node && (node as ComputedNode<unknown>).foreignDependent) refreshDependencyLiveness(node);
  }

  function purgeDeps(subscriber: RuntimeNode): void {
    let depLink = subscriber.depsTail !== undefined
      ? subscriber.depsTail.nextDep
      : subscriber.deps;
    while (depLink !== undefined) depLink = unlinkDependency(depLink, subscriber);
  }

  function unlinkDependency(depLink: Link, subscriber: RuntimeNode): Link | undefined {
    const dependency = depLink.dep as RuntimeNode;
    const next = unlink(depLink, asReactiveNode(subscriber));
    refreshDependencyLiveness(dependency);
    return next;
  }

  function updateComputed<T>(node: ComputedNode<T>): boolean {
    if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
    const hadResult = node.initialized;
    const oldHadError = node.hasError;
    const oldValue = node.value;
    const oldError = node.error;
    node.depsTail = undefined;
    node.flags = Mutable | RecursedCheck;
    node.foreignDependent = false;
    const previousSub = activeSub;
    activeSub = node;
    try {
      cycle += 1;
      try {
        node.value = withoutInteropSpeculativeMode(() => withTrackedGraph(node, () =>
          withoutComponentRenderCollection(node.getter, sharedInterop)));
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
      synchronizeComputedLiveness(node);
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
    if (node.foreignDependent && !node.live) node.flags |= Dirty;
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
    if (!node.speculativeCachePromotable) return false;
    const deps = node.speculativeDeps;
    if (node.speculativeResult === undefined || deps === undefined) return false;
    for (const [dependency, revision] of deps) {
      if ("getRevision" in dependency) {
        const protocol = dependency as ReadableInteropV1;
        let subscription: { unsubscribe(): void; revision: number };
        try {
          subscription = protocol.subscribe(() => undefined);
        } catch {
          return false;
        }
        const currentRevision = subscription.revision;
        subscription.unsubscribe();
        if (currentRevision !== revision) return false;
        continue;
      }
      if ("getter" in dependency) {
        const computed = dependency as ComputedNode<unknown>;
        if (!computedIsCurrent(computed)) return false;
      }
      if (getRenderVersion(dependency as SourceNode<unknown> | ComputedNode<unknown>) !== revision) return false;
    }
    return true;
  }

  function computedIsCurrent(node: ComputedNode<unknown>): boolean {
    if (node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live)) return true;
    if (speculativeDependenciesAreCurrent(node)) return true;
    try { readComputedForRender(node); } catch { /* Errors are represented in the settled cache. */ }
    return speculativeDependenciesAreCurrent(node) ||
      (node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live));
  }

  function evaluateSpeculatively<T>(node: ComputedNode<T>): { hasError: boolean; value: T | undefined; error: unknown } {
    if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
    renderingComputeds.add(node);
    const previousSub = activeSub;
    const previousReads = speculativeReads;
    const previousSpeculativeComputed = activeSpeculativeComputed;
    activeSub = undefined;
    const deps = new Map<SpeculativeDependency, number>();
    speculativeReads = deps;
    activeSpeculativeComputed = node as ComputedNode<unknown>;
    const speculativeDeepReadEpoch = sharedInterop.speculativeDeepReadEpoch ?? 0;
    let result: { hasError: boolean; value: T | undefined; error: unknown };
    try {
      result = withInteropSpeculativeMode(() => withTrackedGraph(node, () => withoutComponentRenderCollection(() => {
        try { return { hasError: false, value: node.getter(), error: undefined }; }
        catch (error) { return { hasError: true, value: undefined, error }; }
      }, sharedInterop)));
    } finally {
      speculativeReads = previousReads;
      activeSpeculativeComputed = previousSpeculativeComputed;
      activeSub = previousSub;
      renderingComputeds.delete(node);
    }
    node.speculativeResult = result;
    node.speculativeDeps = deps;
    node.speculativeCachePromotable =
      (sharedInterop.speculativeDeepReadEpoch ?? 0) === speculativeDeepReadEpoch;
    settleComputedRevision(node, result.hasError, result.value, result.error, result.hasError);
    return result;
  }

  function readComputedForRender<T>(node: ComputedNode<T>): T {
    if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
    const cleanGraph = node.initialized && !(node.flags & (Dirty | Pending)) &&
      !(node.foreignDependent && !node.live);
    let result: { hasError: boolean; value: T | undefined; error: unknown };
    if (speculativeReads !== undefined && node !== activeSpeculativeComputed) {
      result = withoutInteropSpeculativeMode(() => {
        try {
          readComputedCore(node);
          return { hasError: node.hasError, value: node.value, error: node.error };
        } catch (error) {
          return { hasError: true, value: undefined, error };
        }
      });
    } else if (cleanGraph) {
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
    if (node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live)) return true;
    if (!speculativeDependenciesAreCurrent(node)) return false;
    const result = node.speculativeResult as { hasError: boolean; value: T | undefined; error: unknown };
    const deps = node.speculativeDeps as Map<SpeculativeDependency, number>;
    for (const dependency of deps.keys()) {
      if (!("getRevision" in dependency) && "getter" in dependency) {
        promoteSpeculativeCache(dependency as ComputedNode<unknown>);
      }
    }
    node.value = result.value;
    node.error = result.error;
    node.hasError = result.hasError;
    node.initialized = true;
    node.foreignDependent = false;
    node.depsTail = undefined;
    node.flags = Mutable | RecursedCheck;
    const previousSub = activeSub;
    activeSub = node;
    cycle += 1;
    try {
      for (const [dependency, revision] of deps) {
        if ("getRevision" in dependency) {
          const external = externalNodeFor(dependency, revision);
          link(asReactiveNode(external), asReactiveNode(node), cycle);
          node.foreignDependent = true;
          refreshDependencyLiveness(external);
        } else {
          link(asReactiveNode(dependency), asReactiveNode(node), cycle);
          if ("getter" in dependency && (dependency as ComputedNode<unknown>).foreignDependent) node.foreignDependent = true;
          if ("getter" in dependency && (dependency as ComputedNode<unknown>).foreignDependent) {
            refreshDependencyLiveness(dependency as ComputedNode<unknown>);
          }
        }
      }
    } finally {
      activeSub = previousSub;
      node.flags &= ~RecursedCheck;
    }
    purgeDeps(node);
    synchronizeComputedLiveness(node);
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
      withoutInteropSpeculativeMode(() =>
        withoutGraphCollection(() => withoutAllRenderCollection(cleanup)));
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
        const cleanup = withoutInteropSpeculativeMode(() =>
          withTrackedGraph(effect, () => withoutAllRenderCollection(effect.fn)));
        if (effect.active) effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
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
    if (watcher.listener !== undefined) withoutAllRenderCollection(watcher.listener);
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
      node.renderWatcher = createGraphWatcher(node, () => {
          const activeListeners = node.renderListeners;
          if (activeListeners === undefined) return;
          // Snapshot before invoking React so subscriber mutation is safe.
          // oxlint-disable-next-line unicorn/no-useless-spread
          for (const renderListener of [...activeListeners]) {
            notifyListener(renderListener);
          }
        });
    }

    return () => {
      const current = node.renderListeners;
      if (current === undefined || !current.delete(listener)) return;
      if (current.size !== 0) return;
      node.renderListeners = undefined;
      const watcher = node.renderWatcher;
      node.renderWatcher = undefined;
      if (watcher !== undefined) unsubscribeGraphWatcher(watcher);
    };
  }

  function flush(): void {
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
      reportFailure(error);
    } catch {
      // A failing reporter cannot break the graph flush.
    }
  }

  function untracked<T>(fn: () => T): T {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      return withoutGraphCollection(() => withoutAllRenderCollection(fn));
    } finally {
      activeSub = previousSub;
    }
  }

  function runCleanupValue(cleanup: () => void): void {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      withoutInteropSpeculativeMode(() =>
        withoutGraphCollection(() => withoutAllRenderCollection(cleanup)));
    } catch (error) {
      safelyReport(error);
    } finally {
      activeSub = previousSub;
    }
  }

  const runtime: ReactiveRuntime = {
    signal<T>(initialValue: T): RuntimeSignal<T> {
      const node: SignalNode<T> = {
        kind: "source",
        runtimeToken,
        interop: undefined as unknown as ReadableInteropV1,
        currentValue: initialValue,
        pendingValue: initialValue,
        revision: 0,
        renderListeners: undefined,
        renderWatcher: undefined,
        protocolListeners: undefined,
        protocolWatcher: undefined,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: Mutable,
      };
      node.interop = createReadableProtocol(node) as ReadableInteropV1;
      const source: NodeBackedReadable<T> & RuntimeSignal<T> = {
        [READABLE_NODE]: node,
        get value() {
          if (activeSub !== undefined && !isInteropSpeculative()) return readSignalCore(node);
          if (speculativeReads !== undefined) {
            if (!speculativeReads.has(node)) speculativeReads.set(node, getRenderVersion(node));
            return node.flags & Dirty ? node.pendingValue : node.currentValue;
          }
          if (isInteropSpeculative()) {
            publishForeignGraphRead(node.interop, node.revision);
            return node.flags & Dirty ? node.pendingValue : node.currentValue;
          }
          if (activeRenderReads !== undefined) {
            const reads = activeRenderReads;
            if (!reads.has(node)) reads.set(node, getRenderVersion(node));
            const value = node.flags & Dirty ? node.pendingValue : node.currentValue;
            activeRenderCollector?.add(source, reads.get(node)!);
            return value;
          }
          if (activeRenderCollector !== undefined) {
            activeRenderCollector.add(source, getRenderVersion(node));
            return node.flags & Dirty ? node.pendingValue : node.currentValue;
          }
          if (sharedInterop.renderCollector !== undefined) {
            publishForeignRenderRead(node.interop, node.revision);
            return node.flags & Dirty ? node.pendingValue : node.currentValue;
          }
          publishForeignGraphRead(node.interop, node.revision);
          return readSignalCore(node);
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
      attachReadableInterop(source, node.interop);
      ownedReadables.add(source);
      return source;
    },
    computed<T>(getter: () => T): RuntimeReadonlySignal<T> {
      const node: ComputedNode<T> = {
        kind: "computed",
        runtimeToken,
        interop: undefined as unknown as ReadableInteropV1,
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
        speculativeCachePromotable: false,
        foreignDependent: false,
        live: false,
        renderListeners: undefined,
        renderWatcher: undefined,
        protocolListeners: undefined,
        protocolWatcher: undefined,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: 0,
      };
      node.interop = createReadableProtocol(node) as ReadableInteropV1;
      const computed: NodeBackedReadable<T> = {
        [READABLE_NODE]: node,
        get value() {
          if (activeSub !== undefined && !isInteropSpeculative()) return readComputedCore(node);
          const localRender = activeRenderReads !== undefined || speculativeReads !== undefined ||
            activeRenderCollector !== undefined || sharedInterop.renderCollector !== undefined ||
            isInteropSpeculative();
          let value: T;
          try {
            value = localRender ? readComputedForRender(node) : readComputed(node);
            return value;
          } finally {
            if (localRender) {
              if (activeRenderReads !== undefined && !activeRenderReads.has(node)) {
                activeRenderReads.set(node, getRenderVersion(node));
              }
              if (activeRenderReads !== undefined) {
                activeRenderCollector?.add(computed, activeRenderReads.get(node)!);
              } else if (activeRenderCollector !== undefined) {
                activeRenderCollector.add(computed, getRenderVersion(node));
              } else if (sharedInterop.renderCollector !== undefined) {
                publishForeignRenderRead(node.interop, node.revision);
              }
            } else if (sharedInterop.renderCollector !== undefined) {
              publishForeignRenderRead(node.interop, node.revision);
            }
            publishForeignGraphRead(node.interop, node.revision);
          }
        },
        peek() {
          return untracked(() =>
            withoutInteropSpeculativeMode(() => readComputedCore(node)));
        },
        getRenderVersion() { return getRenderVersion(node); },
        subscribeRender(listener) { return subscribeRenderNode(node, listener); },
      };
      attachReadableInterop(computed, node.interop);
      ownedReadables.add(computed);
      return computed;
    },
    effect(fn) {
      const effect: EffectNode = {
        kind: "reaction",
        runtimeToken,
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
          dep = unlinkDependency(dep, effect) ?? undefined;
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
    subscribe<T>(readable: RuntimeReadonlySignal<T>, listener: () => void): () => void {
      if (!ownedReadables.has(readable as object)) {
        throw new TypeError("subscribe() expects a signal or computed from this runtime");
      }
      const node = (readable as NodeBackedReadable<T>)[READABLE_NODE];
      return subscribeRenderNode(node, () => notifyListener(listener));
    },
    hasActiveSubscriber() {
      return activeSub !== undefined;
    },
    getBatchDepth() {
      return batchDepth;
    },
    hasSubscribers(readable) {
      if (!ownedReadables.has(readable as object)) return false;
      const node = (readable as NodeBackedReadable<unknown>)[READABLE_NODE];
      return hasLiveConsumer(node);
    },
  };
  return runtime;

  function runInitial(effect: EffectNode): void {
    effect.depsTail = undefined;
    const previousSub = activeSub;
    activeSub = effect;
    effect.running = true;
    runDepth += 1;
    try {
      try {
        const cleanup = withoutInteropSpeculativeMode(() =>
          withTrackedGraph(effect, () => withoutAllRenderCollection(effect.fn)));
        effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
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

function reportFailure(error: unknown): void {
  try {
    console.error(
      "react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.",
      { cause: error },
    );
  } catch {
    // Reporting must not turn a contained callback error into a flush failure.
  }
  try {
    const report = (globalThis as { reportError?: (cause: unknown) => void }).reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch {
    // The console report above remains the fallback if the host hook throws.
  }
}
