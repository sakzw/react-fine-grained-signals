import * as production from "../../../src/index.js";
import { registerSignal, isSignal } from "../../../src/core/base.js";
import { createDeepSignalFactory } from "../../../src/core/deep-signal-engine.js";
import { inspectDeepSignalMetadata } from "../../../src/core/deep-signal.js";
import { attachReadableInterop, getReadableInterop } from "../../../src/core/interop.js";
import { createReactiveRuntime as createCandidateBRuntime } from "../../../src/core/reactive-runtime.js";
import { createReactiveRuntime as createCandidateCRuntime } from "./candidate-c-runtime.js";
import { createReactiveRuntime as createCandidateC1Runtime } from "./candidate-c1-runtime.js";
import { createDeepSignalFactory as createCandidateC1DeepSignalFactory } from "./candidate-deep-signal-engine.js";

export function createCandidateA() {
  return { ...production, inspectDeepSignalMetadata };
}

export function createCandidateB() {
  const runtime = createCandidateBRuntime();
  const signal = <T>(initial: T) => registerSignal(runtime.signal(initial));
  const computed = <T>(getter: () => T) => registerSignal(runtime.computed(getter));
  const deepFactory = createDeepSignalFactory({
    createSignal<T>(initial: T) {
      const source = signal(initial);
      let watchedSinceWrite = false;
      const deepSource = {
        get value() { return source.value; },
        set value(next: T) {
          watchedSinceWrite = false;
          source.value = next;
        },
        peek() { return source.peek(); },
        markWatched() { watchedSinceWrite = true; },
        hasSubscribers() { return watchedSinceWrite || runtime.hasSubscribers(source); },
      };
      const protocol = getReadableInterop(source);
      if (protocol !== undefined) attachReadableInterop(deepSource, protocol);
      return deepSource;
    },
    batch: runtime.batch,
    isSignal,
    hasActiveSubscriber: runtime.hasActiveSubscriber,
    getBatchDepth: runtime.getBatchDepth,
    registerDeepSignal(value) { registerSignal(value as object); },
  });
  return {
    ...runtime,
    signal,
    computed,
    isSignal,
    deepSignal: deepFactory.deepSignal,
    inspectDeepSignalMetadata: deepFactory.inspectDeepSignalMetadata,
  };
}

export function createCandidateC() {
  const runtime = createCandidateCRuntime();
  const signal = <T>(initial: T) => registerSignal(runtime.signal(initial));
  const computed = <T>(getter: () => T) => registerSignal(runtime.computed(getter));
  const deepFactory = createDeepSignalFactory({
    createSignal<T>(initial: T) {
      const source = signal(initial);
      let watchedSinceWrite = false;
      const deepSource = {
        get value() { return source.value; },
        set value(next: T) {
          watchedSinceWrite = false;
          source.value = next;
        },
        peek() { return source.peek(); },
        markWatched() { watchedSinceWrite = true; },
        hasSubscribers() { return watchedSinceWrite || runtime.hasSubscribers(source); },
      };
      const protocol = getReadableInterop(source);
      if (protocol !== undefined) attachReadableInterop(deepSource, protocol);
      return deepSource;
    },
    batch: runtime.batch,
    isSignal,
    hasActiveSubscriber: runtime.hasActiveSubscriber,
    getBatchDepth: runtime.getBatchDepth,
    registerDeepSignal(value) {
      registerSignal(value as object);
    },
  });

  return {
    ...runtime,
    signal,
    computed,
    isSignal,
    deepSignal: deepFactory.deepSignal,
    inspectDeepSignalMetadata: deepFactory.inspectDeepSignalMetadata,
  };
}

export function createCandidateC1() {
  const runtime = createCandidateC1Runtime();
  const signal = <T>(initial: T) => registerSignal(runtime.signal(initial));
  const computed = <T>(getter: () => T) => registerSignal(runtime.computed(getter));
  const deepFactory = createCandidateC1DeepSignalFactory({
    createSignal<T>(initial: T) {
      return registerSignal(runtime.createDeepSignal(initial));
    },
    markWatched(source) {
      runtime.markDeepSignalWatched(source as Parameters<typeof runtime.markDeepSignalWatched>[0]);
    },
    hasSubscribers(source) {
      return runtime.hasDeepSignalSubscribers(source as Parameters<typeof runtime.hasDeepSignalSubscribers>[0]);
    },
    batch: runtime.batch,
    isSignal,
    hasActiveSubscriber: runtime.hasActiveSubscriber,
    getBatchDepth: runtime.getBatchDepth,
    registerDeepSignal(value) { registerSignal(value as object); },
  });
  return {
    ...runtime,
    signal,
    computed,
    isSignal,
    deepSignal: deepFactory.deepSignal,
    inspectDeepSignalMetadata: deepFactory.inspectDeepSignalMetadata,
  };
}
