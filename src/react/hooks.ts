import { useCallback, useEffect as useReactEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { computed, deepCollectionSignal, deepSignal, isSignal, signal, untracked } from "../core/index.js";
import { detachedEffect } from "../core/base.js";
import type {
  DeepCollectionSignal,
  DeepSignal,
  Signal,
  ReadonlySignal,
  WritableComputedOptions,
} from "../core/index.js";
import type { NotDeepSignal, PlainRoot } from "../core/deep-signal.js";
import { untrackedRender } from "../core/render-tracking.js";
import { subscribeLocalReadable } from "../core/readable-subscription.js";
import type { DependencyList } from "react";
export { useSignalTracking } from "./use-signals.js";

const EMPTY_DEPENDENCIES: DependencyList = [];

/**
 * Throws when a dependency array changes length between renders of one call
 * site. Omitting the array counts as an empty one. Call it before the
 * `useMemo` or `useEffect` that consumes the array: React itself only warns
 * in development about a resized array, and the memo or effect would then
 * silently misbehave.
 */
function useFixedDependencyLength(hook: string, errorName: string, dependencies: DependencyList | undefined): void {
  const length = dependencies?.length ?? 0;
  const initialLengthRef = useRef(length);
  if (length !== initialLengthRef.current) {
    const error = new Error(
      `${hook}: dependencies length changed from ${initialLengthRef.current} to ${length}; keep the array the same length on every render.`,
    );
    error.name = errorName;
    throw error;
  }
}

/** An immutable value that React can safely compare as an external-store snapshot. */
export type SignalSnapshot = string | number | boolean | bigint | symbol | null | undefined;

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
function createEffectBackedStoreSubscription(onEvaluate: () => boolean): (notify: () => void) => () => void {
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
  source: DeepSignal<T> | DeepCollectionSignal<T>,
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
export function useSignal<T>(initialValue: T): Signal<T> {
  const signalRef = useRef<Signal<T> | undefined>(undefined);

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
export function useDeepSignal<T extends object>(initialValue: PlainRoot<T> | (() => PlainRoot<T>)): DeepSignal<T> {
  const signalRef = useRef<DeepSignal<T> | undefined>(undefined);

  if (signalRef.current === undefined) {
    signalRef.current = deepSignal(typeof initialValue === "function" ? initialValue() : initialValue);
  }

  return signalRef.current;
}

/**
 * Creates a deep collection signal whose identity is stable for the component
 * lifetime: a {@link useDeepSignal} that also tracks Map, Set, WeakMap and
 * WeakSet values. The factory rules are the same.
 */
export function useDeepCollectionSignal<T extends object>(initialValue: T | (() => T)): DeepCollectionSignal<T> {
  const signalRef = useRef<DeepCollectionSignal<T> | undefined>(undefined);

  if (signalRef.current === undefined) {
    signalRef.current = deepCollectionSignal(typeof initialValue === "function" ? initialValue() : initialValue);
  }

  return signalRef.current;
}

/**
 * Selects a property-level primitive snapshot from a deep signal (from
 * `deepSignal` or `deepCollectionSignal`).
 *
 * When `dependencies` is omitted, the initial selector closure is retained and
 * it must only depend on the deep signal. When non-empty, every non-signal
 * value captured by `selector` must be listed. Object and proxy results are
 * intentionally rejected because mutable snapshots cannot satisfy
 * `useSyncExternalStore` identity semantics.
 *
 * Omitting `dependencies` is the same as passing `[]`. The array must keep a
 * fixed length, matching `useMemo`'s rules; a length change is thrown as a
 * clear error rather than left to degrade into React's silent warning.
 */
export function useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T> | DeepCollectionSignal<T>,
  selector: (value: T) => S,
  dependencies?: DependencyList,
): S {
  // A resized array would otherwise recreate the store (losing selector and
  // error history) on every later render, with only React's dev warning.
  useFixedDependencyLength("useDeepSignalValue", "UseDeepSignalValueDependencyLengthChangeError", dependencies);
  const store = useMemo(
    () => createDeepSelectorStore(source, selector),
    [source, ...(dependencies ?? EMPTY_DEPENDENCIES)],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Creates a read-only computed signal with a stable identity.
 *
 * When `dependencies` is omitted (the same as `[]`), the getter must only read
 * signals. Its closure stays stable across ordinary renders; Fast Refresh may
 * recreate the memoized computed so edited getters take effect. Props, state,
 * and other non-signal values must not be captured in that mode.
 *
 * When the getter captures props, state, or any other non-signal value, list all
 * of those values in `dependencies`. React memoization then creates a separate
 * computed when they change, rather than replacing the getter of an existing
 * computed during render. An abandoned render therefore cannot change the
 * closure used by the previously committed computed. Keep the array's length
 * fixed; a length change throws before `useMemo` can create or reuse a
 * computed for the invalid call.
 */
export function useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T> {
  useFixedDependencyLength("useComputed", "UseComputedDependencyLengthChangeError", dependencies);
  return useMemo(() => computed(getValue), dependencies ?? EMPTY_DEPENDENCIES);
}

/**
 * Creates a writable computed signal with a stable identity. The dependency
 * rules are those of {@link useComputed}: omitting `dependencies` is the same
 * as `[]`, and both `get` and `set` must list any non-signal value they
 * capture.
 */
export function useWritableComputed<T>(options: WritableComputedOptions<T>, dependencies?: DependencyList): Signal<T> {
  useFixedDependencyLength("useWritableComputed", "UseWritableComputedDependencyLengthChangeError", dependencies);
  return useMemo(() => computed(options), dependencies ?? EMPTY_DEPENDENCIES);
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
export function useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void {
  useFixedDependencyLength("useSignalEffect", "UseSignalEffectDependencyLengthChangeError", dependencies);
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
  // A signal another loaded copy of the package created cannot be subscribed to
  // from here. `isSignal` throws for it, so the mix fails now instead of
  // leaving the component on a value that never updates.
  isSignal(source);
  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribe = subscribeLocalReadable(source, notify);
      if (unsubscribe !== undefined) return unsubscribe;
      // Structural readables from elsewhere need the effect bridge.
      return createEffectBackedStoreSubscription(() => {
        source.value;
        return true;
      })(notify);
    },
    [source],
  );

  // A leaf subscription owns this read. An unmanaged useSignalTracking() scope may
  // still be open for an ancestor or earlier sibling until React commits, so
  // do not also register the source with that component's render collector.
  // `untrackedRender()` clears only render dependency collection.
  // `untracked()` also suppresses dependency collection in RFSG's runtime,
  // whose runtime-local `activeSub` is owned by `createReactiveRuntime()`.
  // A snapshot read during an RFSG effect or computed evaluation must use
  // `untracked()` so it cannot graft this source onto that subscriber.
  const getSnapshot = useCallback(() => untracked(() => source.value), [source]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
