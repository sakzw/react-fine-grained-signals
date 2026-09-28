import { t as ReadonlySignal } from "./base-Bx5ahfW2.js";
import { Key, ReactNode } from "react";
//#region src/utils.d.ts
/** A plain value or a value created by `signal`, `computed`, or `deepSignal`. */
type SignalInput<T> = T | ReadonlySignal<T>;
/** Renders its children only while `when` is truthy. */
interface ShowProps<T> {
  when: SignalInput<T>;
  fallback?: ReactNode;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
/**
 * A small reactive conditional-rendering boundary.
 *
 * Unlike Solid's compiler-aware control flow, this is a normal React component:
 * only this component rerenders when a signal read from `when` changes.
 */
declare function Show<T>({ when, fallback, children }: ShowProps<T>): ReactNode;
/** A branch declaration consumed by the nearest `Switch`. */
interface MatchProps<T> {
  when: SignalInput<T>;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
/**
 * Declares a `Switch` branch. `Match` only has meaning as a child of `Switch`.
 */
declare function Match<T>(_props: MatchProps<T>): null;
/** Chooses and renders the first truthy child `Match`. */
interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}
/**
 * A small reactive multi-branch boundary inspired by Solid's `Switch`/`Match`.
 */
declare function Switch({ fallback, children }: SwitchProps): ReactNode;
/** A collection supported by `For` when each item has its own identity. */
type ForCollection<T> = readonly T[] | ReadonlySet<T>;
/** Renders an array or set whose items have stable identities. */
interface ForProps<T> {
  each: SignalInput<ForCollection<T> | null | undefined>;
  fallback?: ReactNode;
  /** Returns the stable React key for an item. It must be pure and data-derived. */
  by: (item: T, index: number) => Key;
  children: (item: T, index: number) => ReactNode;
}
/** Renders a map whose entries have stable identities. */
interface ForMapProps<K, V> {
  each: SignalInput<ReadonlyMap<K, V> | null | undefined>;
  fallback?: ReactNode;
  /** Returns the stable React key for an entry. It must be pure and data-derived. */
  by: (entry: readonly [K, V], index: number) => Key;
  children: (entry: readonly [K, V], index: number) => ReactNode;
}
/**
 * A React list boundary inspired by Solid's `For`.
 *
 * React still owns reconciliation. `by` supplies stable keys, so use `Index`
 * instead when a list's identity is intentionally positional.
 */
declare function For<T>(props: ForProps<T>): ReactNode;
declare function For<K, V>(props: ForMapProps<K, V>): ReactNode;
/** Renders an array whose row identity is intentionally its position. */
interface IndexProps<T> {
  each: SignalInput<readonly T[] | null | undefined>;
  fallback?: ReactNode;
  /** Receives a render-time accessor for the current value at this position. */
  children: (item: () => T, index: number) => ReactNode;
}
/**
 * A position-keyed React list boundary inspired by Solid's `Index`.
 *
 * The accessor should be read during render. For identity-keyed lists, use
 * `For` instead and provide `by`.
 */
declare function Index<T>({ each, fallback, children }: IndexProps<T>): ReactNode;
//#endregion
export { For, ForCollection, ForMapProps, ForProps, Index, IndexProps, Match, MatchProps, Show, ShowProps, SignalInput, Switch, SwitchProps };
