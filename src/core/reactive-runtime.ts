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
  initializeRenderAdapter(
    factory: (graph: AlienDerivedGraphRuntime) => AlienDerivedRenderAdapter,
  ): AlienDerivedRenderAdapter;
  signal<T>(value: T): RuntimeSignal<T>;
  computed<T>(getter: () => T): RuntimeReadonlySignal<T>;
  computed<T>(getter: () => T, setter: (value: T) => void): RuntimeSignal<T>;
  effect(fn: () => void | (() => void)): () => void;
  detachedEffect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  batchUntracked<T>(fn: () => T): T;
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

  // The graph's own members are copied whole (the internal ones the render
  // adapter uses come along unused): listing each one cost bundle bytes.
  return {
    ...graph,
    get renderAdapter() {
      if (render === undefined) throw new Error("The React render adapter has not been initialized.");
      return render;
    },
    initializeRenderAdapter,
    computed: graph.computed as ReactiveRuntime["computed"],
    isSpeculative: () => render?.isSpeculative() ?? false,
    markSpeculativeDeepRead: () => render?.markSpeculativeDeepRead(),
  };
}
