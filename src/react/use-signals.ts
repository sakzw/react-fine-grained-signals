import { coreRuntime } from "../core/core-runtime.js";
import { createAlienDerivedReactAdapter } from "./react-adapter.mjs";

const reactAdapter = createAlienDerivedReactAdapter(coreRuntime, coreRuntime.renderAdapter).createReactAdapter();

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
}

/** Per-read render-attempt capture handle used by the experimental transform prototype. */
export interface SignalCaptureStore extends ManagedSignalsStore {
  capture<T>(callback: () => T): T;
  /** Lazily forwards a `for...of` source, capturing GetIterator and each `next()`/`return()`. */
  iterate<T>(getIterable: () => Iterable<T>): Iterable<T>;
}

/** Best-effort render tracking for untransformed components. */
export function useSignalTracking(): void {
  reactAdapter.useSignalTracking();
}

/** Exact render scope used by the transform-managed boundary. */
export function useManagedSignals(): ManagedSignalsStore {
  return reactAdapter.useManagedSignals();
}

/** Capture synchronous signal reads without keeping an ambient render scope open. */
export function useSignalCapture(): SignalCaptureStore {
  return reactAdapter.useSignalCapture();
}
