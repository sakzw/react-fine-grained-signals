import { createDeepSignalFactory } from "../../../src/core/deep-signal-engine.ts";
import * as runtime from "./alien-derived-runtime-render.mjs";

const factory = createDeepSignalFactory({
  createSignal: runtime.signalClassBrandHelper,
  markWatched: runtime.markDeepSignalWatched,
  hasSubscribers: runtime.hasSubscribers,
  batch: runtime.batch,
  isSignal: runtime.isSignalBrandHelper,
  hasActiveSubscriber: runtime.hasActiveSubscriber,
  getBatchDepth: runtime.getBatchDepth,
  registerDeepSignal(value) {
    Object.defineProperty(value, runtime.SIGNAL_BRAND, { value: 1, enumerable: false, writable: false, configurable: false });
  },
});
export const deepSignal = factory.deepSignal;
export const inspectDeepSignalMetadata = factory.inspectDeepSignalMetadata;
