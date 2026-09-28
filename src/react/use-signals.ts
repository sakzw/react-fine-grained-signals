import { coreRuntime } from "../core/core-runtime.js";
import { createAlienDerivedReactAdapter } from "./react-adapter.mjs";

const reactAdapter = createAlienDerivedReactAdapter(coreRuntime, coreRuntime.renderAdapter).createReactAdapter();

/** The render-scope handle consumed by the source transform runtime. */
export interface ManagedSignalsStore {
  finish(): void;
}

/** Best-effort render tracking for untransformed components. */
export function useSignalTracking(): void {
  reactAdapter.useSignalTracking();
}

/** Exact render scope used by the transform-managed boundary. */
export function useManagedSignals(): ManagedSignalsStore {
  return reactAdapter.useManagedSignals();
}
