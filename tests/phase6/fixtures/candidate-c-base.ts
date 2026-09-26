import { coreRuntime } from "./candidate-c-core-runtime.js";
import { SIGNAL_BRAND } from "../../../src/core/signal-brand.js";

export interface ReadonlySignal<T> { readonly value: T; peek(): T }
export interface Signal<T> extends ReadonlySignal<T> { value: T }
export type DeepSignal<T extends object> = Signal<T>;

const localSignals = new WeakSet<object>();
export function registerSignal<T extends object>(value: T): T {
  localSignals.add(value);
  Object.defineProperty(value, SIGNAL_BRAND, { value: 1, enumerable: false, writable: false, configurable: false });
  return value;
}
export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (localSignals.has(value)) return true;
  const record = value as { [SIGNAL_BRAND]?: unknown; peek?: unknown };
  return typeof record[SIGNAL_BRAND] === "number" && typeof record.peek === "function";
}
export function signal<T>(initial: T): Signal<T> { return registerSignal(coreRuntime.signal(initial)); }
export function computed<T>(getter: () => T): ReadonlySignal<T> { return registerSignal(coreRuntime.computed(getter)); }
export const effect = coreRuntime.effect;
export const batch = coreRuntime.batch;
export const untracked = coreRuntime.untracked;
export { coreRuntime };
