import { coreRuntime } from "./core-runtime.js";
import { multipleCopiesError } from "./execution-owner.js";
import { SIGNAL_BRAND } from "./signal-brand.js";

declare const readonlySignalBrand: unique symbol;
declare const signalWriteType: unique symbol;

/**
 * A readable reactive value.
 *
 * The brand is type-only (it does not exist at runtime) and makes the type
 * nominal: an object that merely has `value` and `peek()` is not a
 * `ReadonlySignal`, matching `isSignal`. `T` stays covariant, so a
 * `ReadonlySignal<"a">` is a `ReadonlySignal<string>`.
 */
export interface ReadonlySignal<T> {
  readonly value: T;
  peek(): T;
  readonly [readonlySignalBrand]: true;
}

/**
 * A readable and writable reactive value, and the signal type accepted by the
 * direct JSX bindings (`bindValue`, `bindChecked`).
 *
 * The type-only write marker makes `T` invariant: a binding that writes any
 * string rejects a `Signal<"a" | "b">`, which the user could otherwise fill
 * with other values.
 */
export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
  readonly [signalWriteType]: (value: T) => void;
}

/**
 * A writable signal whose value may be narrower than `T`. Option-based
 * bindings (radio, select, checkbox groups) only write the option values the
 * author rendered, so they accept a literal-union signal.
 * @internal Used by the JSX binding prop types.
 */
export type NarrowableSignal<T> = ReadonlySignal<T> & {
  value: T;
  readonly [signalWriteType]: (value: never) => void;
};

const signalInstances = new WeakSet<object>();

// A branded value this copy did not create comes from another copy of the
// package. See signal-brand.ts.

/** Marks an internal signal implementation for the public identity guard. */
export function registerSignal<T extends object>(value: T): T {
  signalInstances.add(value);
  // Non-enumerable keeps the brand out of JSON, `Object.keys`, spread, and
  // React's prop diffing; non-writable and non-configurable keep it from being
  // retargeted or stripped once the value is public. The hardening is free:
  // measured against a writable/configurable descriptor the cost is identical,
  // because it is the `defineProperty` call itself, and V8 keeps the instance
  // in fast properties either way (checked with `%HasFastProperties`). Stamping
  // the prototype instead would be worse — that pushes the prototype into
  // dictionary mode, which every lookup through it then pays for.
  Object.defineProperty(value, SIGNAL_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

/**
 * Returns whether a value came from this package's signal APIs, deep signals
 * included: a `DeepSignal` or `DeepCollectionSignal` is a
 * `ReadonlySignal<unknown>`, and narrowing a union keeps its own type. A signal
 * from another loaded copy of the package cannot be read here, so it throws.
 */
export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (signalInstances.has(value)) return true;
  const brand = (value as { [SIGNAL_BRAND]?: unknown })[SIGNAL_BRAND];
  if (brand !== true) return false;
  if (coreRuntime.getNodeForReadable(value as { value: unknown; peek(): unknown }) !== undefined) return true;
  // The brand is an own property of every signal this package creates, so one
  // that is not registered here was created by another loaded copy.
  if (Object.prototype.hasOwnProperty.call(value, SIGNAL_BRAND)) throw multipleCopiesError();
  return false;
}

/** Creates a writable reactive value. */
export function signal<T>(initialValue: T): Signal<T> {
  return coreRuntime.signal(initialValue) as unknown as Signal<T>;
}

/** Getter/setter behavior for a lazily evaluated writable computed signal. */
export interface WritableComputedOptions<T> {
  get: () => T;
  set: (value: T) => void;
}

/** Creates a lazily evaluated readonly computed signal. */
export function computed<T>(getter: () => T): ReadonlySignal<T>;
/** Creates a lazily evaluated writable computed signal. */
export function computed<T>(options: WritableComputedOptions<T>): Signal<T>;
export function computed<T>(source: (() => T) | WritableComputedOptions<T>): ReadonlySignal<T> | Signal<T> {
  if (typeof source === "function") return coreRuntime.computed(source) as unknown as ReadonlySignal<T>;
  return coreRuntime.computed(source.get, source.set) as unknown as Signal<T>;
}

/** Runs a reactive side effect and returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
  return coreRuntime.effect(fn);
}

/**
 * Package-internal: an effect that is never owned by the effect or computed
 * running when it is created. Hooks and JSX bindings create theirs from React
 * commits, which can run synchronously inside a user effect (`flushSync`), and
 * must not be disposed when that unrelated effect next re-runs.
 */
export function detachedEffect(fn: () => void | (() => void)): () => void {
  return coreRuntime.detachedEffect(fn);
}

/** Groups writes, deferring effect notifications until the callback completes. */
export function batch<T>(fn: () => T): T {
  return coreRuntime.batch(fn);
}

/** Runs a callback without collecting reactive dependencies. */
export function untracked<T>(fn: () => T): T {
  return coreRuntime.untracked(fn);
}
