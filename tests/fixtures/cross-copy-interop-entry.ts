// Test-only access to the shared context. The runtime values under test are
// still created and consumed through independently built public package copies.
export { getSharedInteropContext } from "../../src/core/interop.js";
