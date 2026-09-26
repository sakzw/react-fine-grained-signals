import { coreRuntime } from "./core-runtime.js";
import { SIGNAL_BRAND } from "./signal-brand.js";

/** A readable reactive value. */
export interface ReadonlySignal<T> {
  readonly value: T;
  peek(): T;
}

/** A readable and writable reactive value. */
export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
}

const signalInstances = new WeakSet<object>();

// The brand carries a protocol version instead of `true` so a future instance
// can tell which contract a foreign signal claims. A version only ever widens
// the `{ value, peek() }` contract; a breaking change must take a new symbol
// key, which is why anything from the minimum upwards is trusted here.
const SIGNAL_BRAND_VERSION = 1;
const SIGNAL_BRAND_MIN_VERSION = 1;

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
    value: SIGNAL_BRAND_VERSION,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

/** Returns whether a value came from this package's signal APIs, any copy. */
export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  if (typeof value !== "object" || value === null) return false;
  // The WeakSet is both the cheaper lookup and the authority for values created
  // by this instance; the brand is the fallback for every other instance.
  if (signalInstances.has(value)) return true;
  const brand = (value as { [SIGNAL_BRAND]?: unknown })[SIGNAL_BRAND];
  if (typeof brand !== "number" || brand < SIGNAL_BRAND_MIN_VERSION) return false;
  // A foreign brand is a claim, not a proof. Checking the cheap half of the
  // contract turns a malformed brand into `false` instead of a crash inside a
  // render, and costs nothing on the local-instance path above.
  return typeof (value as ReadonlySignal<unknown>).peek === "function";
}

/** Creates a writable reactive value. */
export function signal<T>(initialValue: T): Signal<T> {
  return registerSignal(coreRuntime.signal(initialValue));
}

/** Creates a lazily evaluated reactive value. */
export function computed<T>(getter: () => T): ReadonlySignal<T> {
  return registerSignal(coreRuntime.computed(getter));
}

/** Runs a reactive side effect and returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
  return coreRuntime.effect(fn);
}

/** Groups writes, deferring effect notifications until the callback completes. */
export function batch<T>(fn: () => T): T {
  return coreRuntime.batch(fn);
}

/** Runs a callback without collecting reactive dependencies. */
export function untracked<T>(fn: () => T): T {
  return coreRuntime.untracked(fn);
}
