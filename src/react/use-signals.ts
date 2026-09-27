import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  getForeignRenderDependency,
  notifyListener,
  setActiveRenderCollector,
  type RenderCollector,
  type RenderDependency,
} from "../core/render-tracking.js";
import {
  getSharedInteropContext,
  pushInteropRenderScope,
  type InteropRenderScopeV1,
  type ReadableInteropV1,
} from "../core/interop.js";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
const resolvedPromise = Promise.resolve();

/** Coalesces only the bare hook's best-effort trailing cleanup microtask. */
let finalCleanupScheduled = false;

type RenderScopePolicy = "managed" | "bare";

/**
 * A still-open scope is left alone only when both it and the incoming `next`
 * scope are managed. A managed scope's owner is contractually responsible
 * for closing it itself, so overlapping managed scopes are tolerated as a
 * transient nesting rather than treated
 * as one of them having been abandoned. Anything else overlapping a
 * still-open scope — `next` is unmanaged, or the still-open scope itself is
 * unmanaged — is not a rule-following nesting, so the leftover scope is
 * force-closed before `next` starts.
 */
function shouldCloseCurrentScope(
  next: RenderScopePolicy,
  current: { managed: boolean },
): boolean {
  return next === "bare" || !current.managed;
}

/** Close only a bare top scope; managed scopes own a synchronous `finish()`. */
function cleanupTrailingBareScope(): void {
  finalCleanupScheduled = false;
  const scope = getSharedInteropContext().renderScope;
  if (scope !== undefined && !scope.managed) scope.finish();
}

function ensureFinalCleanup(): void {
  if (finalCleanupScheduled) return;
  finalCleanupScheduled = true;
  // Unlike subscribe()'s disposal microtask, this closes abandoned bare scopes.
  void resolvedPromise.then(cleanupTrailingBareScope);
}

class RenderStore implements RenderCollector {
  readonly #reactListeners = new Set<() => void>();
  #dependencySubscriptions = new Map<RenderDependency, () => void>();
  // Both are cleared back to `undefined` rather than left absent — that is how
  // "not collecting" and "collection already finished" are represented — so
  // `undefined` belongs in the type, not just the absence of the slot.
  #pendingDependencies?: Map<RenderDependency, number> | undefined;
  #finishCollection?: (() => void) | undefined;
  #disposeGeneration = 0;
  #version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#disposeGeneration += 1;
    this.#reactListeners.add(listener);

    return () => {
      this.#reactListeners.delete(listener);
      if (this.#reactListeners.size !== 0) return;

      const generation = ++this.#disposeGeneration;
      // This only preserves dependencies across React's
      // unsubscribe/resubscribe replay; bare-scope recovery is separate.
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

  add(dependency: RenderDependency, observedVersion: number): void;
  add(protocol: ReadableInteropV1, observedVersion: number): void;
  add(dependencyOrProtocol: RenderDependency | ReadableInteropV1, observedVersion: number): void {
    const dependency = "getRevision" in dependencyOrProtocol
      ? getForeignRenderDependency(dependencyOrProtocol)
      : dependencyOrProtocol;
    const pending = this.#pendingDependencies;
    if (pending !== undefined && !pending.has(dependency)) {
      pending.set(dependency, observedVersion);
    }
  }

  start(policy: RenderScopePolicy): void {
    // A store must never restore its own collector as its parent. Managed
    // nesting is only valid between distinct component/custom-hook stores.
    if (this.#finishCollection !== undefined) this.finish();

    // The shared interop scope is the single arbitration authority for both
    // same-copy and duplicate-package boundaries.
    const sharedContext = getSharedInteropContext();
    while (
      sharedContext.renderScope !== undefined &&
      shouldCloseCurrentScope(policy, sharedContext.renderScope)
    ) {
      sharedContext.renderScope.finish();
    }

    this.#pendingDependencies = new Map();
    const previousCollector = setActiveRenderCollector(this);
    let scopeActive = true;
    const sharedScope: InteropRenderScopeV1 = {
      token: {},
      managed: policy === "managed",
      isActive: () => scopeActive,
      finish: () => this.finish(),
    };
    const restoreSharedScope = pushInteropRenderScope(sharedScope, this);
    this.#finishCollection = () => {
      scopeActive = false;
      restoreSharedScope();
      setActiveRenderCollector(previousCollector);
    };
  }

  isScopeActive(): boolean {
    return this.#finishCollection !== undefined;
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
    // `notifyListener` isolates a throwing listener so it cannot cancel the
    // ones queued behind it in this same cycle.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.#reactListeners]) notifyListener(listener);
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
function useSignalTrackingImplementation(policy: RenderScopePolicy): RenderStore {
  if (policy === "bare") ensureFinalCleanup();
  const storeRef = useRef<RenderStore | undefined>(undefined);
  if (storeRef.current === undefined) storeRef.current = new RenderStore();
  const store = storeRef.current;

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  store.start(policy);
  useIsomorphicLayoutEffect(() => {
    if (policy === "bare") {
      cleanupTrailingBareScope();
    } else if (store.isScopeActive()) {
      // The synchronous finally is the managed contract. Close only this
      // store as a last-resort guard if a manual caller forgot to finish().
      store.finish();
    }
    store.commit();
  });
  return store;
}

/**
 * Makes the component reactive to signals whose `.value` is read during render.
 * Call this as the component's first hook and before those reads.
 *
 * The boundary is best-effort: tracking stays open until the next
 * `useSignalTracking()` call, the commit-phase layout effect, or a microtask — not the
 * point the component returns. Every component that reads a signal during
 * render must call this itself; a read from a sibling or descendant that does
 * not can be attributed to another component's still-open boundary, and then
 * silently stops updating the component that read it. Use the bundler
 * plugin's default `transform: "managed"` for an exact boundary. See
 * docs/design/use-signals-boundary-design.md.
 */
export function useSignalTracking(): void {
  useSignalTrackingImplementation("bare");
}

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
}

/** Starts a managed render scope that must be closed synchronously with `finish()`. */
export function useManagedSignals(): ManagedSignalsStore {
  return useSignalTrackingImplementation("managed");
}
