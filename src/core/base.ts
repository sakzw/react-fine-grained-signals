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

/** Marks an internal signal implementation for the public identity guard. */
export function registerSignal<T extends object>(value: T): T {
  signalInstances.add(value);
  return value;
}

/** Returns whether a value was created by this module's signal APIs. */
export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  return typeof value === "object" && value !== null && signalInstances.has(value);
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

/** Creates a lazily evaluated reactive value. */
export function computed<T>(getter: () => T): ReadonlySignal<T> {
  const source = createComputed<{ value: T }>((previous) => {
    const value = getter();
    return previous !== undefined && Object.is(previous.value, value)
      ? previous
      : { value };
  });
  let disposeRenderBridge: (() => void) | undefined;
  let isInitialBridgeRun = true;
  let lastRenderValue: { value: T } | undefined;
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
        return nextValue.value;
      }
      return source().value;
    },
    peek(): T {
      return untracked(() => source().value);
    },
  };
  return registerSignal(result);
}

/** Runs a reactive side effect and returns a disposer. */
export function effect(fn: () => void | (() => void)): () => void {
  return createEffect(() => untrackedRender(fn));
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
