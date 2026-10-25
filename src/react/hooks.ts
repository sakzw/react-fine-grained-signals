import {
  useCallback,
  useEffect as useReactEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { computed, deepSignal, signal, untracked } from "../core/index.js";
import { detachedEffect } from "../core/base.js";
import type {
  DeepSignal,
  FormBindableSignal,
  ReadonlySignal,
  WritableComputedOptions,
} from "../core/index.js";
import type { NotDeepSignal } from "../core/deep-signal.js";
import { untrackedRender } from "../core/render-tracking.js";
import { subscribeLocalReadable } from "../core/readable-subscription.js";
import type { DependencyList } from "react";
export { useSignalTracking } from "./use-signals.js";

const EMPTY_DEPENDENCIES: DependencyList = [];

/** Which of `useComputed`'s two mutually exclusive modes a call site uses. */
type ComputedMode = "without a dependency array" | "with a dependency array";
type DeepSignalValueMode = ComputedMode;
type ComputedCapability = "read-only" | "writable";

/** An immutable value that React can safely compare as an external-store snapshot. */
export type SignalSnapshot =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

type SelectorResult<S extends SignalSnapshot> =
  | { readonly kind: "value"; readonly value: S }
  | { readonly kind: "error"; readonly error: unknown };

function assertSignalSnapshot(value: unknown): asserts value is SignalSnapshot {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    throw new TypeError(
      "useDeepSignalValue selector must return a primitive snapshot; objects, Proxies, and functions are not supported",
    );
  }
}

/**
 * Shared `useSyncExternalStore` wiring for effect-backed subscriptions only:
 * the dynamic deep-selector store and structural-readable compatibility
 * fallback. This package's own readables use a direct watcher.
 * On `subscribe`, starts an `effect()` that reruns `onEvaluate` on relevant
 * writes and notifies React when it reports a change.
 *
 * `getSnapshot` is intentionally not this helper's concern — the caller
 * wires its own, whether that means recomputing fresh each call
 * (`useSignalValue`) or returning a cached result (the deep-selector store).
 *
 * An exception thrown by `onEvaluate` is swallowed here and treated as a
 * change worth notifying about. That leaves the next render-time snapshot
 * read to surface the error to an Error Boundary rather than letting the
 * background effect's exception escape through the signal writer.
 */
function createEffectBackedStoreSubscription(
  onEvaluate: () => boolean,
): (notify: () => void) => () => void {
  return (notify: () => void): (() => void) => {
    let isInitialRun = true;
    return detachedEffect(() => {
      let changed: boolean;
      try {
        changed = onEvaluate();
      } catch {
        changed = true;
      }
      if (isInitialRun) {
        isInitialRun = false;
        return;
      }
      if (changed) notify();
    });
  };
}

/**
 * Holds a selector result outside the reactive graph. A selector error must
 * not escape from the signal write that caused a reactive re-evaluation:
 * React needs to observe it during its next render so an Error Boundary can
 * handle it. The cached result also avoids rerunning the selector on every
 * render.
 */
function createDeepSelectorStore<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
) {
  const evaluate = (): SelectorResult<S> => {
    try {
      const value = untrackedRender(() => selector(source.value));
      assertSignalSnapshot(value);
      return { kind: "value", value };
    } catch (error) {
      return { kind: "error", error };
    }
  };

  let result = evaluate();
  // The store is built in render right before its first `getSnapshot`, so
  // that call can reuse the result just evaluated.
  let fresh = true;

  const hasChanged = (next: SelectorResult<S>): boolean => {
    if (result.kind !== next.kind) return true;
    return result.kind === "value" && next.kind === "value"
      ? !Object.is(result.value, next.value)
      : result.kind === "error" && next.kind === "error"
        ? !Object.is(result.error, next.error)
        : false;
  };

  let subscribers = 0;
  const subscribeEffect = createEffectBackedStoreSubscription(() => {
    const next = evaluate();
    if (!hasChanged(next)) return false;
    result = next;
    return true;
  });

  return {
    // Notify only when the primitive result or error identity changes; this
    // is the same Object.is rule used by useSyncExternalStore snapshots.
    subscribe(notify: () => void): () => void {
      subscribers += 1;
      const unsubscribe = subscribeEffect(notify);
      return () => {
        subscribers -= 1;
        unsubscribe();
      };
    },
    // The cache is kept current only while subscribed. Before the first
    // commit (or while an Activity boundary has disconnected the store), a
    // write would leave it stale, and React's render-end consistency check
    // of a concurrent render would commit that stale value next to fresh
    // ones. Re-evaluate then; Object.is keeps an unchanged primitive stable.
    getSnapshot(): S {
      if (fresh) fresh = false;
      else if (subscribers === 0) {
        const next = evaluate();
        if (hasChanged(next)) result = next;
      }
      if (result.kind === "error") throw result.error;
      return result.value;
    },
  };
}

/** Creates a signal whose identity is stable for the lifetime of this component. */
export function useSignal<T>(initialValue: T): FormBindableSignal<T> {
  const signalRef = useRef<FormBindableSignal<T> | undefined>(undefined);

  if (signalRef.current === undefined) {
    signalRef.current = signal(initialValue);
  }

  return signalRef.current;
}

/**
 * Creates a deep signal whose identity is stable for the component lifetime.
 * A factory is evaluated only while initializing a mounted component instance;
 * it must remain pure because React Strict Mode may replay initial rendering.
 */
export function useDeepSignal<T extends object>(
  initialValue: T | (() => T),
): DeepSignal<T> {
  const signalRef = useRef<DeepSignal<T> | undefined>(undefined);

  if (signalRef.current === undefined) {
    signalRef.current = deepSignal(
      typeof initialValue === "function" ? initialValue() : initialValue,
    );
  }

  return signalRef.current;
}

/**
 * Selects a property-level primitive snapshot from a deep signal.
 *
 * When `dependencies` is omitted, the initial selector closure is retained and
 * it must only depend on the deep signal. When provided, every non-signal
 * value captured by `selector` must be listed. Object and proxy results are
 * intentionally rejected because mutable snapshots cannot satisfy
 * `useSyncExternalStore` identity semantics.
 *
 * Choose either omitted or explicit dependencies for this call site for its
 * lifetime. An explicit dependency array must keep a fixed length, matching
 * `useMemo`'s rules. Mode and length changes are caught and thrown as clear
 * errors rather than left to degrade into React's silent warning.
 */
export function useDeepSignalValue<
  T extends object,
  S extends SignalSnapshot,
>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies?: DependencyList,
): S {
  const initialModeRef = useRef<DeepSignalValueMode | undefined>(undefined);
  const mode: DeepSignalValueMode = dependencies === undefined
    ? "without a dependency array"
    : "with a dependency array";
  initialModeRef.current ??= mode;
  if (initialModeRef.current !== mode) {
    const error = new Error(
      `useDeepSignalValue: the dependency-array mode changed between renders (from ${initialModeRef.current} to ${mode}) for this call site. Keep either omitting dependencies or passing an array consistently.`,
    );
    error.name = "UseDeepSignalValueModeChangeError";
    throw error;
  }

  // A variable-length `dependencies` would otherwise only surface as React's
  // dev-mode "changed size between renders" warning on the `useMemo` call
  // below, while silently recreating the store (and losing selector/error
  // history) on every subsequent render. Mirrors `useComputed`'s mode-switch
  // guard below: a violation is a loud, actionable error instead of a
  // silently degraded memo.
  const initialDependencyLengthRef = useRef<number | undefined>(undefined);
  if (dependencies !== undefined) {
    initialDependencyLengthRef.current ??= dependencies.length;
  }
  if (
    dependencies !== undefined &&
    dependencies.length !== initialDependencyLengthRef.current
  ) {
    const error = new Error(
      `useDeepSignalValue: the \`dependencies\` array length changed between renders (from ${initialDependencyLengthRef.current} to ${dependencies.length}) for this call site. Keep \`dependencies\` a fixed length across the component's lifetime, matching useMemo's rules.`,
    );
    error.name = "UseDeepSignalValueDependencyLengthChangeError";
    throw error;
  }

  const store = useMemo(
    () => createDeepSelectorStore(source, selector),
    dependencies === undefined ? [source] : [source, ...dependencies],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Creates a computed signal with a stable identity.
 *
 * When `dependencies` is omitted, the getter must only read signals. Its closure
 * stays stable across ordinary renders; Fast Refresh may recreate the memoized
 * computed so edited getters and setters take effect. Props, state, and other
 * non-signal values must not be captured in that mode.
 *
 * When the getter captures props, state, or any other non-signal value, list all
 * of those values in `dependencies`. React memoization then creates a separate
 * computed when they change, rather than replacing the getter of an existing
 * computed during render. An abandoned render therefore cannot change the
 * closure used by the previously committed computed. Choose one mode for a
 * component's lifetime and keep an explicit dependency array's length fixed.
 * Invalid mode or length changes throw before `useMemo` can create or reuse a
 * computed for the invalid call.
 */
export function useComputed<T>(
  getValue: () => T,
  dependencies?: DependencyList,
): ReadonlySignal<T>;
export function useComputed<T>(
  options: WritableComputedOptions<T>,
  dependencies?: DependencyList,
): FormBindableSignal<T>;
export function useComputed<T>(
  source: (() => T) | WritableComputedOptions<T>,
  dependencies?: DependencyList,
): ReadonlySignal<T> | FormBindableSignal<T> {
  const capability: ComputedCapability =
    typeof source === "function" ? "read-only" : "writable";
  const mode: ComputedMode =
    dependencies === undefined ? "without a dependency array" : "with a dependency array";
  // -1 represents the omitted mode; an explicit array is represented by its
  // length. One primitive ref tracks both contracts without another allocation.
  const dependencyToken = dependencies === undefined ? -1 : dependencies.length;
  const initialDependencyTokenRef = useRef(dependencyToken);
  const initialCapabilityRef = useRef(capability);
  const initialDependencyToken = initialDependencyTokenRef.current;

  // Both directions of a mode switch are silently destructive, so neither is
  // allowed to reach the caller as a mystery. Going deps -> no-deps used to
  // hand back `undefined` typed as `ReadonlySignal<T>`, so the crash surfaced
  // at the call site as "Cannot read properties of undefined (reading
  // 'value')" with nothing pointing back here. Going no-deps -> deps quietly
  // built a *second* computed with a new identity mid-lifetime, invalidating
  // every subscription already made to the first.
  if ((initialDependencyToken < 0) !== (dependencyToken < 0)) {
    const initialMode: ComputedMode = initialDependencyToken < 0
      ? "without a dependency array"
      : "with a dependency array";
    const error = new Error(
      `useComputed: dependency-array mode changed from ${initialMode} to ${mode}; keep it consistent.`,
    );
    error.name = "UseComputedModeChangeError";
    throw error;
  }

  if (initialCapabilityRef.current !== capability) {
    const error = new Error(
      `useComputed: capability changed from ${initialCapabilityRef.current} to ${capability}; keep the getter form consistent.`,
    );
    error.name = "UseComputedCapabilityChangeError";
    throw error;
  }

  if (
    dependencyToken >= 0 &&
    dependencyToken !== initialDependencyToken
  ) {
    const error = new Error(
      `useComputed: dependencies length changed from ${initialDependencyToken} to ${dependencyToken}; keep it fixed.`,
    );
    error.name = "UseComputedDependencyLengthChangeError";
    throw error;
  }

  const memoizedComputed = useMemo(
    () => typeof source === "function" ? computed(source) : computed(source),
    dependencies ?? EMPTY_DEPENDENCIES,
  );
  return memoizedComputed;
}

/**
 * Runs a reactive effect after this component has committed, disposing it when
 * the component unmounts (and during React Strict Mode's development replay).
 *
 * When `dependencies` is omitted, the callback must only capture signals. Its
 * initial closure is retained for the component lifetime, so unrelated React
 * renders do not restart the effect. Omitted dependencies and `[]` are
 * equivalent here, unlike `useEffect` itself; non-empty dependency arrays must
 * keep a fixed length so React cannot retain a stale callback after warning.
 *
 * When the callback captures props, state, or any other non-signal value, list
 * all of those values in `dependencies`. The effect is then reconnected after
 * those dependencies change.
 */
export function useSignalEffect(
  callback: () => void | (() => void),
  dependencies?: DependencyList,
): void {
  const initialDependencyLengthRef = useRef(dependencies?.length ?? 0);
  const dependencyLength = dependencies?.length ?? 0;
  if (dependencyLength !== initialDependencyLengthRef.current) {
    const error = new Error(
      `useSignalEffect: dependencies length changed from ${initialDependencyLengthRef.current} to ${dependencyLength}; keep it fixed.`,
    );
    error.name = "UseSignalEffectDependencyLengthChangeError";
    throw error;
  }
  useReactEffect(() => detachedEffect(callback), dependencies ?? EMPTY_DEPENDENCIES);
}

/**
 * Reads a signal and subscribes the component to subsequent changes through
 * a direct watcher when it is one of this package's readables.
 *
 * `useSyncExternalStore` owns the initial consistency check after subscribing.
 * A read that throws (a computed whose cached error `.value` rethrows) remains
 * for the render-time `getSnapshot` to surface to an Error Boundary; only the
 * structural-readable fallback needs an effect to contain background errors.
 *
 * A `deepSignal` is rejected at compile time: this subscribes to root
 * replacement only, so nested mutations would never re-render. Read deep state
 * with `useDeepSignalValue` or inside a tracked component instead.
 */
export function useSignalValue<T>(source: ReadonlySignal<T> & NotDeepSignal): T {
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribe = subscribeLocalReadable(source, notify);
    if (unsubscribe !== undefined) return unsubscribe;
    // Structural readables from elsewhere need the effect bridge.
    return createEffectBackedStoreSubscription(() => {
      source.value;
      return true;
    })(notify);
  }, [source]);

  // A leaf subscription owns this read. An unmanaged useSignalTracking() scope may
  // still be open for an ancestor or earlier sibling until React commits, so
  // do not also register the source with that component's render collector.
  // `untrackedRender()` clears only render dependency collection.
  // `untracked()` also suppresses dependency collection in RFSG's runtime,
  // whose runtime-local `activeSub` is owned by `createReactiveRuntime()`.
  // A snapshot read during an RFSG effect or computed evaluation must use
  // `untracked()` so it cannot graft this source onto that subscriber.
  const getSnapshot = useCallback(
    () => untracked(() => source.value),
    [source],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
