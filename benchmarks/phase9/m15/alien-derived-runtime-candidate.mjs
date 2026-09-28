import * as runtime from "./alien-derived-runtime-render.mjs";
import { createDeepSignalFactory } from "./alien-derived-deep-signal.mjs";

export * from "./alien-derived-runtime-render.mjs";
export const deepSignal = createDeepSignalFactory(runtime);
