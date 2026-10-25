import { coreRuntime } from "../core/core-runtime.js";
import { createAlienDerivedRenderAdapter } from "../core/render-runtime.mjs";
import { createAlienDerivedReactAdapter } from "./react-adapter.mjs";

const renderAdapter = coreRuntime.initializeRenderAdapter(createAlienDerivedRenderAdapter);
const reactAdapter = createAlienDerivedReactAdapter(coreRuntime, renderAdapter).createReactAdapter();

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
}

/** Per-read render-attempt capture handle used by the managed transform's generated code. */
export interface SignalCaptureStore extends ManagedSignalsStore {
  capture<T>(callback: () => T): T;
  /** Lazily forwards a `for...of` source, capturing GetIterator and each `next()`/`return()`. */
  iterate<T>(getIterable: () => Iterable<T>): Iterable<T>;
  /** Enumerates a `for...in` source's keys inside a capture, skipping keys deleted before their turn. */
  forIn(getObject: () => unknown): Iterable<string>;
}

/** Best-effort render tracking for untransformed components. */
export function useSignalTracking(): void {
  reactAdapter.useSignalTracking();
}

/**
 * Exact lexical render scope closed with `try`/`finally`. Library-internal: the
 * control-flow components in `utils.tsx` use it, and no public entry exports it.
 */
export function useManagedSignals(): ManagedSignalsStore {
  return reactAdapter.useManagedSignals();
}

/** Capture synchronous signal reads without keeping an ambient render scope open. */
export function useSignalCapture(): SignalCaptureStore {
  return reactAdapter.useSignalCapture();
}
