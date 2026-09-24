import * as alienSignalsSystem from "alien-signals/system";
import type { ReactiveNode } from "alien-signals/system";
import {
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
  readonly render: RenderSurface;
}

interface ComputedNode<T> extends GraphNode {
  readonly kind: "computed";
  readonly getter: () => T;
  result: Result<T> | undefined;
  render: RenderSurface;
  lastRenderResult: Result<T> | undefined;
  renderReaction: (() => void) | undefined;
}

interface ReactionNode extends GraphNode {
  readonly kind: "reaction";
  readonly runCallback: () => unknown;
  readonly afterRun: (() => void) | undefined;
  cleanup: (() => void) | undefined;
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
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(callback: () => T): T;
  untracked<T>(callback: () => T): T;
  subscribe<T>(source: LowLevelReadonlySignal<T>, listener: () => void): () => void;
}

const READABLE_NODE = Symbol("low-level-readable-node");

type NodeBackedReadable<T> = LowLevelReadonlySignal<T> & {
  readonly [READABLE_NODE]: RuntimeNode;
};

/** Versioned render surface whose derived watcher is graph-native. */
class RenderSurface implements RenderDependency {
  readonly #listeners = new Set<() => void>();
  readonly #onFirst: (() => void) | undefined;
  readonly #onLast: (() => void) | undefined;
  #version = 0;

  constructor(onFirst?: () => void, onLast?: () => void) {
    this.#onFirst = onFirst;
    this.#onLast = onLast;
  }

  getRenderVersion(): number {
    return this.#version;
  }

  track(): boolean {
    return trackRenderDependency(this);
  }

  subscribeRender(listener: () => void): () => void {
    const wasEmpty = this.#listeners.size === 0;
    this.#listeners.add(listener);
    if (wasEmpty) this.#onFirst?.();
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0) this.#onLast?.();
    };
  }

  notify(): void {
    this.#version = (this.#version + 1) | 0;
    // Snapshot before iteration because listeners may subscribe/unsubscribe synchronously.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.#listeners]) notifyListener(listener);
  }
}

function resultsEqual<T>(left: Result<T> | undefined, right: Result<T>): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  return left.kind === "value" && right.kind === "value"
    ? Object.is(left.value, right.value)
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
    if (reaction.disposed || reaction.scheduled) return;
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

  function purgeDeps(node: GraphNode): void {
    let link = node.depsTail !== undefined ? node.depsTail.nextDep : node.deps;
    while (link !== undefined) link = system.unlink(link, node);
  }

  function unlinkAllDeps(node: GraphNode): void {
    let link = node.depsTail;
    while (link !== undefined) {
      const previous = link.prevDep;
      system.unlink(link, node);
      link = previous;
    }
    delete node.depsTail;
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
      return !resultsEqual(previous, next);
    } finally {
      activeSub = previousSub;
      node.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(node);
    }
  }

  function releaseComputed<T>(node: ComputedNode<T>): void {
    if (node.deps === undefined) return;
    unlinkAllDeps(node);
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
    if (activeSub !== undefined) system.link(node, activeSub, cycle);
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

  function evaluateForRender<T>(node: ComputedNode<T>): Result<T> {
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
    }
  }

  function readComputedResult<T>(node: ComputedNode<T>, trackRender: boolean): Result<T> {
    const collectedByRender = trackRender && node.render.track();
    if (renderReadDepth > 0 || collectedByRender) {
      const result = evaluateForRender(node);
      if (collectedByRender) node.lastRenderResult = result;
      return result;
    }
    const result = ensureComputed(node);
    if (activeSub !== undefined) system.link(node, activeSub, cycle);
    return result;
  }

  function readComputed<T>(node: ComputedNode<T>, trackRender: boolean): T {
    return unwrap(readComputedResult(node, trackRender));
  }

  function readNodeResult<T>(node: SourceNode<T> | ComputedNode<T>): Result<T> {
    if (node.kind === "source") {
      return { kind: "value", value: readSource(node) };
    }
    return readComputedResult(node, false);
  }

  function runReaction(reaction: ReactionNode, initial: boolean): void {
    if (reaction.disposed) return;
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
        const previousSub = activeSub;
        activeSub = undefined;
        try {
          cleanup();
        } finally {
          activeSub = previousSub;
        }
      } catch (error) {
        reportFailure("cleanup", error);
      }
    }

    delete reaction.depsTail;
    reaction.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    const previousSub = activeSub;
    activeSub = reaction;
    cycle += 1;
    reactionDepth += 1;
    try {
      const cleanup = reaction.runCallback();
      if (typeof cleanup === "function") reaction.cleanup = cleanup as () => void;
    } catch (error) {
      reportFailure("effect", error);
    } finally {
      reactionDepth -= 1;
      activeSub = previousSub;
      reaction.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(reaction);
      if (!reaction.scheduled && !reaction.disposed) {
        reaction.flags |= ReactiveFlags.Watching;
      }
      if (!initial) {
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
      disposed: false,
      scheduled: false,
      flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
    };
  }

  function disposeReaction(reaction: ReactionNode): void {
    if (reaction.disposed) return;
    reaction.disposed = true;
    reaction.scheduled = false;
    reaction.flags = ReactiveFlags.None;
    unlinkAllDeps(reaction);
    if (reaction.cleanup !== undefined) {
      const cleanup = reaction.cleanup;
      reaction.cleanup = undefined;
      try {
        const previousSub = activeSub;
        activeSub = undefined;
        try {
          cleanup();
        } finally {
          activeSub = previousSub;
        }
      } catch (error) {
        reportFailure("cleanup", error);
      }
    }
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
      render: new RenderSurface(),
      flags: ReactiveFlags.Mutable,
    };
    const source: NodeBackedReadable<T> & LowLevelSignal<T> = {
      [READABLE_NODE]: node,
      get value() {
        if (node.render.track() || renderReadDepth > 0) return node.pendingValue;
        return readSource(node);
      },
      set value(nextValue: T) {
        if (Object.is(node.pendingValue, nextValue)) return;
        node.pendingValue = nextValue;
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        if (node.subs !== undefined) {
          propagationDepth += 1;
          try {
            system.propagate(node.subs, reactionDepth > 0);
          } finally {
            propagationDepth -= 1;
          }
        }
        node.render.notify();
        flush();
      },
      peek() {
        return untracked(() => node.pendingValue);
      },
      getRenderVersion: () => node.render.getRenderVersion(),
      subscribeRender: (listener) => node.render.subscribeRender(listener),
    };
    ownedReadables.add(source);
    return source;
  }

  function createComputed<T>(getter: () => T): LowLevelReadonlySignal<T> {
    let node: ComputedNode<T>;
    const render = new RenderSurface(
      () => {
        const reaction = createReaction(
          () => readComputedResult(node, false),
          () => node.render.notify(),
        );
        node.renderReaction = () => disposeReaction(reaction);
        runReaction(reaction, true);
        if (!resultsEqual(node.lastRenderResult, node.result as Result<T>)) {
          node.render.notify();
        }
      },
      () => {
        node.renderReaction?.();
        node.renderReaction = undefined;
      },
    );
    node = {
      kind: "computed",
      getter,
      result: undefined,
      render,
      lastRenderResult: undefined,
      renderReaction: undefined,
      flags: ReactiveFlags.None,
    };
    const computed: NodeBackedReadable<T> = {
      [READABLE_NODE]: node,
      get value() {
        return readComputed(node, true);
      },
      peek() {
        return untracked(() => readComputed(node, false));
      },
      getRenderVersion: () => node.render.getRenderVersion(),
      subscribeRender: (listener) => node.render.subscribeRender(listener),
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
