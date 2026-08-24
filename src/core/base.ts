import {
  computed as createComputed,
  effect as createEffect,
  endBatch,
  getActiveSub,
  setActiveSub,
  signal as createSignal,
  startBatch,
  trigger,
} from "alien-signals";
import {
  hasActiveRenderCollector,
  RenderSubscription,
  untrackedRender,
} from "./render-tracking.js";

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

/**
 * Cross-instance signal brand. `Symbol.for` resolves through the registry that
 * is shared by every realm, so a signal made by a duplicate copy of this
 * package (pnpm hoisting, a monorepo consumer, an ESM/CJS split) or in another
 * realm (iframe, worker) still answers `isSignal`. Shared with the deep-signal
 * proxy only; the package's public API stays `isSignal`.
 */
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-alien-signals.signal");
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

/** Internal writable signal implementation shared with deep signals. */
export class SignalImpl<T> implements Signal<T> {
  readonly #source: ReturnType<typeof createSignal<T>>;
  readonly #renderSubscription = new RenderSubscription();
  #currentValue: T;

  constructor(initialValue: T) {
    this.#source = createSignal(initialValue);
    this.#currentValue = initialValue;
  }

  get value(): T {
    if (this.#renderSubscription.track()) return this.#currentValue;
    // The call records the dependency; `#currentValue` preserves Object.is
    // semantics where the underlying callable API treats 0 and -0 alike.
    this.#source();
    return this.#currentValue;
  }

  set value(nextValue: T) {
    if (Object.is(this.#currentValue, nextValue)) return;
    const requiresManualTrigger = this.#currentValue === nextValue;
    this.#currentValue = nextValue;
    if (requiresManualTrigger) {
      trigger(this.#source);
    } else {
      this.#source(nextValue);
    }
    this.#renderSubscription.notify();
  }

  peek(): T {
    return this.#currentValue;
  }
}

/** Creates a writable reactive value. */
export function signal<T>(initialValue: T): Signal<T> {
  return registerSignal(new SignalImpl(initialValue));
}

/** A computed's cached result, boxed so a thrown error can be cached too. */
type ComputedBox<T> = { value: T } | { error: unknown };

/** Unwraps a computed's box, rethrowing a cached getter error on read. */
function unbox<T>(box: ComputedBox<T>): T {
  if ("error" in box) throw box.error;
  return box.value;
}

/** Creates a lazily evaluated reactive value. */
export function computed<T>(getter: () => T): ReadonlySignal<T> {
  // alien-signals' `updateComputed` resets its dirty/pending flags in a
  // `finally` no matter how the callback exits, so a thrown getter leaves the
  // node looking clean with its stale cached value, and can permanently
  // unwatch an effect whose run was interrupted mid-flush (verified against
  // alien-signals@3.2.1: neither the computed nor the effect ever recovers on
  // a later write). Catching here keeps the callback always returning
  // normally, so alien-signals' own bookkeeping stays on the success path;
  // the error is boxed and only rethrown when something reads `.value` or
  // `.peek()`, which for React happens during render where an Error Boundary
  // can catch it (mirrors `createDeepSelectorStore` in `src/react/hooks.ts`).
  const source = createComputed<ComputedBox<T>>((previous) => {
    try {
      const value = getter();
      // Guard `"value" in previous`: if `previous` is an error box, its
      // `.value` is `undefined`, so without this a legitimate recovery to
      // `value === undefined` would `Object.is` that against `undefined` and
      // wrongly keep returning the stale error box.
      return previous !== undefined && "value" in previous && Object.is(previous.value, value)
        ? previous
        : { value };
    } catch (error) {
      return { error };
    }
  });
  let disposeRenderBridge: (() => void) | undefined;
  let isInitialBridgeRun = true;
  let lastRenderValue: ComputedBox<T> | undefined;
  const renderSubscription = new RenderSubscription(
    () => {
      isInitialBridgeRun = true;
      disposeRenderBridge = createEffect(() => {
        const nextValue = untrackedRender(source);
        const changedSinceRender =
          lastRenderValue !== undefined && nextValue !== lastRenderValue;
        lastRenderValue = nextValue;
        if (isInitialBridgeRun) {
          isInitialBridgeRun = false;
          if (changedSinceRender) renderSubscription.bumpVersion();
        } else if (changedSinceRender) {
          renderSubscription.notify();
        }
      });
    },
    () => {
      disposeRenderBridge?.();
      disposeRenderBridge = undefined;
    },
  );

  const result: ReadonlySignal<T> = {
    get value(): T {
      if (hasActiveRenderCollector()) {
        const nextValue = untracked(() => untrackedRender(source));
        if (lastRenderValue !== undefined && nextValue !== lastRenderValue) {
          renderSubscription.bumpVersion();
        }
        lastRenderValue = nextValue;
        // Track after evaluating so this render records the post-evaluation
        // version without masking an older concurrent render.
        renderSubscription.track();
        return unbox(nextValue);
      }
      return unbox(source());
    },
    // `peek()` is documented as an untracked read, not an error-suppressing
    // one, so it rethrows the same as `.value` — consistent with
    // `useDeepSignalValue`, whose selector errors always surface on read.
    peek(): T {
      return unbox(untracked(() => source()));
    },
  };
  return registerSignal(result);
}

/** Runs a reactive side effect and returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
  let disposed = false;
  let disposeEffect: (() => void) | undefined;
  disposeEffect = createEffect(() => {
    if (disposed) return;
    const cleanup = untrackedRender(fn);
    if (disposed && cleanup !== undefined) {
      untracked(cleanup);
      return;
    }
    return cleanup;
  });
  return () => {
    if (disposed) return;
    disposed = true;
    disposeEffect?.();
  };
}

/** Groups writes, deferring effect notifications until the callback completes. */
export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

/** Runs a callback without collecting reactive dependencies. */
export function untracked<T>(fn: () => T): T {
  return untrackedRender(() => {
    const activeSub = getActiveSub();
    setActiveSub();
    try {
      return fn();
    } finally {
      setActiveSub(activeSub);
    }
  });
}
