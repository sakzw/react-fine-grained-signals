import { coreRuntime } from "./core-runtime.js";
import { createDeepSignalFactory } from "./deep-signal-engine.js";
import {
  batch,
  isSignal,
  registerSignal,
  SignalImpl,
} from "./base.js";
import type { Signal } from "./base.js";

/** A signal whose plain-object and array values are reactive by property. */
export interface DeepSignal<T extends object> extends Signal<T> {}

let productionDeepSignals: ReturnType<typeof createDeepSignalFactory> | undefined;

function getProductionDeepSignals(): NonNullable<typeof productionDeepSignals> {
  return productionDeepSignals ??= createDeepSignalFactory({
    createSignal<T>(initial: T) {
      return registerSignal(new SignalImpl(initial));
    },
    batch,
    isSignal,
    hasActiveSubscriber: () => coreRuntime.hasActiveSubscriber(),
    getBatchDepth: () => coreRuntime.getBatchDepth(),
    registerDeepSignal(value) {
      registerSignal(value as DeepSignal<object>);
    },
  });
}

/**
 * Reports the per-key reactive metadata currently retained for a deep proxy
 * (or for the raw object behind it). This package-internal helper is not part
 * of any published entry point.
 */
export function inspectDeepSignalMetadata(value: object): ReturnType<
  ReturnType<typeof createDeepSignalFactory>["inspectDeepSignalMetadata"]
> {
  return getProductionDeepSignals().inspectDeepSignalMetadata(value);
}

/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
export function deepSignal<T extends object>(
  initialValue: T,
): DeepSignal<T> {
  return getProductionDeepSignals().deepSignal(initialValue) as DeepSignal<T>;
}
