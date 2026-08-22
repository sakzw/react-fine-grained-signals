import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  setActiveRenderCollector,
  type RenderCollector,
  type RenderDependency,
} from "../core/render-tracking.js";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
const resolvedPromise = Promise.resolve();

let currentStore: RenderStore | undefined;
let finalCleanupScheduled = false;

function cleanupTrailingStore(): void {
  finalCleanupScheduled = false;
  currentStore?.finish();
}

function ensureFinalCleanup(): void {
  if (finalCleanupScheduled) return;
  finalCleanupScheduled = true;
  void resolvedPromise.then(cleanupTrailingStore);
}

class RenderStore implements RenderCollector {
  readonly #reactListeners = new Set<() => void>();
  #dependencyUnsubscribers: Array<() => void> = [];
  #pendingDependencies?: Map<RenderDependency, number>;
  #finishCollection?: () => void;
  #disposeGeneration = 0;
  #version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#disposeGeneration += 1;
    this.#reactListeners.add(listener);

    return () => {
      this.#reactListeners.delete(listener);
      if (this.#reactListeners.size !== 0) return;

      const generation = ++this.#disposeGeneration;
      void resolvedPromise.then(() => {
        if (
          generation === this.#disposeGeneration &&
          this.#reactListeners.size === 0
        ) {
          this.#disposeDependencies();
          this.#pendingDependencies = undefined;
        }
      });
    };
  };

  readonly getSnapshot = (): number => this.#version;

  add(dependency: RenderDependency): void {
    this.#pendingDependencies?.set(
      dependency,
      dependency.getRenderVersion(),
    );
  }

  start(): void {
    currentStore?.finish();
    this.#pendingDependencies = new Map();
    const previousCollector = setActiveRenderCollector(this);
    currentStore = this;
    this.#finishCollection = () => {
      setActiveRenderCollector(previousCollector);
      if (currentStore === this) currentStore = undefined;
    };
  }

  finish(): void {
    const finishCollection = this.#finishCollection;
    this.#finishCollection = undefined;
    finishCollection?.();
  }

  commit(): void {
    const dependencies = this.#pendingDependencies;
    this.#pendingDependencies = undefined;
    if (dependencies === undefined) return;

    this.#disposeDependencies();
    let changedDuringRender = false;
    for (const [dependency, renderVersion] of dependencies) {
      if (dependency.getRenderVersion() !== renderVersion) {
        changedDuringRender = true;
      }
      this.#dependencyUnsubscribers.push(
        dependency.subscribeRender(this.#notifyReact),
      );
    }

    if (changedDuringRender) this.#notifyReact();
  }

  readonly #notifyReact = (): void => {
    this.#version = (this.#version + 1) | 0;
    for (const listener of [...this.#reactListeners]) listener();
  };

  #disposeDependencies(): void {
    for (const unsubscribe of this.#dependencyUnsubscribers.splice(0)) {
      unsubscribe();
    }
  }
}

/**
 * Makes the component reactive to signals whose `.value` is read during render.
 * Call this as the component's first hook and before those reads.
 */
export function useSignals(): void {
  ensureFinalCleanup();
  const storeRef = useRef<RenderStore | undefined>(undefined);
  if (storeRef.current === undefined) storeRef.current = new RenderStore();
  const store = storeRef.current;

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  store.start();
  useIsomorphicLayoutEffect(() => {
    cleanupTrailingStore();
    store.commit();
  });
}
