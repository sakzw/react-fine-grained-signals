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

/**
 * Module-global state backing the managed/best-effort render-scope
 * boundary. At most one `RenderStore` is "current" at a time: a component's
 * `.start()` (called at the top of `useSignalsImplementation`, before it
 * reads any signals) opens it, and closing it is what stops later `.value`
 * reads from being attributed to it — every read after a close belongs to
 * whichever scope opens next, not a leftover one from earlier in the render
 * pass.
 *
 * A scope is closed by whichever of these three paths reaches it first:
 *
 *  1. `start()`'s own pre-emptive close (see `shouldCloseCurrentScope`
 *     below) — the next component's `start()` finds a still-open scope
 *     that isn't a legitimate managed/managed nesting and force-closes it
 *     before opening its own, so a scope that outlives its owner's render
 *     can't leak reads into a sibling or the next component down.
 *  2. The commit-phase layout effect (`useIsomorphicLayoutEffect` in
 *     `useSignalsImplementation`) — the normal, on-time close: the owning
 *     component's own scope, if nothing already closed it, is finished
 *     right before `store.commit()` subscribes to whatever it read.
 *  3. The microtask scheduled by `ensureFinalCleanup` — the fallback for an
 *     unmanaged (`useSignals()`) scope that reaches neither path above, for
 *     example a component that reads signals during render but then
 *     throws, suspends, or is otherwise abandoned before committing.
 *     Managed scopes (`useManagedSignals()`) opt out of this fallback (see
 *     the `!managed` guard in `useSignalsImplementation`) because their
 *     owner is contractually responsible for calling `finish()`/`f()`
 *     itself, synchronously, before returning.
 */
let currentStore: RenderStore | undefined;
let finalCleanupScheduled = false;

/**
 * The nesting rule for path 1 above: a still-open scope is left alone only
 * when both it and the incoming `next` scope are managed. A managed scope's
 * owner is contractually responsible for closing it itself, so two managed
 * scopes overlapping is tolerated as a transient nesting rather than treated
 * as one of them having been abandoned. Anything else overlapping a
 * still-open scope — `next` is unmanaged, or the still-open scope itself is
 * unmanaged — is not a rule-following nesting, so the leftover scope is
 * force-closed before `next` starts.
 */
function shouldCloseCurrentScope(next: RenderStore, current: RenderStore): boolean {
  return !next.managed || !current.managed;
}

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
  // Both are cleared back to `undefined` rather than left absent — that is how
  // "not collecting" and "collection already finished" are represented — so
  // `undefined` belongs in the type, not just the absence of the slot.
  #pendingDependencies?: Map<RenderDependency, number> | undefined;
  #finishCollection?: (() => void) | undefined;
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
    // See `shouldCloseCurrentScope` above for the nesting rule this enforces.
    if (currentStore !== undefined && shouldCloseCurrentScope(this, currentStore)) {
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
 *
 * The boundary is best-effort: tracking stays open until the next
 * `useSignals()` call, the commit-phase layout effect, or a microtask — not the
 * point the component returns. Every component that reads a signal during
 * render must call this itself; a read from a sibling or descendant that does
 * not can be attributed to another component's still-open boundary, and then
 * silently stops updating the component that read it. Use the bundler
 * plugin's default `transform: "managed"` for an exact boundary. See
 * docs/design/use-signals-boundary-design.md.
 */
export function useSignals(): void {
  useSignalsImplementation(false);
}

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
  f(): void;
}

/** Starts a managed render scope that must be closed synchronously with `finish()` (or its `f()` alias). */
export function useManagedSignals(): ManagedSignalsStore {
  return useSignalsImplementation(true);
}
