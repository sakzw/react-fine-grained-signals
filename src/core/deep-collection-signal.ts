import { createCollectionSupport } from "./deep-collections.js";
import { getProductionDeepSignals } from "./deep-signal.js";
import type { DeepCollectionSignal } from "./deep-signal.js";

/**
 * Creates a signal that lazily tracks nested plain-object, array, and standard
 * collection (Map, Set, WeakMap, WeakSet) reads, including a collection as the
 * root. Mutations must go through `.value`; changes made through the original
 * raw value or `.peek()` are intentionally not observable.
 *
 * This is the only entry that loads the collection support, so an app that
 * uses `deepSignal` alone does not pay for it.
 */
export function deepCollectionSignal<T extends object>(initialValue: T): DeepCollectionSignal<T> {
  return getProductionDeepSignals().deepCollectionSignal(
    initialValue,
    createCollectionSupport,
  ) as unknown as DeepCollectionSignal<T>;
}
