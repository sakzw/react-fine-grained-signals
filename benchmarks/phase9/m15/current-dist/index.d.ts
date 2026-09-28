import { a as effect, c as untracked, i as computed, n as Signal, o as isSignal, r as batch, s as signal, t as ReadonlySignal } from "./base-Bx5ahfW2.js";
import { r as useSignalTracking } from "./use-signals-DNCElFpN.js";
import { DependencyList } from "react";
//#region src/core/deep-signal.d.ts
/** A signal whose plain-object and array values are reactive by property. */
interface DeepSignal<T extends object> extends Signal<T> {}
/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
declare function deepSignal<T extends object>(initialValue: T): DeepSignal<T>;
//#endregion
//#region src/react/hooks.d.ts
/** An immutable value that React can safely compare as an external-store snapshot. */
type SignalSnapshot = string | number | boolean | bigint | symbol | null | undefined;
/** Creates a signal whose identity is stable for the lifetime of this component. */
declare function useSignal<T>(initialValue: T): Signal<T>;
/**
 * Creates a deep signal whose identity is stable for the component lifetime.
 * A factory is evaluated only while initializing a mounted component instance;
 * it must remain pure because React Strict Mode may replay initial rendering.
 */
declare function useDeepSignal<T extends object>(initialValue: T | (() => T)): DeepSignal<T>;
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
declare function useDeepSignalValue<T extends object, S extends SignalSnapshot>(source: DeepSignal<T>, selector: (value: T) => S, dependencies: DependencyList): S;
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
declare function useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>;
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
declare function useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void;
/**
 * Reads a signal and subscribes the component to subsequent changes through
 * ReadableInterop V1 when available.
 *
 * `useSyncExternalStore` owns the initial consistency check after subscribing.
 * For V1 readables, its watcher tracks revisions without an EffectNode. A
 * read that throws (a computed whose cached error `.value` rethrows) remains
 * for the render-time `getSnapshot` to surface to an Error Boundary; only the
 * structural-readable fallback needs an effect to contain background errors.
 */
declare function useSignalValue<T>(source: ReadonlySignal<T>): T;
//#endregion
export { type DeepSignal, type ReadonlySignal, type Signal, type SignalSnapshot, batch, computed, deepSignal, effect, isSignal, signal, untracked, useComputed, useDeepSignal, useDeepSignalValue, useSignal, useSignalEffect, useSignalTracking, useSignalValue };
