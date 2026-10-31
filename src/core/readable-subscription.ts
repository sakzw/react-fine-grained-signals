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
 * dependency. The listener runs on changes after the initial read; reads that
 * throw stay subscribed. Callers accept only values `isSignal` recognizes, so
 * any other readable is an internal error and throws.
 */
export function subscribeLocalReadable(readable: object, listener: () => void): () => void {
  const target = delegates.get(readable) ?? readable;
  if (coreRuntime.getNodeForReadable(target as { value: unknown; peek(): unknown }) === undefined) {
    throw new TypeError("Only signals created by react-fine-grained-signals can be subscribed to");
  }
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
