import { createDeepSignalFactory } from "../../../src/core/deep-signal-engine.ts";
import * as runtime from "./alien-derived-runtime-render.mjs";

const watched = new WeakSet<object>();

export const deepSignalFactory = createDeepSignalFactory({
  createSignal: runtime.signalClassBrandHelper,
  markWatched(source) { watched.add(source as object); runtime.markDeepSignalWatched(source); },
  hasSubscribers: runtime.hasSubscribers,
  batch: runtime.batch,
  isSignal: runtime.isSignalBrandHelper,
  hasActiveSubscriber: runtime.hasActiveSubscriber,
  getBatchDepth: runtime.getBatchDepth,
  registerDeepSignal(value) {
    Object.defineProperty(value, runtime.SIGNAL_BRAND, {
      value: 1,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  },
});

export const deepSignal = deepSignalFactory.deepSignal;
export const inspectDeepSignalMetadata = deepSignalFactory.inspectDeepSignalMetadata;
