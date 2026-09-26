import { createDeepSignalFactory } from "../../../src/core/deep-signal-engine.js";
import { attachReadableInterop, getReadableInterop } from "../../../src/core/interop.js";
import { coreRuntime, isSignal, registerSignal, signal } from "./candidate-c-base.js";

const deep = createDeepSignalFactory({
  createSignal<T>(initial: T) {
    const source = signal(initial);
    let watchedSinceWrite = false;
    const bridge = {
      get value() { return source.value; },
      set value(next: T) { watchedSinceWrite = false; source.value = next; },
      peek() { return source.peek(); },
      markWatched() { watchedSinceWrite = true; },
      hasSubscribers() { return watchedSinceWrite || coreRuntime.hasSubscribers(source as never); },
    };
    const protocol = getReadableInterop(source);
    if (protocol !== undefined) attachReadableInterop(bridge, protocol);
    return bridge;
  },
  batch: coreRuntime.batch,
  isSignal,
  hasActiveSubscriber: coreRuntime.hasActiveSubscriber,
  getBatchDepth: coreRuntime.getBatchDepth,
  registerDeepSignal(value) { registerSignal(value as object); },
});

export const deepSignal = deep.deepSignal;
export const inspectDeepSignalMetadata = deep.inspectDeepSignalMetadata;
