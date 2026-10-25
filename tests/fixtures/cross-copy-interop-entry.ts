// Test-only access to the shared context. The runtime values under test are
// still created and consumed through independently built public package copies.
export {
  getSharedInteropContext,
} from "../../src/core/interop.js";
export { createReactiveRuntime } from "../../src/core/reactive-runtime.js";
export { createAlienDerivedRenderAdapter } from "../../src/core/render-runtime.mjs";
export { executionContext } from "../../src/core/execution-owner.js";
