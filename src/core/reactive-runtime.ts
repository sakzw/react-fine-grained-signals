import * as alienSignalsSystem from "alien-signals/system";
import type { ReactiveNode } from "alien-signals/system";
import {
  attachReadableInterop,
  getSharedInteropContext,
  isInteropSpeculative,
  publishInteropGraphRead,
  publishInteropRenderRead,
  withInteropGraphCollector,
  withInteropSpeculativeMode,
  withoutInteropGraphCollector,
  withoutInteropRenderCollector,
  type InteropGraphCollectorV1,
  type ReadableInteropV1,
} from "./interop.js";
import {
  hasActiveRenderCollector,
  notifyListener,
  trackRenderDependency,
  untrackedRender,
  type RenderDependency,
} from "./render-tracking.js";

type Result<T> = { readonly kind: "value"; readonly value: T } | {
  readonly kind: "error";
  readonly error: unknown;
};

type GraphNode = ReactiveNode & {
  readonly kind: "source" | "computed" | "reaction" | "external";
  readonly runtimeToken: object;
};

interface SourceNode<T> extends GraphNode {
  readonly kind: "source";
  readonly interop: ReadableInteropV1;
  currentValue: T;
  pendingValue: T;
  /** Monotonic write generation; distinct from graph-level value equality. */
  revision: number;
}

interface ComputedNode<T> extends GraphNode {
  readonly kind: "computed";
  readonly interop: ReadableInteropV1;
  readonly getter: () => T;
  /** Cached semantic result used by alien-signals graph dirty checks. */
  result: Result<T> | undefined;
  /** Most recent value/error snapshot exposed to render and direct observers. */
  observedResult: Result<T> | undefined;
  speculativeResult: Result<T> | undefined;
  speculativeDeps: Map<ReadableInteropV1, number> | undefined;
  speculativeCachePromotable: boolean;
  /** Monotonic observation generation for render-to-commit race detection. */
  revision: number;
  live: boolean;
  foreignDependent: boolean;
  lastColdPullGeneration: number;
}

interface ReactionNode extends GraphNode {
  readonly kind: "reaction";
  readonly runCallback: () => unknown;
  readonly afterRun: (() => void) | undefined;
  cleanup: (() => void) | undefined;
  /** Runtime lifecycle state; alien ReactiveFlags remain graph state only. */
  active: boolean;
  running: boolean;
  hasComputedDependency: boolean;
  requiresDirtyCheck: boolean;
  disposeRequested: boolean;
  disposed: boolean;
  scheduled: boolean;
}

interface ExternalNode extends GraphNode {
  readonly kind: "external";
  readonly protocol: ReadableInteropV1;
  subscription: { unsubscribe(): void } | undefined;
  currentEpoch: number;
  pendingEpoch: number;
  lastForeignRevision: number;
}

type RuntimeNode =
  | SourceNode<unknown>
  | ComputedNode<unknown>
  | ReactionNode
  | ExternalNode;

const { createReactiveSystem } = alienSignalsSystem;
// The package's JS entry exports this flags object, but its declarations model
// it as a const enum. Read the runtime object through a narrow cast so the
// candidate follows the installed system's values without importing the
// forbidden high-level entry point.
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

export interface RuntimeReadonlySignal<T> extends RenderDependency {
  readonly value: T;
  peek(): T;
  subscribeRender(listener: () => void): () => void;
}

export interface RuntimeSignal<T> extends RuntimeReadonlySignal<T> {
  value: T;
}

export interface ReactiveRuntime {
  signal<T>(initialValue: T): RuntimeSignal<T>;
  computed<T>(getter: () => T): RuntimeReadonlySignal<T>;
  /** Creates a flat effect; nested effects are not owned unless returned as cleanup. */
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(callback: () => T): T;
  untracked<T>(callback: () => T): T;
  subscribe<T>(source: RuntimeReadonlySignal<T>, listener: () => void): () => void;
  hasActiveSubscriber(): boolean;
  getBatchDepth(): number;
  hasSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
}

const READABLE_NODE = Symbol("reactive-runtime-readable-node");

type NodeBackedReadable<T> = RuntimeReadonlySignal<T> & {
  readonly [READABLE_NODE]: RuntimeNode;
};

/** Value equality cuts propagation; every error reevaluation is a fresh graph result. */
function graphResultsEqual<T>(
  left: Result<T> | undefined,
  right: Result<T>,
): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  return left.kind === "value" && right.kind === "value"
    ? Object.is(left.value, right.value)
    : false;
}

function observedResultsEqual<T>(
  left: Result<T> | undefined,
  right: Result<T>,
): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  return left.kind === "value" && right.kind === "value"
    ? Object.is(left.value, right.value)
    : left.kind === "error" && right.kind === "error"
      ? Object.is(left.error, right.error)
      : false;
}

function unwrap<T>(result: Result<T>): T {
  if (result.kind === "error") throw result.error;
  return result.value;
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

function deactivateExternal(node: ExternalNode): void {
  const subscription = node.subscription;
  node.subscription = undefined;
  subscription?.unsubscribe();
}

/** Creates an isolated reactive graph using only alien-signals/system. */
export function createReactiveRuntime(): ReactiveRuntime {
  const runtimeToken = {};
  let activeSub: ReactiveNode | undefined;
  let cycle = 0;
  let batchDepth = 0;
  let reactionDepth = 0;
  let propagationDepth = 0;
  let renderReadDepth = 0;
  let coldPullDepth = 0;
  let coldPullGeneration = 0;
  let activeColdPullGeneration = 0;
  let flushing = false;
  let queueIndex = 0;
  const queue: Array<ReactionNode | undefined> = [];
  const ownedReadables = new WeakSet<object>();
  const externalNodes = new WeakMap<ReadableInteropV1, ExternalNode>();
  const localNodesByProtocol = new WeakMap<ReadableInteropV1, SourceNode<unknown> | ComputedNode<unknown>>();
  const graphCollectors = new WeakMap<GraphNode, InteropGraphCollectorV1>();
  const speculativeStack = new Set<ComputedNode<unknown>>();

  const system = createReactiveSystem({
    update(node) {
      const runtimeNode = node as RuntimeNode;
      if (runtimeNode.kind === "source") {
        const source = runtimeNode as SourceNode<unknown>;
        const changed = !Object.is(source.currentValue, source.pendingValue);
        source.currentValue = source.pendingValue;
        runtimeNode.flags = ReactiveFlags.Mutable;
        return changed;
      }
      if (runtimeNode.kind === "computed") return updateComputed(runtimeNode);
      if (runtimeNode.kind === "external") {
        const external = runtimeNode as ExternalNode;
        const changed = external.currentEpoch !== external.pendingEpoch;
        external.currentEpoch = external.pendingEpoch;
        runtimeNode.flags = ReactiveFlags.Mutable;
        return changed;
      }
      return false;
    },
    notify(node) {
      const reaction = node as ReactionNode;
      reaction.flags &= ~ReactiveFlags.Watching;
      if (batchDepth > 0) reaction.requiresDirtyCheck = true;
      enqueue(reaction);
    },
    unwatched(node) {
      const runtimeNode = node as RuntimeNode;
      if (runtimeNode.kind === "computed") releaseComputed(runtimeNode);
      else if (runtimeNode.kind === "external") deactivateExternal(runtimeNode);
    },
  });

  function enqueue(reaction: ReactionNode): void {
    if (!reaction.active || reaction.disposed || reaction.disposeRequested || reaction.scheduled) return;
    reaction.scheduled = true;
    queue.push(reaction);
  }

  function flush(): void {
    if (flushing || batchDepth > 0 || reactionDepth > 0 || propagationDepth > 0) return;
    if (queueIndex >= queue.length) return;
    flushing = true;
    try {
      while (queueIndex < queue.length) {
        const reaction = queue[queueIndex];
        queue[queueIndex++] = undefined;
        if (reaction !== undefined) runReaction(reaction, false);
      }
    } finally {
      queue.length = 0;
      queueIndex = 0;
      flushing = false;
    }
  }

  function hasLiveConsumer(node: GraphNode): boolean {
    let link = node.subs;
    while (link !== undefined) {
      const subscriber = link.sub as GraphNode;
      if (
        subscriber.kind === "reaction" &&
        (subscriber as ReactionNode).active &&
        !(subscriber as ReactionNode).disposed &&
        !(subscriber as ReactionNode).disposeRequested
      ) return true;
      if (subscriber.kind === "computed" && (subscriber as ComputedNode<unknown>).live) {
        return true;
      }
      link = link.nextSub;
    }
    return false;
  }

  function refreshDependencyLiveness(node: GraphNode): void {
    if (node.kind === "computed") {
      setComputedLive(node as ComputedNode<unknown>, hasLiveConsumer(node));
    } else if (node.kind === "external") {
      setExternalLive(node as ExternalNode, hasLiveConsumer(node));
    }
  }

  function setComputedLive(node: ComputedNode<unknown>, live: boolean): void {
    if (node.live === live) return;
    node.live = live;
    let link = node.deps;
    while (link !== undefined) {
      refreshDependencyLiveness(link.dep as GraphNode);
      link = link.nextDep;
    }
  }

  function propagateExternalChange(node: ExternalNode): void {
    const subscribers = node.subs;
    if (subscribers === undefined) return;
    propagationDepth += 1;
    try {
      system.propagate(subscribers, reactionDepth > 0);
    } finally {
      propagationDepth -= 1;
    }
    flush();
  }

  function invalidateExternalPath(node: ExternalNode): void {
    const pending: GraphNode[] = [];
    const visited = new Set<GraphNode>();
    let link = node.subs;
    while (link !== undefined) {
      pending.push(link.sub as GraphNode);
      link = link.nextSub;
    }
    while (pending.length > 0) {
      const subscriber = pending.pop()!;
      if (visited.has(subscriber)) continue;
      visited.add(subscriber);
      if (subscriber.kind === "computed") {
        subscriber.flags |= ReactiveFlags.Dirty;
        let child = subscriber.subs;
        while (child !== undefined) {
          pending.push(child.sub as GraphNode);
          child = child.nextSub;
        }
      } else if (subscriber.kind === "reaction") {
        const reaction = subscriber as ReactionNode;
        if (reaction.active && !reaction.disposed && !reaction.disposeRequested) {
          reaction.flags |= ReactiveFlags.Dirty;
          enqueue(reaction);
        }
      }
    }
    flush();
  }

  function receiveExternalRevision(node: ExternalNode, revision: number): void {
    node.lastForeignRevision = revision;
    node.pendingEpoch += 1;
    node.flags |= ReactiveFlags.Dirty;
    propagateExternalChange(node);
  }

  function activateExternal(node: ExternalNode, observedRevision: number): void {
    node.lastForeignRevision = observedRevision;
    if (node.subscription !== undefined) return;

    const subscription = node.protocol.subscribe((revision) => {
      receiveExternalRevision(node, revision);
    });
    node.subscription = subscription;
    if (subscription.revision !== observedRevision) {
      node.lastForeignRevision = subscription.revision;
      node.pendingEpoch += 1;
      node.flags |= ReactiveFlags.Dirty;
      invalidateExternalPath(node);
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
        protocol,
        subscription: undefined,
        currentEpoch: 0,
        pendingEpoch: 0,
        lastForeignRevision: observedRevision,
        flags: ReactiveFlags.Mutable,
      };
      externalNodes.set(protocol, node);
    } else {
      node.lastForeignRevision = observedRevision;
    }
    return node;
  }

  function graphCollectorFor(subscriber: GraphNode): InteropGraphCollectorV1 {
    let collector = graphCollectors.get(subscriber);
    if (collector !== undefined) return collector;
    collector = {
      runtimeToken,
      add(protocol, observedRevision) {
        if (
          protocol.runtimeToken === runtimeToken ||
          subscriber.runtimeToken !== runtimeToken
        ) return;
        if (subscriber.kind === "reaction") {
          const reaction = subscriber as ReactionNode;
          if (!reaction.active || reaction.disposed || reaction.disposeRequested) return;
        }
        const external = externalNodeFor(protocol, observedRevision);
        if (subscriber.kind === "reaction") {
          (subscriber as ReactionNode).requiresDirtyCheck = true;
        }
        system.link(external, subscriber, cycle);
        if (subscriber.kind === "computed") {
          (subscriber as ComputedNode<unknown>).foreignDependent = true;
        }
        refreshDependencyLiveness(external);
      },
    };
    graphCollectors.set(subscriber, collector);
    return collector;
  }

  function withTrackedGraph<T>(subscriber: GraphNode, callback: () => T): T {
    return withInteropGraphCollector(graphCollectorFor(subscriber), callback);
  }

  function linkLocalDependency(node: GraphNode): void {
    const subscriber = activeSub as GraphNode | undefined;
    if (subscriber === undefined || node.runtimeToken !== runtimeToken) return;
    if (subscriber.kind === "reaction") {
      const reaction = subscriber as ReactionNode;
      if (!reaction.active || reaction.disposed || reaction.disposeRequested) return;
    }
    system.link(node, subscriber, cycle);
    if (subscriber.kind === "computed") {
      const computed = subscriber as ComputedNode<unknown>;
      if (
        node.kind === "external" ||
        (node.kind === "computed" && (node as ComputedNode<unknown>).foreignDependent)
      ) computed.foreignDependent = true;
    } else if (node.kind === "computed") {
      (subscriber as ReactionNode).hasComputedDependency = true;
    }
    refreshDependencyLiveness(node);
  }

  function recordReadableRead(node: SourceNode<unknown> | ComputedNode<unknown>): void {
    if (node.runtimeToken === runtimeToken) {
      linkLocalDependency(node);
      if (activeSub !== undefined) return;
    }
    publishInteropGraphRead(node.interop, node.revision);
  }

  function nextColdPull<T>(callback: () => T): T {
    const startsPull = coldPullDepth === 0;
    if (startsPull) activeColdPullGeneration = ++coldPullGeneration;
    coldPullDepth += 1;
    try {
      return callback();
    } finally {
      coldPullDepth -= 1;
      if (startsPull) activeColdPullGeneration = 0;
    }
  }

  /** Remove dependencies not visited during the current tracked execution. */
  function pruneStaleDeps(node: GraphNode): void {
    let link = node.depsTail !== undefined ? node.depsTail.nextDep : node.deps;
    while (link !== undefined) link = unlinkAndRefresh(link, node);
  }

  /** Permanently detach every dependency, including links from prior executions. */
  function detachAllDeps(node: GraphNode): void {
    let link = node.deps;
    while (link !== undefined) link = unlinkAndRefresh(link, node);
    delete node.depsTail;
  }

  function unlinkAndRefresh(link: NonNullable<GraphNode["deps"]>, node: GraphNode) {
    const dependency = link.dep as GraphNode;
    const next = system.unlink(link, node);
    refreshDependencyLiveness(dependency);
    return next;
  }

  function observeResult<T>(
    node: ComputedNode<T>,
    next: Result<T>,
    reevaluated: boolean,
  ): void {
    const errorReevaluated = reevaluated && next.kind === "error";
    if (errorReevaluated || !observedResultsEqual(node.observedResult, next)) {
      node.revision += 1;
    }
    node.observedResult = next;
  }

  function updateComputed<T>(node: ComputedNode<T>): boolean {
    const previous = node.result;
    delete node.depsTail;
    node.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    node.foreignDependent = false;
    const previousSub = activeSub;
    activeSub = node;
    cycle += 1;
    let next: Result<T>;
    try {
      try {
        next = {
          kind: "value",
          value: withTrackedGraph(node, () => untrackedRender(node.getter)),
        };
      } catch (error) {
        next = { kind: "error", error };
      }
      node.result = next;
      observeResult(node, next, true);
      return !graphResultsEqual(previous, next);
    } finally {
      activeSub = previousSub;
      node.flags &= ~ReactiveFlags.RecursedCheck;
      pruneStaleDeps(node);
    }
  }

  function releaseComputed<T>(node: ComputedNode<T>): void {
    setComputedLive(node as ComputedNode<unknown>, false);
    if (node.deps === undefined) return;
    detachAllDeps(node);
    node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
  }

  function readSource<T>(node: SourceNode<T>): T {
    if (node.flags & ReactiveFlags.Dirty) {
      const changed = !Object.is(node.currentValue, node.pendingValue);
      node.currentValue = node.pendingValue;
      node.flags = ReactiveFlags.Mutable;
      if (changed && node.subs !== undefined) {
        propagationDepth += 1;
        try {
          system.shallowPropagate(node.subs);
        } finally {
          propagationDepth -= 1;
        }
      }
    }
    recordReadableRead(node as SourceNode<unknown>);
    return node.pendingValue;
  }

  function ensureComputed<T>(node: ComputedNode<T>): Result<T> {
    try {
      if (
        !node.live &&
        node.foreignDependent &&
        node.lastColdPullGeneration !== activeColdPullGeneration
      ) {
        node.lastColdPullGeneration = activeColdPullGeneration;
        if (updateComputed(node)) {
          const subscribers = node.subs;
          if (subscribers !== undefined) system.shallowPropagate(subscribers);
        }
        return node.result as Result<T>;
      }
      const flags = node.flags;
      if (
        flags & ReactiveFlags.Dirty ||
        (flags & ReactiveFlags.Pending &&
          node.deps !== undefined &&
          system.checkDirty(node.deps, node))
      ) {
        if (updateComputed(node)) {
          const subscribers = node.subs;
          if (subscribers !== undefined) system.shallowPropagate(subscribers);
        }
      } else if (flags & ReactiveFlags.Pending) {
        node.flags = flags & ~ReactiveFlags.Pending;
      }
      if (node.result === undefined) {
        updateComputed(node);
      }
      return node.result as Result<T>;
    } finally {
      flush();
    }
  }

  function evaluateSpeculatively<T>(node: ComputedNode<T>): Result<T> {
    const speculativeNode = node as ComputedNode<unknown>;
    if (speculativeStack.has(speculativeNode)) {
      throw new Error("Computed cycle detected");
    }
    speculativeStack.add(speculativeNode);
    const previousSub = activeSub;
    activeSub = undefined;
    renderReadDepth += 1;
    const speculativeDeepReadEpoch = getSharedInteropContext().speculativeDeepReadEpoch ?? 0;
    const dependencies = new Map<ReadableInteropV1, number>();
    const collector: InteropGraphCollectorV1 = {
      runtimeToken: {},
      add(protocol, observedRevision) {
        dependencies.set(protocol, observedRevision);
      },
    };
    try {
      const result = withInteropGraphCollector(
        collector,
        () => withoutInteropRenderCollector(() =>
          withInteropSpeculativeMode(() => untrackedRender(() => {
            try {
              return { kind: "value", value: node.getter() } as Result<T>;
            } catch (error) {
              return { kind: "error", error } as Result<T>;
            }
          })),
        ),
      );
      node.speculativeResult = result;
      node.speculativeDeps = dependencies;
      node.speculativeCachePromotable =
        (getSharedInteropContext().speculativeDeepReadEpoch ?? 0) === speculativeDeepReadEpoch;
      return result;
    } finally {
      renderReadDepth -= 1;
      activeSub = previousSub;
      speculativeStack.delete(speculativeNode);
    }
  }

  function readComputedResult<T>(node: ComputedNode<T>, speculative: boolean): Result<T> {
    const shared = getSharedInteropContext();
    const inRender = hasActiveRenderCollector() || shared.renderCollector !== undefined;
    if (renderReadDepth > 0 || speculative || isInteropSpeculative() || inRender) {
      const graphCacheIsCurrent =
        node.result !== undefined &&
        !(node.flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
        !(!node.live && node.foreignDependent);
      const speculativeCacheIsCurrent = node.speculativeResult !== undefined &&
        speculativeDependenciesAreCurrent(node);
      const result = graphCacheIsCurrent
        ? node.result as Result<T>
        : speculativeCacheIsCurrent
          ? node.speculativeResult as Result<T>
          : evaluateSpeculatively(node);
      const clean = graphCacheIsCurrent || speculativeCacheIsCurrent;
      observeResult(node, result, !clean);
      return result;
    }
    return nextColdPull(() => readComputedNormally(node));
  }

  function readComputedNormally<T>(node: ComputedNode<T>): Result<T> {
    promoteSpeculativeCache(node);
    if (node.flags & ReactiveFlags.RecursedCheck) {
      throw new Error("Computed cycle detected");
    }
    const result = ensureComputed(node);
    observeResult(node, result, false);
    recordReadableRead(node as ComputedNode<unknown>);
    return result;
  }

  function speculativeDependenciesAreCurrent<T>(node: ComputedNode<T>): boolean {
    if (!node.speculativeCachePromotable) return false;
    const dependencies = node.speculativeDeps;
    if (dependencies === undefined) return false;
    for (const [protocol, revision] of dependencies) {
      const local = localNodesByProtocol.get(protocol);
      if (local === undefined) return false;
      if (local.kind === "computed") ensureComputed(local);
      if (protocol.getRevision() !== revision) return false;
    }
    return true;
  }

  function promoteSpeculativeCache<T>(node: ComputedNode<T>): void {
    if (node.result !== undefined || node.speculativeResult === undefined) return;
    const dependencies = node.speculativeDeps;
    if (!speculativeDependenciesAreCurrent(node) || dependencies === undefined || dependencies.size === 0) {
      return;
    }
    node.result = node.speculativeResult;
    node.flags = ReactiveFlags.Mutable;
    node.foreignDependent = false;
    cycle += 1;
    for (const [protocol] of dependencies) {
      const local = localNodesByProtocol.get(protocol) as SourceNode<unknown> | ComputedNode<unknown>;
      system.link(local, node, cycle);
      if (local.kind === "computed" && local.foreignDependent) node.foreignDependent = true;
      refreshDependencyLiveness(local);
    }
  }

  function readComputed<T>(node: ComputedNode<T>): T {
    return unwrap(readComputedResult(node, false));
  }

  function readNodeResult<T>(node: SourceNode<T> | ComputedNode<T>): Result<T> {
    if (node.kind === "source") {
      return { kind: "value", value: readSource(node) };
    }
    return readComputedResult(node, false);
  }

  function runReaction(reaction: ReactionNode, initial: boolean): void {
    if (!reaction.active || reaction.disposed || reaction.disposeRequested || reaction.running) return;
    reaction.scheduled = false;
    if (!initial) {
      const flags = reaction.flags;
      const isDirty =
        !!(flags & ReactiveFlags.Dirty) ||
        (!!(flags & ReactiveFlags.Pending) &&
          reaction.deps !== undefined &&
          (reaction.hasComputedDependency || reaction.requiresDirtyCheck
            ? system.checkDirty(reaction.deps, reaction)
            : true));
      if (!isDirty) {
        reaction.flags = ReactiveFlags.Watching;
        return;
      }
    }

    if (reaction.cleanup !== undefined) {
      const cleanup = reaction.cleanup;
      reaction.cleanup = undefined;
      try {
        untracked(cleanup);
      } catch (error) {
        reportFailure(error);
      }
      if (reaction.disposed || reaction.disposeRequested) return;
    }

    delete reaction.depsTail;
    reaction.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    const previousSub = activeSub;
    activeSub = reaction;
    reaction.running = true;
    reaction.hasComputedDependency = false;
    reaction.requiresDirtyCheck = false;
    cycle += 1;
    reactionDepth += 1;
    let returnedCleanup: unknown;
    try {
        returnedCleanup = withTrackedGraph(
          reaction,
          () => untrackedRender(reaction.runCallback),
        );
    } catch (error) {
      reportFailure(error);
    } finally {
      reactionDepth -= 1;
      activeSub = previousSub;
      reaction.running = false;
      if (typeof returnedCleanup === "function") {
        reaction.cleanup = returnedCleanup as () => void;
      }
      if (reaction.disposeRequested) {
        finalizeReaction(reaction);
      } else if (!reaction.disposed) {
        reaction.flags &= ~ReactiveFlags.RecursedCheck;
        pruneStaleDeps(reaction);
        if (!reaction.scheduled) reaction.flags |= ReactiveFlags.Watching;
      }
      if (!initial && !reaction.disposed) {
        try {
          reaction.afterRun?.();
        } catch (error) {
          reportFailure(error);
        }
      }
      flush();
    }
  }

  function createReaction(
    runCallback: () => unknown,
    afterRun?: () => void,
  ): ReactionNode {
    return {
      kind: "reaction",
      runtimeToken,
      runCallback,
      afterRun,
      cleanup: undefined,
      active: true,
      running: false,
      hasComputedDependency: false,
      requiresDirtyCheck: false,
      disposeRequested: false,
      disposed: false,
      scheduled: false,
      flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
    };
  }

  function finalizeReaction(reaction: ReactionNode): void {
    if (reaction.disposed) return;
    reaction.active = false;
    reaction.disposed = true;
    reaction.disposeRequested = false;
    reaction.scheduled = false;
    reaction.flags = ReactiveFlags.None;
    detachAllDeps(reaction);
    if (reaction.cleanup !== undefined) {
      const cleanup = reaction.cleanup;
      reaction.cleanup = undefined;
      try {
        untracked(cleanup);
      } catch (error) {
        reportFailure(error);
      }
    }
  }

  function disposeReaction(reaction: ReactionNode): void {
    if (reaction.disposed || reaction.disposeRequested) return;
    if (reaction.running) {
      reaction.active = false;
      reaction.disposeRequested = true;
      reaction.scheduled = false;
      reaction.flags = ReactiveFlags.None;
      detachAllDeps(reaction);
      return;
    }
    finalizeReaction(reaction);
  }

  function subscribeNode<T>(node: SourceNode<T> | ComputedNode<T>, listener: () => void): () => void {
    const reaction = createReaction(
      () => readNodeResult(node),
      () => notifyListener(listener),
    );
    runReaction(reaction, true);
    return () => disposeReaction(reaction);
  }

  function createReadableProtocol<T>(
    node: SourceNode<T> | ComputedNode<T>,
  ): ReadableInteropV1 {
    return Object.freeze({
      version: 1 as const,
      runtimeToken,
      getRevision: () => node.revision,
      subscribe(listener: (revision: number) => void) {
        const unsubscribe = subscribeNode(node, () => listener(node.revision));
        return { unsubscribe, revision: node.revision };
      },
    });
  }

  function createSource<T>(initialValue: T): RuntimeSignal<T> {
    const node: SourceNode<T> = {
      kind: "source",
      runtimeToken,
      interop: undefined as unknown as ReadableInteropV1,
      currentValue: initialValue,
      pendingValue: initialValue,
      revision: 0,
      flags: ReactiveFlags.Mutable,
    };
    (node as { interop: ReadableInteropV1 }).interop = createReadableProtocol(node);
    localNodesByProtocol.set(node.interop, node as SourceNode<unknown>);
    const source: NodeBackedReadable<T> & RuntimeSignal<T> = {
      [READABLE_NODE]: node,
      get value() {
        if (renderReadDepth > 0 || isInteropSpeculative()) {
          publishInteropGraphRead(node.interop, node.revision);
          return node.pendingValue;
        }
        if (hasActiveRenderCollector()) {
          const value = node.pendingValue;
          trackRenderDependency(source, node.revision);
          return value;
        }
        if (getSharedInteropContext().renderCollector !== undefined) {
          const value = node.pendingValue;
          publishInteropRenderRead(node.interop, node.revision);
          return value;
        }
        return readSource(node);
      },
      set value(nextValue: T) {
        if (Object.is(node.pendingValue, nextValue)) return;
        node.pendingValue = nextValue;
        node.revision += 1;
        if (node.subs === undefined) {
          node.currentValue = nextValue;
          node.flags = ReactiveFlags.Mutable;
          return;
        }
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        propagationDepth += 1;
        try {
          system.propagate(node.subs, reactionDepth > 0);
        } finally {
          propagationDepth -= 1;
        }
        flush();
      },
      peek() {
        return untracked(() => node.pendingValue);
      },
      getRenderVersion: () => node.revision,
      subscribeRender: (listener) => subscribeNode(node, listener),
    };
    attachReadableInterop(source, node.interop);
    ownedReadables.add(source);
    return source;
  }

  function createComputed<T>(getter: () => T): RuntimeReadonlySignal<T> {
    let node: ComputedNode<T>;
    node = {
      kind: "computed",
      runtimeToken,
      interop: undefined as unknown as ReadableInteropV1,
      getter,
      result: undefined,
      observedResult: undefined,
      speculativeResult: undefined,
      speculativeDeps: undefined,
      speculativeCachePromotable: false,
      revision: 0,
      live: false,
      foreignDependent: false,
      lastColdPullGeneration: 0,
      flags: ReactiveFlags.None,
    };
    (node as { interop: ReadableInteropV1 }).interop = createReadableProtocol(node);
    localNodesByProtocol.set(node.interop, node as ComputedNode<unknown>);
    const computed: NodeBackedReadable<T> = {
      [READABLE_NODE]: node,
      get value() {
        const sharedRenderActive = getSharedInteropContext().renderCollector !== undefined;
        const speculative = renderReadDepth > 0 ||
          hasActiveRenderCollector() ||
          sharedRenderActive ||
          isInteropSpeculative();
        const result = readComputedResult(node, speculative);
        if (renderReadDepth > 0 || isInteropSpeculative()) {
          publishInteropGraphRead(node.interop, node.revision);
        }
        if (renderReadDepth === 0 && !isInteropSpeculative()) {
          if (hasActiveRenderCollector()) {
            trackRenderDependency(computed, node.revision);
          } else if (sharedRenderActive) {
            publishInteropRenderRead(node.interop, node.revision);
          }
        }
        return unwrap(result);
      },
      peek() {
        return untracked(() => readComputed(node));
      },
      getRenderVersion: () => node.revision,
      subscribeRender: (listener) => subscribeNode(node, listener),
    };
    attachReadableInterop(computed, node.interop);
    ownedReadables.add(computed);
    return computed;
  }

  function untracked<T>(callback: () => T): T {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      return withoutInteropGraphCollector(() =>
        withoutInteropRenderCollector(() => untrackedRender(callback)),
      );
    } finally {
      activeSub = previousSub;
    }
  }

  return {
    signal: createSource,
    computed: createComputed,
    effect(fn) {
      const reaction = createReaction(fn);
      runReaction(reaction, true);
      return () => disposeReaction(reaction);
    },
    batch<T>(callback: () => T): T {
      batchDepth += 1;
      try {
        return callback();
      } finally {
        batchDepth -= 1;
        flush();
      }
    },
    untracked,
    subscribe<T>(source: RuntimeReadonlySignal<T>, listener: () => void): () => void {
      if (!ownedReadables.has(source as object)) {
        throw new TypeError("subscribe() expects a signal or computed from this runtime");
      }
      const node = (source as NodeBackedReadable<T>)[READABLE_NODE];
      if (node === undefined || node.kind === "reaction" || node.kind === "external") {
        throw new TypeError("subscribe() expects a signal or computed from this runtime");
      }
      return subscribeNode(node, listener);
    },
    hasActiveSubscriber(): boolean {
      return activeSub !== undefined;
    },
    getBatchDepth(): number {
      return batchDepth;
    },
    hasSubscribers(readable): boolean {
      if (!ownedReadables.has(readable as object)) return false;
      const node = (readable as NodeBackedReadable<unknown>)[READABLE_NODE];
      return node !== undefined && node.kind !== "reaction" && node.subs !== undefined;
    },
  };
}
