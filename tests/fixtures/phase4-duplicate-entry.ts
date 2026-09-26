// Test-only entry. This is built into isolated temporary bundles by the
// Phase 4 smoke test and is not part of the package's public exports.
export { createReactiveRuntime } from "../../src/core/reactive-runtime.js";
export { deepSignal } from "../../src/core/index.js";
export {
  getSharedInteropContext,
  READABLE_INTEROP_V1,
} from "../../src/core/interop.js";
export {
  useManagedSignals,
  useSignalTracking,
} from "../../src/react/use-signals.js";
