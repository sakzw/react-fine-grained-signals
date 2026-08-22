import {
  Children,
  Fragment,
  isValidElement,
  type Key,
  type ReactElement,
  type ReactNode,
} from "react";
import { isSignal, type ReadonlySignal } from "./core/index.js";
import { useSignals } from "./react/use-signals.js";

/** A plain value or a value created by `signal`, `computed`, or `deepSignal`. */
export type SignalInput<T> = T | ReadonlySignal<T>;

/** Renders its children only while `when` is truthy. */
export interface ShowProps<T> {
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
export function Show<T>({ when, fallback = null, children }: ShowProps<T>): ReactNode {
  useSignals();
  const value = readSignalInput(when);

  if (!value) return fallback;
  return typeof children === "function"
    ? children(value as NonNullable<T>)
    : children;
}

/** A branch declaration consumed by the nearest `Switch`. */
export interface MatchProps<T> {
  when: SignalInput<T>;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}

/**
 * Declares a `Switch` branch. `Match` only has meaning as a child of `Switch`.
 */
export function Match<T>(_props: MatchProps<T>): null {
  return null;
}

/** Chooses and renders the first truthy child `Match`. */
export interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}

/**
 * A small reactive multi-branch boundary inspired by Solid's `Switch`/`Match`.
 */
export function Switch({ fallback = null, children }: SwitchProps): ReactNode {
  useSignals();

  for (const match of collectMatches(children)) {
    const value = readSignalInput(match.props.when);
    if (!value) continue;

    const branch = match.props.children;
    return typeof branch === "function"
      ? branch(value as NonNullable<unknown>)
      : branch;
  }

  return fallback;
}

/** A collection supported by `For` when each item has its own identity. */
export type ForCollection<T> = readonly T[] | ReadonlySet<T>;

/** Renders an array or set whose items have stable identities. */
export interface ForProps<T> {
  each: SignalInput<ForCollection<T> | null | undefined>;
  fallback?: ReactNode;
  /** Returns the stable React key for an item. It must be pure and data-derived. */
  by: (item: T, index: number) => Key;
  children: (item: T, index: number) => ReactNode;
}

/** Renders a map whose entries have stable identities. */
export interface ForMapProps<K, V> {
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
export function For<T>(props: ForProps<T>): ReactNode;
export function For<K, V>(props: ForMapProps<K, V>): ReactNode;
export function For(
  { each, fallback = null, by, children }: ForProps<unknown> | ForMapProps<unknown, unknown>,
): ReactNode {
  useSignals();
  const collection = readSignalInput(each);

  if (collection === null || collection === undefined) {
    return fallback;
  }

  const items = Array.isArray(collection) ? collection : Array.from(collection);
  if (items.length === 0) return fallback;

  return items.map((item, index) => (
    <Fragment key={by(item, index)}>{children(item, index)}</Fragment>
  ));
}

/** Renders an array whose row identity is intentionally its position. */
export interface IndexProps<T> {
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
export function Index<T>({ each, fallback = null, children }: IndexProps<T>): ReactNode {
  useSignals();
  const items = readSignalInput(each);

  if (items === null || items === undefined || items.length === 0) {
    return fallback;
  }

  return items.map((_item, index) => (
    <Fragment key={index}>{children(() => items[index]!, index)}</Fragment>
  ));
}

function readSignalInput<T>(value: SignalInput<T>): T {
  return isSignal(value) ? (value.value as T) : value;
}

function collectMatches(children: ReactNode): Array<ReactElement<MatchProps<unknown>>> {
  const matches: Array<ReactElement<MatchProps<unknown>>> = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      const fragment = child as ReactElement<{ children?: ReactNode }>;
      matches.push(...collectMatches(fragment.props.children));
    } else if (child.type === Match) {
      matches.push(child as ReactElement<MatchProps<unknown>>);
    }
  });

  return matches;
}
