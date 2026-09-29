import { createAlienDerivedRuntime } from "./alien-derived-runtime-core.mjs";
import { createAlienDerivedRenderAdapter } from "./render-runtime.mjs";
import type { AlienDerivedRenderAdapter, RuntimeNode } from "./alien-derived-types.js";

export interface RuntimeReadonlySignal<T> {
  readonly value: T;
  peek(): T;
}

export interface RuntimeSignal<T> extends RuntimeReadonlySignal<T> {
  value: T;
}

export interface ReactiveRuntime {
  readonly runtimeToken: object;
  readonly graphOwner: {
    readonly kind: "graph";
    readonly runtimeToken: object;
    add(protocol: object, revision: number): void;
  };
  getNodeForReadable(readable: RuntimeReadonlySignal<unknown>): RuntimeNode | undefined;
  readonly renderAdapter: AlienDerivedRenderAdapter;
  signal<T>(value: T): RuntimeSignal<T>;
  computed<T>(getter: () => T): RuntimeReadonlySignal<T>;
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
  hasSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
  hasActiveSubscriber(): boolean;
  getBatchDepth(): number;
  createDeepSignal<T>(initialValue: T): RuntimeSignal<T>;
  createDeepSignalVersion<T>(initialValue: T): RuntimeSignal<T>;
  markDeepSignalWatched(readable: RuntimeReadonlySignal<unknown>): void;
  hasDeepSignalSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
  isSpeculative(): boolean;
  markSpeculativeDeepRead(): void;
}

/** Builds one Alien-derived graph and its separate owner/render adapters. */
export function createReactiveRuntime(): ReactiveRuntime {
  const graph = createAlienDerivedRuntime();
  const render = createAlienDerivedRenderAdapter(graph);

  return {
    runtimeToken: graph.runtimeToken,
    graphOwner: graph.graphOwner,
    getNodeForReadable: graph.getNodeForReadable,
    renderAdapter: render,
    signal: graph.signal,
    computed: graph.computed,
    effect: graph.effect,
    batch: graph.batch,
    untracked: graph.untracked,
    hasSubscribers: graph.hasSubscribers,
    hasActiveSubscriber: graph.hasActiveSubscriber,
    getBatchDepth: graph.getBatchDepth,
    createDeepSignal: graph.createDeepSignal,
    createDeepSignalVersion: graph.createDeepSignalVersion,
    markDeepSignalWatched: graph.markDeepSignalWatched,
    hasDeepSignalSubscribers: graph.hasDeepSignalSubscribers,
    isSpeculative: render.isSpeculative,
    markSpeculativeDeepRead: render.markSpeculativeDeepRead,
  };
}
