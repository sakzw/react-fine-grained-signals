import { createAlienDerivedRuntime } from "./alien-derived-runtime-core.mjs";
import type { AlienDerivedGraphRuntime, AlienDerivedRenderAdapter, RuntimeNode } from "./alien-derived-types.js";

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
  };
  getNodeForReadable(readable: RuntimeReadonlySignal<unknown>): RuntimeNode | undefined;
  readonly renderAdapter: AlienDerivedRenderAdapter;
  initializeRenderAdapter(factory: (graph: AlienDerivedGraphRuntime) => AlienDerivedRenderAdapter): AlienDerivedRenderAdapter;
  signal<T>(value: T): RuntimeSignal<T>;
  computed<T>(getter: () => T): RuntimeReadonlySignal<T>;
  computed<T>(getter: () => T, setter: (value: T) => void): RuntimeSignal<T>;
  effect(fn: () => void | (() => void)): () => void;
  detachedEffect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
  hasSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
  hasActiveSubscriber(): boolean;
  getBatchDepth(): number;
  createDeepSignal<T>(initialValue: T): RuntimeSignal<T>;
  createDeepSignalVersion<T>(initialValue: T): RuntimeSignal<T>;
  onDeepSignalUnwatched(readable: RuntimeReadonlySignal<unknown>, callback: () => void): void;
  markDeepSignalWatched(readable: RuntimeReadonlySignal<unknown>): void;
  hasDeepSignalSubscribers(readable: RuntimeReadonlySignal<unknown>): boolean;
  isSpeculative(): boolean;
  markSpeculativeDeepRead(): void;
}

/** Builds one Alien-derived graph; React installs its render adapter on demand. */
export function createReactiveRuntime(): ReactiveRuntime {
  const graph = createAlienDerivedRuntime();
  let render: AlienDerivedRenderAdapter | undefined;
  const initializeRenderAdapter = (factory: (graph: AlienDerivedGraphRuntime) => AlienDerivedRenderAdapter) => {
    if (render === undefined) render = factory(graph);
    return render;
  };

  return {
    runtimeToken: graph.runtimeToken,
    graphOwner: graph.graphOwner,
    getNodeForReadable: graph.getNodeForReadable,
    get renderAdapter() {
      if (render === undefined) throw new Error("The React render adapter has not been initialized.");
      return render;
    },
    initializeRenderAdapter,
    signal: graph.signal,
    computed: graph.computed as ReactiveRuntime["computed"],
    effect: graph.effect,
    detachedEffect: graph.detachedEffect,
    batch: graph.batch,
    untracked: graph.untracked,
    hasSubscribers: graph.hasSubscribers,
    hasActiveSubscriber: graph.hasActiveSubscriber,
    getBatchDepth: graph.getBatchDepth,
    createDeepSignal: graph.createDeepSignal,
    createDeepSignalVersion: graph.createDeepSignalVersion,
    onDeepSignalUnwatched: graph.onDeepSignalUnwatched,
    markDeepSignalWatched: graph.markDeepSignalWatched,
    hasDeepSignalSubscribers: graph.hasDeepSignalSubscribers,
    isSpeculative: () => render?.isSpeculative() ?? false,
    markSpeculativeDeepRead: () => render?.markSpeculativeDeepRead(),
  };
}
