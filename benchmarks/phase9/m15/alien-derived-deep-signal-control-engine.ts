import { createDeepSignalFactory } from "../../../src/core/deep-signal-engine.ts";
import * as runtime from "./alien-derived-runtime-objectis.mjs";

export const deepSignalFactory = createDeepSignalFactory({
  createSignal: runtime.signalClassHelper,
  markWatched: runtime.markDeepSignalWatched,
  hasSubscribers: runtime.hasSubscribers,
  batch: runtime.batch,
  isSignal: runtime.isSignalRuntimeReadable,
  hasActiveSubscriber: runtime.hasActiveSubscriber,
  getBatchDepth: runtime.getBatchDepth,
  registerDeepSignal(value) {
    Object.defineProperty(value, Symbol.for("react-fine-grained-signals.signal"), {
      value: 1, enumerable: false, writable: false, configurable: false,
    });
  },
});

export const deepSignal = deepSignalFactory.deepSignal;
