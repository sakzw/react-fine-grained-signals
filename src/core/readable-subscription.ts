import { coreRuntime } from "./core-runtime.js";
import { notifyListener } from "./render-tracking.js";

// A wrapper whose reads are delegated to another readable (a deep signal root
// over its internal source) is subscribed through that readable.
const delegates = new WeakMap<object, object>();

/** Subscribe this wrapper through `target`'s graph node. */
export function delegateSubscription(wrapper: object, target: object): void {
  delegates.set(wrapper, target);
}

/**
 * Subscribe to a signal or computed created by this package without a render
 * dependency, or return `undefined` for any other readable. The listener runs
 * on changes after the initial read; reads that throw stay subscribed.
 */
export function subscribeLocalReadable(readable: object, listener: () => void): (() => void) | undefined {
  const target = delegates.get(readable) ?? readable;
  if (coreRuntime.getNodeForReadable(target as { value: unknown; peek(): unknown }) === undefined) return undefined;
  let initial = true;
  return coreRuntime.detachedEffect(() => {
    try {
      (target as { value: unknown }).value;
    } catch {
      /* Keep errored computed boundaries observed. */
    }
    if (initial) initial = false;
    else notifyListener(listener);
  });
}
