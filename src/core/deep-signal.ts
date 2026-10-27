import { coreRuntime } from "./core-runtime.js";
import { executionContext, UNTRACKED_OWNER } from "./execution-owner.js";
import { createDeepSignalFactory } from "./deep-signal-engine.js";
import { batch, isSignal, registerSignal, untracked } from "./base.js";
import type { ReadonlySignal } from "./base.js";

declare const deepSignalBrand: unique symbol;
declare const plainDeepSignalKind: unique symbol;
declare const collectionDeepSignalKind: unique symbol;

type DeepReadonlyLeaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | RegExp
  | Error
  | Promise<unknown>
  | ((...args: never[]) => unknown);

/**
 * `T` as seen through a read-only, non-tracking snapshot: plain object
 * properties are `readonly` recursively, arrays are `ReadonlyArray`, `Map` and
 * `Set` are `ReadonlyMap` and `ReadonlySet`, and `WeakMap` and `WeakSet` lose
 * `set`, `add` and `delete`. Primitives, `Date`, `RegExp`, `Error`,
 * promises and functions are left as they are. TypeScript cannot tell a class
 * instance from a plain object, so a class instance is mapped like one.
 */
export type DeepReadonly<T> = unknown extends T
  ? T
  : T extends DeepReadonlyLeaf
    ? T
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<K, DeepReadonly<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : T extends WeakMap<infer K extends WeakKey, infer V>
          ? Omit<WeakMap<K, DeepReadonly<V>>, "set" | "delete">
          : T extends WeakSet<infer U extends WeakKey>
            ? Omit<WeakSet<U>, "add" | "delete">
            : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * A signal whose plain-object and array values are reactive. Map, Set, WeakMap
 * and WeakSet values inside are opaque, like a Date: the signal notifies only
 * when one is replaced, not when its contents change. Use
 * {@link DeepCollectionSignal} (from `deepCollectionSignal`) to track those.
 *
 * It is never a `Signal<T>`, so it cannot be bound for writing: `peek()` returns
 * the raw object without tracking, so writes through it would be lost, and its
 * type is `DeepReadonly<T>`. Change state through `.value`. It still counts as
 * a `ReadonlySignal` for reading (`For`, `Show`, `computed` inputs) when `T`
 * has no arrays or collections to make `DeepReadonly<T>` differ from `T`.
 */
export interface DeepSignal<T extends object> extends Omit<ReadonlySignal<T>, "value" | "peek"> {
  value: T;
  /** The raw state, read without tracking. Read-only: write through `.value`. */
  peek(): DeepReadonly<T>;
  /**
   * Type-only marker; never present at runtime. It lets positions that only
   * observe a signal's root value reject a deep signal at compile time,
   * because they would not re-render on nested mutations.
   */
  readonly [deepSignalBrand]: true;
  /** Type-only marker that tells this apart from a {@link DeepCollectionSignal}. */
  readonly [plainDeepSignalKind]: true;
}

/**
 * A signal whose plain-object, array, and standard collection (Map, Set,
 * WeakMap, WeakSet) values are reactive. Like {@link DeepSignal} it is not a
 * `Signal<T>`: `peek()` is a read-only snapshot, and state changes go
 * through `.value`.
 */
export interface DeepCollectionSignal<T extends object> extends Omit<ReadonlySignal<T>, "value" | "peek"> {
  value: T;
  /** The raw state, read without tracking. Read-only: write through `.value`. */
  peek(): DeepReadonly<T>;
  /** Type-only marker; see {@link DeepSignal}. */
  readonly [deepSignalBrand]: true;
  /** Type-only marker that tells this apart from a {@link DeepSignal}. */
  readonly [collectionDeepSignalKind]: true;
}

/**
 * `T` when it is a plain object or an array, and `never` for a Map, Set,
 * WeakMap or WeakSet, which `deepSignal` does not accept as a root. Use
 * `deepCollectionSignal` for those.
 */
export type PlainRoot<T> = T &
  (unknown extends T
    ? unknown
    : [
          Extract<
            T,
            ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<WeakKey, unknown> | WeakSet<WeakKey>
          >,
        ] extends [never]
      ? unknown
      : never);

/**
 * Package-internal: intersected with `ReadonlySignal<T>` where only root
 * replacement is observed (`useSignalValue`, JSX children and host props), so
 * passing a `DeepSignal` there is a type error instead of a silently stale UI.
 */
export type NotDeepSignal = { readonly [deepSignalBrand]?: never };

let productionDeepSignals: ReturnType<typeof createDeepSignalFactory> | undefined;

/** Package-internal: the shared engine behind `deepSignal` and `deepCollectionSignal`. */
export function getProductionDeepSignals(): NonNullable<typeof productionDeepSignals> {
  return (productionDeepSignals ??= createDeepSignalFactory({
    createSignal<T>(initial: T) {
      return coreRuntime.createDeepSignal(initial);
    },
    createVersionSignal<T>(initial: T) {
      return coreRuntime.createDeepSignalVersion(initial);
    },
    onUnwatched(source, callback) {
      coreRuntime.onDeepSignalUnwatched(source, callback);
    },
    markWatched(source) {
      coreRuntime.markDeepSignalWatched(source);
    },
    hasSubscribers(source) {
      return coreRuntime.hasDeepSignalSubscribers(source);
    },
    hasLinkedSubscribers(source) {
      return coreRuntime.hasSubscribers(source);
    },
    batch,
    untracked,
    isSignal,
    hasActiveSubscriber: () => {
      const owner = executionContext.owner;
      // Another copy's `untracked()` only clears that copy's subscriber; the
      // shared owner is what says this read must not be tracked by anyone.
      if (owner === UNTRACKED_OWNER) return false;
      return (
        coreRuntime.hasActiveSubscriber() ||
        (owner !== undefined && typeof owner !== "symbol" && (owner.kind === "graph" || owner.kind === "render"))
      );
    },
    getBatchDepth: () => coreRuntime.getBatchDepth(),
    isSpeculative: () => coreRuntime.isSpeculative(),
    markSpeculativeDeepRead: () => coreRuntime.markSpeculativeDeepRead(),
    registerDeepSignal(value) {
      registerSignal(value as DeepSignal<object>);
    },
  }));
}

/**
 * Reports the per-key reactive metadata currently retained for a deep proxy
 * (or for the raw object behind it). This package-internal helper is not part
 * of any published entry point.
 */
export function inspectDeepSignalMetadata(
  value: object,
): ReturnType<ReturnType<typeof createDeepSignalFactory>["inspectDeepSignalMetadata"]> {
  return getProductionDeepSignals().inspectDeepSignalMetadata(value);
}

/** Package-internal: primitive collection keys that still retain version metadata. */
export function inspectCollectionMetadata(
  value: object,
): ReturnType<ReturnType<typeof createDeepSignalFactory>["inspectCollectionMetadata"]> {
  return getProductionDeepSignals().inspectCollectionMetadata(value);
}

/**
 * Creates a signal that lazily tracks nested plain-object and array reads.
 * Map, Set, WeakMap and WeakSet values inside are opaque, like a Date: the
 * signal notifies only when one is replaced. The root must be a plain object
 * or an array; pass a collection to `deepCollectionSignal` instead.
 * Mutations must go through `.value`; changes made through the original raw
 * value or `.peek()` are intentionally not observable.
 */
export function deepSignal<T extends object>(initialValue: PlainRoot<T>): DeepSignal<T> {
  return getProductionDeepSignals().deepSignal(initialValue) as unknown as DeepSignal<T>;
}
