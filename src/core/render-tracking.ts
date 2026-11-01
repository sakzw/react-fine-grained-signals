import {
  UNTRACKED_OWNER,
  executionContext,
  isGraphExecutionOwner,
  withSynchronousExecutionOwner,
} from "./execution-owner.js";

/** Internal dependency contract used by the React render collector. */
export interface RenderDependency {
  getRenderVersion(): number;
  subscribeRender(listener: () => void): () => void;
}

export interface RenderCollector {
  add(dependency: RenderDependency, observedVersion: number): void;
}

export let activeRenderCollector: RenderCollector | undefined;

/** Returns whether a React render is currently collecting signal reads. */
export function hasActiveRenderCollector(): boolean {
  return activeRenderCollector !== undefined;
}

/** Replaces the current render collector and returns the previous collector. */
export function setActiveRenderCollector(collector?: RenderCollector): RenderCollector | undefined {
  const previous = activeRenderCollector;
  activeRenderCollector = collector;
  return previous;
}

/** Records a dependency and reports whether render collection was active. */
export function trackRenderDependency(dependency: RenderDependency, observedVersion?: number): boolean {
  if (activeRenderCollector === undefined) return false;
  activeRenderCollector.add(dependency, observedVersion ?? dependency.getRenderVersion());
  return true;
}

/** Runs a callback without adding its reads to the active React render. */
export function untrackedRender<T>(callback: () => T): T {
  const previous = setActiveRenderCollector();
  try {
    // A render-only pause must keep an enclosing graph subscriber active.
    if (isGraphExecutionOwner(executionContext.owner)) return callback();
    return withSynchronousExecutionOwner(UNTRACKED_OWNER, callback);
  } finally {
    setActiveRenderCollector(previous);
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

/**
 * A detached effect that subscribes to what `read` reads and calls `onChange`
 * after every run but the first. A read that throws keeps its errored computed
 * observed, and `onChange` is isolated like any other listener. Shared by
 * every subscription that is not itself a render dependency: hooks, direct
 * JSX bindings, the render store and graph nodes.
 */
export function subscribeToReads(
  detachedEffect: (fn: () => void) => () => void,
  read: () => void,
  onChange: () => void,
): () => void {
  let initial = true;
  return detachedEffect(() => {
    try {
      read();
    } catch {
      /* Keep errored computed boundaries observed. */
    }
    if (initial) initial = false;
    else notifyListener(onChange);
  });
}
