import { createDeepSignalFactory } from "./candidate-deep-signal-engine.js";
import { coreRuntime } from "./candidate-c1-core-runtime.js";
import { SIGNAL_BRAND } from "../../../src/core/signal-brand.js";

const localSignals = new WeakSet<object>();
function registerSignal<T extends object>(value: T): T {
  localSignals.add(value);
  Object.defineProperty(value, SIGNAL_BRAND, { value: 1, enumerable: false, writable: false, configurable: false });
  return value;
}
function isSignal(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  if (localSignals.has(value)) return true;
  const record = value as { [SIGNAL_BRAND]?: unknown; peek?: unknown };
  return typeof record[SIGNAL_BRAND] === "number" && typeof record.peek === "function";
}

let deep: ReturnType<typeof createDeepSignalFactory> | undefined;
function getDeep() {
  return deep ??= createDeepSignalFactory({
    createSignal<T>(initial: T) { return registerSignal(coreRuntime.createDeepSignal(initial)); },
    markWatched(source) { coreRuntime.markDeepSignalWatched(source); },
    hasSubscribers(source) { return coreRuntime.hasDeepSignalSubscribers(source); },
    batch: coreRuntime.batch,
    isSignal,
    hasActiveSubscriber: coreRuntime.hasActiveSubscriber,
    getBatchDepth: coreRuntime.getBatchDepth,
    registerDeepSignal(value) { registerSignal(value as object); },
  });
}

export function deepSignal<T extends object>(initial: T) { return getDeep().deepSignal(initial); }
export function inspectDeepSignalMetadata(value: object) { return getDeep().inspectDeepSignalMetadata(value); }
