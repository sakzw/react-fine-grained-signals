/** Internal dependency contract used by the React render collector. */
export interface RenderDependency {
  getRenderVersion(): number;
  subscribeRender(listener: () => void): () => void;
}

export interface RenderCollector {
  add(dependency: RenderDependency): void;
}

let activeRenderCollector: RenderCollector | undefined;

/** Returns whether a React render is currently collecting signal reads. */
export function hasActiveRenderCollector(): boolean {
  return activeRenderCollector !== undefined;
}

/** Replaces the current render collector and returns the previous collector. */
export function setActiveRenderCollector(
  collector?: RenderCollector,
): RenderCollector | undefined {
  const previous = activeRenderCollector;
  activeRenderCollector = collector;
  return previous;
}

/** Records a dependency and reports whether render collection was active. */
export function trackRenderDependency(dependency: RenderDependency): boolean {
  if (activeRenderCollector === undefined) return false;
  activeRenderCollector.add(dependency);
  return true;
}

/** Runs a callback without adding its reads to the active React render. */
export function untrackedRender<T>(callback: () => T): T {
  const previous = setActiveRenderCollector();
  try {
    return callback();
  } finally {
    setActiveRenderCollector(previous);
  }
}

/** A small versioned subscription surface shared by signals and computeds. */
export class RenderSubscription implements RenderDependency {
  // Written slots, not absent ones: the hooks are `undefined` whenever the
  // constructor is called without them, and `#listeners` is cleared back to
  // `undefined` to release the Set once the last listener unsubscribes.
  readonly #onFirstSubscriber?: (() => void) | undefined;
  readonly #onLastSubscriber?: (() => void) | undefined;
  #listeners?: Set<() => void> | undefined;
  #version = 0;

  constructor(
    onFirstSubscriber?: () => void,
    onLastSubscriber?: () => void,
  ) {
    this.#onFirstSubscriber = onFirstSubscriber;
    this.#onLastSubscriber = onLastSubscriber;
  }

  getRenderVersion(): number {
    return this.#version;
  }

  subscribeRender(listener: () => void): () => void {
    const listeners = (this.#listeners ??= new Set());
    const wasEmpty = listeners.size === 0;
    listeners.add(listener);
    if (wasEmpty) this.#onFirstSubscriber?.();

    return () => {
      const currentListeners = this.#listeners;
      if (currentListeners === undefined || !currentListeners.delete(listener)) {
        return;
      }
      if (currentListeners.size === 0) {
        this.#listeners = undefined;
        this.#onLastSubscriber?.();
      }
    };
  }

  track(): boolean {
    return trackRenderDependency(this);
  }

  /**
   * Whether anything is currently subscribed on the React side. Used by
   * `deepSignal`'s metadata pruning to tell a genuinely dead per-key version
   * signal from one a mounted component still depends on — dropping the
   * latter would strand that subscriber on a `RenderSubscription` the
   * property map no longer reaches, so it would never be notified again.
   */
  hasListeners(): boolean {
    return this.#listeners !== undefined && this.#listeners.size !== 0;
  }

  bumpVersion(): void {
    this.#version = (this.#version + 1) | 0;
  }

  notify(): void {
    this.bumpVersion();
    const listeners = this.#listeners;
    if (listeners === undefined) return;
    // Snapshot before iterating: a listener may (un)subscribe synchronously.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) notifyListener(listener);
  }
}

/**
 * Invokes one subscription listener, keeping its failure from cancelling the
 * listeners queued behind it. Without this, a single throwing subscriber
 * aborts the rest of the notify cycle, so unrelated components silently miss
 * the update that was being delivered. Reported the same way as the other
 * background-callback failures in this codebase (`readBoundSignal` in
 * src/runtime/jsx.ts): `console.error(message, { cause })`.
 */
export function notifyListener(listener: () => void): void {
  try {
    listener();
  } catch (error) {
    console.error(
      "react-fine-grained-signals: a render-subscription listener threw; continuing with the remaining listeners.",
      { cause: error },
    );
  }
}
