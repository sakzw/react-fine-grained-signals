import { coreRuntime } from "./core-runtime.js";
import { executionContext, UNTRACKED_OWNER } from "./execution-owner.js";
import { createDeepSignalFactory } from "./deep-signal-engine.js";
import {
  batch,
  isSignal,
  registerSignal,
  untracked,
} from "./base.js";
import type { Signal } from "./base.js";

declare const deepSignalBrand: unique symbol;

/** A signal whose plain-object and array values are reactive by property. */
export interface DeepSignal<T extends object> extends Signal<T> {
  /**
   * Type-only marker; never present at runtime. It lets positions that only
   * observe a signal's root value reject a deep signal at compile time,
   * because they would not re-render on nested mutations.
   */
  readonly [deepSignalBrand]: true;
}

/**
 * Package-internal: intersected with `ReadonlySignal<T>` where only root
 * replacement is observed (`useSignalValue`, JSX children and host props), so
 * passing a `DeepSignal` there is a type error instead of a silently stale UI.
 */
export type NotDeepSignal = { readonly [deepSignalBrand]?: never };

let productionDeepSignals: ReturnType<typeof createDeepSignalFactory> | undefined;

function getProductionDeepSignals(): NonNullable<typeof productionDeepSignals> {
  return productionDeepSignals ??= createDeepSignalFactory({
    createSignal<T>(initial: T) {
      return coreRuntime.createDeepSignal(initial);
    },
    createVersionSignal<T>(initial: T) {
      return coreRuntime.createDeepSignalVersion(initial);
    },
    markWatched(source) { coreRuntime.markDeepSignalWatched(source); },
    hasSubscribers(source) { return coreRuntime.hasDeepSignalSubscribers(source); },
    batch,
    untracked,
    isSignal,
    hasActiveSubscriber: () => {
      const owner = executionContext.owner;
      // Another copy's `untracked()` only clears that copy's subscriber; the
      // shared owner is what says this read must not be tracked by anyone.
      if (owner === UNTRACKED_OWNER) return false;
      return coreRuntime.hasActiveSubscriber() ||
        (owner !== undefined && typeof owner !== "symbol" &&
          (owner.kind === "graph" || owner.kind === "render"));
    },
    getBatchDepth: () => coreRuntime.getBatchDepth(),
    isSpeculative: () => coreRuntime.isSpeculative(),
    markSpeculativeDeepRead: () => coreRuntime.markSpeculativeDeepRead(),
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
