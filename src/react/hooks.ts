import {
  useCallback,
  useEffect as useReactEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { computed, deepSignal, effect, signal } from "../core/index.js";
import type { DeepSignal, ReadonlySignal, Signal } from "../core/index.js";
import type { DependencyList } from "react";

const EMPTY_DEPENDENCIES: DependencyList = [];

/** An immutable value that React can safely compare as an external-store snapshot. */
export type SignalSnapshot =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

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
 */
export function useDeepSignalValue<
  T extends object,
  S extends SignalSnapshot,
>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies: DependencyList,
): S {
  const selected = useComputed(
    () => selector(source.value),
    [source, ...dependencies],
  );
  return useSignalValue(selected);
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

  const signalOnlyComputedRef = useRef<ReadonlySignal<T> | undefined>(undefined);
  if (dependencies !== undefined) {
    return dependencyComputed!;
  }

  if (signalOnlyComputedRef.current === undefined) {
    signalOnlyComputedRef.current = computed(getValue);
  }

  return signalOnlyComputedRef.current;
}

/**
 * Runs a reactive effect after this component has committed, disposing it when
 * the component unmounts (and during React Strict Mode's development replay).
 */
export function useSignalEffect(
  callback: () => void | (() => void),
): void {
  useReactEffect(() => effect(callback), [callback]);
}

/**
 * Reads a signal and subscribes the component to subsequent changes.
 *
 * The immediate run made by the public `effect` API establishes dependency
 * tracking only. It intentionally does not notify React: `useSyncExternalStore`
 * owns the initial consistency check after subscribing.
 */
export function useSignalValue<T>(source: ReadonlySignal<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => {
      let isInitialRun = true;

      return effect(() => {
        source.value;
        if (isInitialRun) {
          isInitialRun = false;
        } else {
          notify();
        }
      });
    },
    [source],
  );

  const getSnapshot = useCallback(() => source.value, [source]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
