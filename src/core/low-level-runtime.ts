import * as alienSignalsSystem from "alien-signals/system";
import type { ReactiveNode } from "alien-signals/system";
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
  readonly kind: "source" | "computed" | "reaction";
};

interface SourceNode<T> extends GraphNode {
  readonly kind: "source";
  currentValue: T;
  pendingValue: T;
  /** Monotonic write generation; distinct from graph-level value equality. */
  revision: number;
}

interface ComputedNode<T> extends GraphNode {
  readonly kind: "computed";
  readonly getter: () => T;
  /** Cached semantic result used by alien-signals graph dirty checks. */
  result: Result<T> | undefined;
  /** Most recent value/error snapshot exposed to render and direct observers. */
  observedResult: Result<T> | undefined;
  /** Monotonic observation generation for render-to-commit race detection. */
  revision: number;
}

interface ReactionNode extends GraphNode {
  readonly kind: "reaction";
  readonly runCallback: () => unknown;
  readonly afterRun: (() => void) | undefined;
  cleanup: (() => void) | undefined;
  /** Runtime lifecycle state; alien ReactiveFlags remain graph state only. */
  active: boolean;
  running: boolean;
  disposeRequested: boolean;
  disposed: boolean;
  scheduled: boolean;
}

type RuntimeNode = SourceNode<unknown> | ComputedNode<unknown> | ReactionNode;

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

export interface LowLevelReadonlySignal<T> extends RenderDependency {
  readonly value: T;
  peek(): T;
  subscribeRender(listener: () => void): () => void;
}

export interface LowLevelSignal<T> extends LowLevelReadonlySignal<T> {
  value: T;
}

export interface LowLevelRuntime {
  signal<T>(initialValue: T): LowLevelSignal<T>;
  computed<T>(getter: () => T): LowLevelReadonlySignal<T>;
  /** Creates a flat effect; nested effects are not owned unless returned as cleanup. */
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(callback: () => T): T;
  untracked<T>(callback: () => T): T;
  subscribe<T>(source: LowLevelReadonlySignal<T>, listener: () => void): () => void;
}

const READABLE_NODE = Symbol("low-level-readable-node");

type NodeBackedReadable<T> = LowLevelReadonlySignal<T> & {
  readonly [READABLE_NODE]: RuntimeNode;
};

/** Value equality cuts propagation; every error reevaluation is a fresh graph result. */
function graphResultsEqual<T>(left: Result<T> | undefined, right: Result<T>): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  return left.kind === "value" && right.kind === "value"
    ? Object.is(left.value, right.value)
    : false;
}

function observedResultsEqual<T>(left: Result<T> | undefined, right: Result<T>): boolean {
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

function reportFailure(kind: "effect" | "cleanup", error: unknown): void {
  try {
    console.error(
      `react-fine-grained-signals low-level spike: an ${kind} callback threw; the error was contained so the graph can continue.`,
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

/** Creates an isolated experimental graph using only alien-signals/system. */
export function createLowLevelRuntime(): LowLevelRuntime {
  let activeSub: ReactiveNode | undefined;
  let cycle = 0;
  let batchDepth = 0;
  let reactionDepth = 0;
  let propagationDepth = 0;
  let renderReadDepth = 0;
  let flushing = false;
  let queueIndex = 0;
  const queue: Array<ReactionNode | undefined> = [];
  const ownedReadables = new WeakSet<object>();
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
      return false;
    },
    notify(node) {
      const reaction = node as ReactionNode;
      reaction.flags &= ~ReactiveFlags.Watching;
      enqueue(reaction);
    },
    unwatched(node) {
      const runtimeNode = node as RuntimeNode;
      if (runtimeNode.kind === "computed") releaseComputed(runtimeNode);
    },
  });

  function enqueue(reaction: ReactionNode): void {
    if (!reaction.active || reaction.disposed || reaction.disposeRequested || reaction.scheduled) return;
    reaction.scheduled = true;
    queue.push(reaction);
  }

  function flush(): void {
    if (flushing || batchDepth > 0 || reactionDepth > 0 || propagationDepth > 0) return;
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

  /** Remove dependencies not visited during the current tracked execution. */
  function pruneStaleDeps(node: GraphNode): void {
    let link = node.depsTail !== undefined ? node.depsTail.nextDep : node.deps;
    while (link !== undefined) link = system.unlink(link, node);
  }

  /** Permanently detach every dependency, including links from prior executions. */
  function detachAllDeps(node: GraphNode): void {
    let link = node.deps;
    while (link !== undefined) link = system.unlink(link, node);
    delete node.depsTail;
  }

  function linkDependency(node: GraphNode): void {
    const subscriber = activeSub;
    if (subscriber === undefined) return;
    const runtimeSubscriber = subscriber as GraphNode;
    if (runtimeSubscriber.kind === "reaction") {
      const reaction = runtimeSubscriber as ReactionNode;
      if (!reaction.active || reaction.disposed || reaction.disposeRequested) return;
    }
    system.link(node, subscriber, cycle);
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
    const previousSub = activeSub;
    activeSub = node;
    cycle += 1;
    let next: Result<T>;
    try {
      try {
        next = { kind: "value", value: node.getter() };
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
    linkDependency(node);
    return node.pendingValue;
  }

  function ensureComputed<T>(node: ComputedNode<T>): Result<T> {
    try {
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
    try {
      return untrackedRender(() => {
        try {
          return { kind: "value", value: node.getter() };
        } catch (error) {
          return { kind: "error", error };
        }
      });
    } finally {
      renderReadDepth -= 1;
      activeSub = previousSub;
      speculativeStack.delete(speculativeNode);
    }
  }

  function readComputedResult<T>(node: ComputedNode<T>, speculative: boolean): Result<T> {
    if (renderReadDepth > 0 || speculative) {
      const clean =
        node.result !== undefined &&
        !(node.flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending));
      const result = clean ? node.result as Result<T> : evaluateSpeculatively(node);
      observeResult(node, result, !clean);
      return result;
    }
    if (node.flags & ReactiveFlags.RecursedCheck) {
      throw new Error("Computed cycle detected");
    }
    const result = ensureComputed(node);
    observeResult(node, result, false);
    linkDependency(node);
    return result;
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
          system.checkDirty(reaction.deps, reaction));
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
        reportFailure("cleanup", error);
      }
      if (reaction.disposed || reaction.disposeRequested) return;
    }

    delete reaction.depsTail;
    reaction.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    const previousSub = activeSub;
    activeSub = reaction;
    reaction.running = true;
    cycle += 1;
    reactionDepth += 1;
    let returnedCleanup: unknown;
    try {
      returnedCleanup = reaction.runCallback();
    } catch (error) {
      reportFailure("effect", error);
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
          reportFailure("effect", error);
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
      runCallback,
      afterRun,
      cleanup: undefined,
      active: true,
      running: false,
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
        reportFailure("cleanup", error);
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

  function createSource<T>(initialValue: T): LowLevelSignal<T> {
    const node: SourceNode<T> = {
      kind: "source",
      currentValue: initialValue,
      pendingValue: initialValue,
      revision: 0,
      flags: ReactiveFlags.Mutable,
    };
    const source: NodeBackedReadable<T> & LowLevelSignal<T> = {
      [READABLE_NODE]: node,
      get value() {
        if (renderReadDepth > 0) return node.pendingValue;
        if (hasActiveRenderCollector()) {
          const value = node.pendingValue;
          trackRenderDependency(source);
          return value;
        }
        return readSource(node);
      },
      set value(nextValue: T) {
        if (Object.is(node.pendingValue, nextValue)) return;
        node.pendingValue = nextValue;
        node.revision += 1;
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        if (node.subs !== undefined) {
          propagationDepth += 1;
          try {
            system.propagate(node.subs, reactionDepth > 0);
          } finally {
            propagationDepth -= 1;
          }
        }
        flush();
      },
      peek() {
        return untracked(() => node.pendingValue);
      },
      getRenderVersion: () => node.revision,
      subscribeRender: (listener) => subscribeNode(node, listener),
    };
    ownedReadables.add(source);
    return source;
  }

  function createComputed<T>(getter: () => T): LowLevelReadonlySignal<T> {
    let node: ComputedNode<T>;
    node = {
      kind: "computed",
      getter,
      result: undefined,
      observedResult: undefined,
      revision: 0,
      flags: ReactiveFlags.None,
    };
    const computed: NodeBackedReadable<T> = {
      [READABLE_NODE]: node,
      get value() {
        const speculative = renderReadDepth > 0 || hasActiveRenderCollector();
        const result = readComputedResult(node, speculative);
        if (renderReadDepth === 0 && hasActiveRenderCollector()) {
          trackRenderDependency(computed);
        }
        return unwrap(result);
      },
      peek() {
        return untracked(() => readComputed(node));
      },
      getRenderVersion: () => node.revision,
      subscribeRender: (listener) => subscribeNode(node, listener),
    };
    ownedReadables.add(computed);
    return computed;
  }

  function untracked<T>(callback: () => T): T {
    const previousSub = activeSub;
    activeSub = undefined;
    try {
      return untrackedRender(callback);
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
    subscribe<T>(source: LowLevelReadonlySignal<T>, listener: () => void): () => void {
      if (!ownedReadables.has(source as object)) {
        throw new TypeError("subscribe() expects a signal or computed from this runtime");
      }
      const node = (source as NodeBackedReadable<T>)[READABLE_NODE];
      if (node === undefined || node.kind === "reaction") {
        throw new TypeError("subscribe() expects a signal or computed from this runtime");
      }
      return subscribeNode(node, listener);
    },
  };
}
