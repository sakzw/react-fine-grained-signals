// Test-only entry for independently bundled Prototype A copies.
export { createLeanRuntime } from "../../benchmarks/prototypes/lean-runtime.js";
export { getSharedInteropContext } from "../../src/core/interop.js";
export { withInteropSpeculativeMode, withoutInteropSpeculativeMode } from "../../src/core/interop.js";
export { attachReadableInterop, getReadableInterop } from "../../src/core/interop.js";
export { useSignalTracking } from "../../src/react/use-signals.js";
