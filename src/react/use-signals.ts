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
  readonly managed: boolean;
  readonly #reactListeners = new Set<() => void>();
  #dependencySubscriptions = new Map<RenderDependency, () => void>();
  #pendingDependencies?: Map<RenderDependency, number>;
  #finishCollection?: () => void;
  #disposeGeneration = 0;
  #version = 0;

  constructor(managed: boolean) {
    this.managed = managed;
  }

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
    if (currentStore !== undefined && (!this.managed || !currentStore.managed)) {
      currentStore.finish();
    }
    const previousStore = currentStore;
    this.#pendingDependencies = new Map();
    const previousCollector = setActiveRenderCollector(this);
    // Tracks the active collector across the module, not a scoping mistake.
    // oxlint-disable-next-line typescript/no-this-alias
    currentStore = this;
    this.#finishCollection = () => {
      setActiveRenderCollector(previousCollector);
      if (currentStore === this) currentStore = previousStore;
    };
  }

  finish(): void {
    const finishCollection = this.#finishCollection;
    this.#finishCollection = undefined;
    finishCollection?.();
  }

  f(): void {
    this.finish();
  }

  commit(): void {
    const dependencies = this.#pendingDependencies;
    this.#pendingDependencies = undefined;
    if (dependencies === undefined) return;

    // Diff against the previous commit's subscriptions instead of
    // unconditionally tearing everything down and resubscribing: a
    // dependency still read on this render keeps its existing subscription
    // alive. Unsubscribing a computed's render bridge only to immediately
    // resubscribe forces it through a cold first evaluation every commit,
    // which loses its Object.is memoization for any getter that returns a
    // new object/array identity each call (e.g. `.slice()`/`.filter()`) —
    // that cold read always looks "changed", which forced another commit,
    // forever. Keeping a continuously-read dependency's subscription intact
    // avoids that churn entirely.
    for (const [dependency, unsubscribe] of this.#dependencySubscriptions) {
      if (!dependencies.has(dependency)) {
        unsubscribe();
        this.#dependencySubscriptions.delete(dependency);
      }
    }

    let changedDuringRender = false;
    for (const [dependency, renderVersion] of dependencies) {
      if (!this.#dependencySubscriptions.has(dependency)) {
        this.#dependencySubscriptions.set(
          dependency,
          dependency.subscribeRender(this.#notifyReact),
        );
      }
      if (dependency.getRenderVersion() !== renderVersion) {
        changedDuringRender = true;
      }
    }

    if (changedDuringRender) this.#notifyReact();
  }

  readonly #notifyReact = (): void => {
    this.#version = (this.#version + 1) | 0;
    // Snapshot before iterating: a listener may (un)subscribe synchronously.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.#reactListeners]) listener();
  };

  #disposeDependencies(): void {
    for (const unsubscribe of this.#dependencySubscriptions.values()) {
      unsubscribe();
    }
    this.#dependencySubscriptions.clear();
  }
}

/**
 * Makes the component reactive to signals whose `.value` is read during render.
 * Call this as the component's first hook and before those reads.
 */
function useSignalsImplementation(managed: boolean): RenderStore {
  if (!managed) ensureFinalCleanup();
  const storeRef = useRef<RenderStore | undefined>(undefined);
  if (storeRef.current === undefined) storeRef.current = new RenderStore(managed);
  const store = storeRef.current;

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  store.start();
  useIsomorphicLayoutEffect(() => {
    cleanupTrailingStore();
    store.commit();
  });
  return store;
}

/**
 * Makes the component reactive to signals whose `.value` is read during render.
 * Call this as the component's first hook and before those reads.
 */
export function useSignals(): void {
  useSignalsImplementation(false);
}

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
  f(): void;
}

/** Starts a managed render scope that must be closed synchronously with `f()`. */
export function useManagedSignals(): ManagedSignalsStore {
  return useSignalsImplementation(true);
}
