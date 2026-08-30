import {
  useCallback,
  useEffect as useReactEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { computed, deepSignal, effect, signal, untracked } from "../core/index.js";
import type {
  DeepSignal,
  ReadonlySignal,
  Signal,
} from "../core/index.js";
import { untrackedRender } from "../core/render-tracking.js";
import type { DependencyList } from "react";
export { useSignals } from "./use-signals.js";

const EMPTY_DEPENDENCIES: DependencyList = [];

/** Which of `useComputed`'s two mutually exclusive modes a call site uses. */
type ComputedMode = "without a dependency array" | "with a dependency array";

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
 * Shared `useSyncExternalStore` subscription wiring for a signal-backed
 * store. On `subscribe`, starts an `effect()` that reruns `onEvaluate` on
 * every relevant signal write and notifies React exactly when it reports a
 * change; returns that effect's own dispose as the unsubscribe. The very
 * first synchronous run — made while `subscribe` itself is still
 * establishing the effect — never notifies, matching how each caller here
 * already behaved: `useSyncExternalStore` performs its own "did the
 * snapshot change since render" check independently of anything a `notify`
 * call does, so a store's own subscribe-time run does not need to report on
 * that window too.
 *
 * `getSnapshot` is intentionally not this helper's concern — the caller
 * wires its own, whether that means recomputing fresh each call
 * (`useSignalValue`) or returning a cached result (the deep-selector store).
 *
 * An exception thrown by `onEvaluate` is swallowed here and treated as a
 * change worth notifying about. This mirrors `useSignalValue`'s prior
 * inline behavior: a computed that starts failing must still trigger a
 * re-render so `getSnapshot`'s own unguarded read can rethrow into an Error
 * Boundary, rather than leaving this background effect's throw to escape
 * into whatever write triggered the re-run. Callers whose `onEvaluate`
 * already captures errors into its own return value (the deep-selector
 * store) never hit this path.
 */
function createSignalStore(onEvaluate: () => boolean): (notify: () => void) => () => void {
  return (notify: () => void): (() => void) => {
    let isInitialRun = true;
    return effect(() => {
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
 * Holds a selector result outside the reactive graph. In particular, a
 * selector error must not escape from the signal write that caused a reactive
 * re-evaluation: React needs to observe it during its next render so an Error
 * Boundary can handle it. Unlike `useSignalValue`, errors are modeled as an
 * explicit `SelectorResult` union rather than swallowed and re-thrown from a
 * fresh read: `getSnapshot` below must return the same cached result the
 * subscribed effect last settled on, not re-run `selector` on every render.
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

  const hasChanged = (next: SelectorResult<S>): boolean => {
    if (result.kind !== next.kind) return true;
    return result.kind === "value" && next.kind === "value"
      ? !Object.is(result.value, next.value)
      : result.kind === "error" && next.kind === "error"
        ? !Object.is(result.error, next.error)
        : false;
  };

  return {
    // Layers Object.is diffing on top of the shared subscribe/notify core:
    // an update to the deep signal reruns `selector`, but only a result that
    // actually differs from the last one (by Object.is, same rule the
    // `getSnapshot`-level comparison in `useSyncExternalStore` itself uses)
    // is worth a React re-render.
    subscribe: createSignalStore(() => {
      const next = evaluate();
      if (!hasChanged(next)) return false;
      result = next;
      return true;
    }),
    getSnapshot(): S {
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
 * Every non-signal value captured by `selector` must be listed in
 * `dependencies`. Object and proxy results are intentionally rejected because
 * mutable snapshots cannot satisfy `useSyncExternalStore` identity semantics.
 *
 * `dependencies` must keep a fixed length across this component's lifetime,
 * matching `useMemo`'s own rule (its length feeds a `useMemo` deps array
 * below via `[source, ...dependencies]`). A length change is caught and
 * thrown as a clear error rather than left to degrade into React's silent
 * "changed size between renders" dev warning, mirroring `useComputed`'s
 * dependency-mode-switch guard.
 */
export function useDeepSignalValue<
  T extends object,
  S extends SignalSnapshot,
>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies: DependencyList,
): S {
  // A variable-length `dependencies` would otherwise only surface as React's
  // dev-mode "changed size between renders" warning on the `useMemo` call
  // below, while silently recreating the store (and losing selector/error
  // history) on every subsequent render. Mirrors `useComputed`'s mode-switch
  // guard below: a violation is a loud, actionable error instead of a
  // silently degraded memo.
  const initialDependencyLengthRef = useRef<number | undefined>(undefined);
  initialDependencyLengthRef.current ??= dependencies.length;
  if (dependencies.length !== initialDependencyLengthRef.current) {
    const error = new Error(
      `useDeepSignalValue: the \`dependencies\` array length changed between renders (from ${initialDependencyLengthRef.current} to ${dependencies.length}) for this call site. Keep \`dependencies\` a fixed length across the component's lifetime, matching useMemo's rules.`,
    );
    error.name = "UseDeepSignalValueDependencyLengthChangeError";
    throw error;
  }

  const store = useMemo(
    () => createDeepSelectorStore(source, selector),
    [source, ...dependencies],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Creates a computed signal with a stable identity.
 *
 * When `dependencies` is omitted, the getter must only read signals. Its initial
 * closure is retained for the component lifetime, so props, state, and other
 * non-signal values must not be captured in that mode.
 *
 * When the getter captures props, state, or any other non-signal value, list all
 * of those values in `dependencies`. React memoization then creates a separate
 * computed when they change, rather than replacing the getter of an existing
 * computed during render. An abandoned render therefore cannot change the
 * closure used by the previously committed computed. Choose one mode for a
 * component's lifetime.
 */
export function useComputed<T>(
  getValue: () => T,
  dependencies?: DependencyList,
): ReadonlySignal<T> {
  const dependencyComputed = useMemo(
    () =>
      dependencies === undefined
        ? undefined
        : computed(getValue),
    dependencies ?? EMPTY_DEPENDENCIES,
  );

  const initialModeRef = useRef<ComputedMode | undefined>(undefined);
  const signalOnlyComputedRef = useRef<ReadonlySignal<T> | undefined>(undefined);

  // Both directions of a mode switch are silently destructive, so neither is
  // allowed to reach the caller as a mystery. Going deps -> no-deps used to
  // hand back `undefined` typed as `ReadonlySignal<T>`, so the crash surfaced
  // at the call site as "Cannot read properties of undefined (reading
  // 'value')" with nothing pointing back here. Going no-deps -> deps quietly
  // built a *second* computed with a new identity mid-lifetime, invalidating
  // every subscription already made to the first.
  const mode: ComputedMode =
    dependencies === undefined ? "without a dependency array" : "with a dependency array";
  initialModeRef.current ??= mode;
  if (initialModeRef.current !== mode) {
    const error = new Error(
      `useComputed: the dependency-array mode changed between renders (from ${initialModeRef.current} to ${mode}) for this call site. Keep passing deps consistently, matching useMemo's rules.`,
    );
    error.name = "UseComputedModeChangeError";
    throw error;
  }

  // Defined exactly when `dependencies` is, per the memo above; checking the
  // result rather than the argument is what removes the old `!` assertion.
  if (dependencyComputed !== undefined) return dependencyComputed;

  if (signalOnlyComputedRef.current === undefined) {
    signalOnlyComputedRef.current = computed(getValue);
  }

  return signalOnlyComputedRef.current;
}

/**
 * Runs a reactive effect after this component has committed, disposing it when
 * the component unmounts (and during React Strict Mode's development replay).
 *
 * When `dependencies` is omitted, the callback must only capture signals. Its
 * initial closure is retained for the component lifetime, so unrelated React
 * renders do not restart the effect.
 *
 * When the callback captures props, state, or any other non-signal value, list
 * all of those values in `dependencies`. The effect is then reconnected after
 * those dependencies change. Choose one mode for a component's lifetime.
 */
export function useSignalEffect(
  callback: () => void | (() => void),
  dependencies?: DependencyList,
): void {
  useReactEffect(() => effect(callback), dependencies ?? EMPTY_DEPENDENCIES);
}

/**
 * Reads a signal and subscribes the component to subsequent changes.
 *
 * The immediate run made by the public `effect` API establishes dependency
 * tracking only. It intentionally does not notify React: `useSyncExternalStore`
 * owns the initial consistency check after subscribing. See `createSignalStore`
 * for the shared subscribe/notify wiring, including why a read that throws
 * (a computed whose cached error `.value` rethrows) is swallowed in the
 * background effect and left for `getSnapshot` to rethrow instead.
 */
export function useSignalValue<T>(source: ReadonlySignal<T>): T {
  const subscribe = useMemo(
    () =>
      createSignalStore(() => {
        // The read (not its result) is what registers the alien-signals
        // dependency link, so it still happens even though the return value
        // here is constant: every non-initial run of this effect is reported
        // as a change, exactly as before.
        source.value;
        return true;
      }),
    [source],
  );

  // A leaf subscription owns this read. An unmanaged useSignals() scope may
  // still be open for an ancestor or earlier sibling until React commits, so
  // do not also register the source with that component's render collector.
  // `untracked` rather than `untrackedRender`: the latter clears only this
  // package's render collector, leaving alien-signals' own `activeSub` in
  // place, so a `getSnapshot` reached while some effect or computed is
  // evaluating would silently graft this source onto that subscriber's
  // dependency list. `computed()` and `peek()` already use `untracked` for
  // exactly this reason.
  const getSnapshot = useCallback(
    () => untracked(() => source.value),
    [source],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
