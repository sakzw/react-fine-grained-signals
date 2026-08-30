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
export const SIGNAL_BRAND: unique symbol = Symbol.for("react-fine-grained-signals.signal");
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
  // Liveness bookkeeping for `deepSignal`'s per-key metadata pruning; see
  // `markWatched`/`hasSubscribers` below. Not maintained on the read path
  // itself — `deepSignal`'s `track()` already knows whether a subscriber is
  // active and calls `markWatched()` there, so ordinary reads pay nothing.
  #watchedSinceWrite = false;

  constructor(initialValue: T) {
    this.#source = createSignal(initialValue);
    this.#currentValue = initialValue;
  }

  /**
   * Records that this signal was read while some subscriber (an alien-signals
   * effect/computed, or a React render collector) was active. Cleared by the
   * next write, so after that write's flush has drained, a still-false flag
   * means every reactive subscriber has re-run without re-reading this signal
   * and has therefore been unlinked from it.
   */
  markWatched(): void {
    this.#watchedSinceWrite = true;
  }

  /**
   * Conservative "somebody still depends on me" test used to decide whether a
   * `deepSignal` per-key version signal is safe to drop. Never reports `false`
   * for a signal that still has a live dependent: the React side is exact
   * (`hasListeners`), and the alien-signals side is covered by `markWatched`,
   * whose flag can only be `false` once a write has notified every subscriber
   * and none of them read this signal again.
   */
  hasSubscribers(): boolean {
    return this.#watchedSinceWrite || this.#renderSubscription.hasListeners();
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
    // Every subscriber is about to be notified, so each one either re-reads
    // this signal (setting the flag again through `markWatched`) or drops its
    // link to it. See `hasSubscribers`.
    this.#watchedSinceWrite = false;
    // The alien-signals write below flushes effects synchronously, so it can
    // still throw even though `effect()` now contains both its body and its
    // cleanup: anything else sharing this graph (an alien-signals effect
    // created directly, a computed's render bridge) is outside that guard.
    // `#currentValue` is already committed at that point, so skipping the
    // React-side notification would
    // leave every subscribed `RenderStore` believing the old value is still
    // current — a permanently stale UI that no later write can repair,
    // because a subsequent write compares against the already-updated
    // `#currentValue`. `finally` keeps React in sync no matter how the flush
    // exits, and still lets the original error propagate to the writer.
    try {
      if (requiresManualTrigger) {
        trigger(this.#source);
      } else {
        this.#source(nextValue);
      }
    } finally {
      this.#renderSubscription.notify();
    }
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

/**
 * Reports an error thrown by an `effect()` callback — its body or its cleanup —
 * without letting it escape into the flush that ran it.
 *
 * alien-signals' `flush()` drains the rest of its effect queue in a `finally`
 * *without running those effects*, so one throwing effect silently cancels
 * every effect still queued behind it in that cycle — an unrelated binding, or
 * a `useSignals()`-tracked component's commit, quietly missing an update — and
 * then propagates out of whatever write triggered the flush (an event handler,
 * anywhere). Catching here keeps the failure local to this one effect.
 *
 * The policy is *report, never re-raise*, matching the two other reporters in
 * this codebase (`readBoundSignal` in src/runtime/jsx.ts and `notifyListener`
 * in src/core/render-tracking.ts):
 *
 * 1. Always `console.error(message, { cause })` — the package-wide reporting
 *    shape; assert against `mock.calls[i][1].cause` in tests.
 * 2. Then hand the error to `reportError()` when the host defines it, so
 *    `window.onerror` / `addEventListener("error")` / a telemetry SDK still see
 *    the failure. `reportError` *dispatches an error event* rather than
 *    throwing, so it reports exactly like an uncaught error while remaining
 *    non-fatal by construction.
 *
 * Both hooks are host-controlled, so **everything in this function runs inside a
 * `try`/`catch`, property lookups included**. A host can legitimately make
 * `console.error` throw (some React test setups install a throwing one to make
 * warnings fatal) or expose `reportError` as a throwing getter; either would
 * otherwise re-raise out of the reporter itself and cancel the rest of the
 * flush — precisely the failure this function exists to prevent. The two steps
 * get separate guards rather than one shared one, so a broken `console.error`
 * still leaves the `reportError` channel to surface the error, and vice versa.
 *
 * What this deliberately no longer does is `queueMicrotask(() => { throw })`.
 * That reads like a browser-only "let it reach `window.onerror`" trick, but a
 * throw out of a microtask is not a recoverable event outside a browser: in
 * Node it raises `uncaughtException`, which by default **terminates the
 * process** (verified on Node 24.19: exit code 1). Every server-side consumer —
 * SSR data plumbing, a Node script, a test harness — got an unrecoverable crash
 * from an effect body that a plain `try`/`catch` would have handled, and
 * because the throw was deferred out of the write, nothing could catch it
 * anywhere. `reportError` is not a fallback for that on Node: it is the WHATWG
 * reporting API, implemented by browsers, Web Workers, Deno, and Bun, but not
 * defined by Node at any version this package supports (absent on Node 24 LTS,
 * still not listed in the Node 26 globals docs). The feature check below is
 * therefore the whole story — where it fails, step 1 is the report.
 *
 * The failure therefore never propagates to the write that triggered it, and
 * that containment covers *synchronous* throws from the body and the cleanup.
 * An `async` effect body that rejects is a different channel this cannot reach
 * (an unhandled rejection, still fatal by default on Node), so `await`ed work
 * needs its own `try`/`catch`. Either way, code that wants to handle its own
 * failure should do so at the real failure site — inside the effect body or
 * cleanup — which is always possible and is where the `try`/`catch` belongs.
 */
function reportEffectError(error: unknown): void {
  try {
    console.error(
      "react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.",
      { cause: error },
    );
  } catch {
    // A host that made `console.error` itself throw does not get to turn a
    // contained effect failure back into one that escapes and kills the flush.
  }
  try {
    // Looked up per call, not captured at module load, so a host (or a test)
    // that installs its own `reportError` later is still honored — and read
    // inside the guard, because the property itself can be a throwing getter.
    const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch {
    // Same rule for the second hook: a host whose `reportError` throws must not
    // break containment either. The error already went to the console above.
  }
}

/**
 * Wraps the cleanup an effect body returned so a throw out of it is contained
 * exactly like a throw out of the body.
 *
 * alien-signals stores the returned cleanup on the effect node and calls it
 * through its own private `runCleanup`, from two places this package cannot
 * intercept (verified against alien-signals@3.2.1):
 *
 * - `run()` calls it *before* re-running the body, i.e. inside `flush()`'s
 *   `try`, so a throw there hits the very same queue-cancelling failure mode
 *   `reportEffectError` exists for — worse, in fact, because it aborts the
 *   flush before this effect's own body has even re-run.
 * - `effectOper()` calls it on disposal — both the disposer returned below and
 *   the `unwatched` hook alien-signals fires when a nested effect loses its
 *   last subscriber, which happens during `unlink`/`purgeDeps` and so can also
 *   land in the middle of a flush.
 *
 * Neither call site is reachable from outside the module, so the guard goes on
 * the cleanup itself, on its way back to alien-signals: one wrapper covers
 * every path that can invoke it, now and later. The wrapper never rethrows, so
 * alien-signals always sees the cleanup return normally and its own
 * bookkeeping (`e.cleanup = undefined`, `activeSub` restore, the flags check
 * after `runCleanup`) stays on the success path.
 */
function guardCleanup(cleanup: () => void): () => void {
  return () => {
    try {
      cleanup();
    } catch (error) {
      reportEffectError(error);
    }
  };
}

/** Runs a reactive side effect and returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
  let disposed = false;
  let disposeEffect: (() => void) | undefined;
  disposeEffect = createEffect(() => {
    if (disposed) return;
    let cleanup: void | (() => void);
    try {
      cleanup = untrackedRender(fn);
    } catch (error) {
      reportEffectError(error);
      return;
    }
    if (cleanup === undefined) return;
    const guardedCleanup = guardCleanup(cleanup);
    if (disposed) {
      untracked(guardedCleanup);
      return;
    }
    return guardedCleanup;
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
