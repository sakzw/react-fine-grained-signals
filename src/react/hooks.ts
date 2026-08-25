import {
  useCallback,
  useEffect as useReactEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { computed, deepSignal, effect, signal } from "../core/index.js";
import type {
  DeepSignal,
  ReadonlySignal,
  Signal,
} from "../core/index.js";
import { untrackedRender } from "../core/render-tracking.js";
import type { DependencyList } from "react";
export { useSignals } from "./use-signals.js";

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
 * Holds a selector result outside the reactive graph. In particular, a
 * selector error must not escape from the signal write that caused a reactive
 * re-evaluation: React needs to observe it during its next render so an Error
 * Boundary can handle it.
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
  let dispose: (() => void) | undefined;
  let listener: (() => void) | undefined;

  const hasChanged = (next: SelectorResult<S>): boolean => {
    if (result.kind !== next.kind) return true;
    return result.kind === "value" && next.kind === "value"
      ? !Object.is(result.value, next.value)
      : result.kind === "error" && next.kind === "error"
        ? !Object.is(result.error, next.error)
        : false;
  };

  return {
    subscribe(notify: () => void): () => void {
      listener = notify;
      dispose = effect(() => {
        const next = evaluate();
        if (!hasChanged(next)) return;
        result = next;
        listener?.();
      });
      return () => {
        listener = undefined;
        dispose?.();
        dispose = undefined;
      };
    },
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
 */
export function useDeepSignalValue<
  T extends object,
  S extends SignalSnapshot,
>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies: DependencyList,
): S {
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
 * owns the initial consistency check after subscribing.
 */
export function useSignalValue<T>(source: ReadonlySignal<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => {
      let isInitialRun = true;

      return effect(() => {
        try {
          // The read (not this catch) is what registers the alien-signals
          // dependency link, so it still happens even when `source` is a
          // computed whose cached error `.value` rethrows. Swallowing it here
          // keeps this background effect alive and its throw from escaping
          // into whatever write triggered the re-run; `getSnapshot` performs
          // the same read again during React's render, where the rethrow
          // reaches an Error Boundary instead.
          source.value;
        } catch {
          // Handled by getSnapshot on the next render; see above.
        }
        if (isInitialRun) {
          isInitialRun = false;
        } else {
          notify();
        }
      });
    },
    [source],
  );

  // A leaf subscription owns this read. An unmanaged useSignals() scope may
  // still be open for an ancestor or earlier sibling until React commits, so
  // do not also register the source with that component's render collector.
  const getSnapshot = useCallback(
    () => untrackedRender(() => source.value),
    [source],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
