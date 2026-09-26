import { createReactiveRuntime } from "./reactive-runtime.js";

/** The single graph used by this package's public signal APIs. */
export const coreRuntime = createReactiveRuntime();
