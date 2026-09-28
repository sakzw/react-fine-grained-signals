import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { createRenderAttempt, pushRenderCollector, setRenderCollector } from "./render-context.mjs";
import { getSharedInteropContext } from "./alien-derived-runtime-interop-context.mjs";

function isInteropProtocol(dependency) {
  return dependency !== null && typeof dependency === "object"
    && typeof dependency.getRevision === "function"
    && typeof dependency.subscribe === "function";
}
function dependencyVersion(runtime, dependency) {
  return isInteropProtocol(dependency) ? dependency.getRevision() : runtime.getRenderVersion(dependency);
}
function subscribeDependency(runtime, dependency, notify) {
  if (isInteropProtocol(dependency)) return dependency.subscribe(() => notify()).unsubscribe;
  return runtime.subscribeReadables([dependency], notify);
}

function snapshot(readable, runtime, cache) {
  const captured = runtime.captureRenderSnapshot(readable);
  const same = cache.current !== undefined
    && cache.current.dependencies.size === captured.dependencies.size
    && [...captured.dependencies].every(([dependency, version]) =>
      cache.current.dependencies.get(dependency) === version
      && dependencyVersion(runtime, dependency) === version);
  if (same) return cache.current.value;
  cache.current = captured;
  return captured.value;
}

class RenderStore {
  #runtime;
  #mode;
  #subscriptions = new Map();
  #combinedDependencies = new Set();
  #listeners = new Set();
  #version = 0;
  #epoch = 0;

  constructor(runtime, mode) { this.#runtime = runtime; this.#mode = mode; }
  getSnapshot = () => this.#version;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  begin() {
    const attempt = createRenderAttempt();
    attempt.runtimeToken = this.#runtime.runtimeToken;
    attempt.restoreCollector = pushRenderCollector(attempt);
    const context = getSharedInteropContext();
    const previousSharedCollector = context.renderCollector;
    context.renderCollector = attempt;
    attempt.restoreSharedCollector = () => { context.renderCollector = previousSharedCollector; };
    const epoch = ++this.#epoch;
    queueMicrotask(() => {
      if (this.#epoch === epoch) setRenderCollector(undefined);
    });
    return attempt;
  }
  finish(attempt, restorePrevious = false) {
    if (attempt === undefined) return;
    if (restorePrevious) {
      attempt.restoreCollector?.();
      attempt.restoreSharedCollector?.();
    } else {
      setRenderCollector(undefined);
      getSharedInteropContext().renderCollector = undefined;
    }
  }
  commit(attempt) {
    this.finish(attempt);
    const desired = attempt.dependencies;
    let changedDuringRender = this.#runtime.promoteRenderAttempt?.(attempt) === false;
    if (this.#mode === "combined") {
      const keys = new Set([...desired.keys()].filter((key) => !isInteropProtocol(key)));
      const sameDependencies = keys.size === this.#combinedDependencies.size && [...keys].every((value) => this.#combinedDependencies.has(value));
      if (!sameDependencies) {
        this.#subscriptions.get(this)?.();
        this.#subscriptions.delete(this);
        this.#combinedDependencies = keys;
        if (keys.size > 0) this.#subscriptions.set(this, this.#runtime.subscribeReadables([...keys], this.#notify));
      }
      for (const [dependency, unsubscribe] of this.#subscriptions) {
        if (dependency !== this && (!isInteropProtocol(dependency) || !desired.has(dependency))) {
          unsubscribe(); this.#subscriptions.delete(dependency);
        }
      }
      for (const dependency of desired.keys()) {
        if (isInteropProtocol(dependency) && !this.#subscriptions.has(dependency)) {
          this.#subscriptions.set(dependency, subscribeDependency(this.#runtime, dependency, this.#notify));
        }
      }
    } else {
      for (const [readable, unsubscribe] of this.#subscriptions) {
        if (!desired.has(readable)) { unsubscribe(); this.#subscriptions.delete(readable); }
      }
      for (const readable of desired.keys()) {
        if (!this.#subscriptions.has(readable)) {
          this.#subscriptions.set(readable, subscribeDependency(this.#runtime, readable, this.#notify));
        }
      }
    }
    for (const [readable, version] of desired) {
      if (dependencyVersion(this.#runtime, readable) !== version) changedDuringRender = true;
    }
    if (changedDuringRender) this.#notify();
  }
  #notify = () => {
    this.#version = (this.#version + 1) | 0;
    for (const listener of this.#listeners) listener();
  };
  dispose() {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    this.#combinedDependencies.clear();
  }
  scheduleDispose() {
    const epoch = ++this.#epoch;
    queueMicrotask(() => { if (this.#epoch === epoch) this.dispose(); });
  }
  activate() { this.#epoch += 1; }
}

export function createReactAdapter(runtime, { mode = "combined" } = {}) {
  if (mode !== "combined" && mode !== "per-readable") throw new Error(`Unknown render subscription mode: ${mode}`);
  function useSignalValue(readable) {
    const subscribe = useMemo(() => (notify) => runtime.subscribeReadables([readable], notify), [readable]);
    const cache = useMemo(() => ({ current: undefined }), [readable]);
    const getSnapshot = useMemo(() => () => snapshot(readable, runtime, cache), [readable, cache]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  function useTrackingStore() {
    const store = useMemo(() => new RenderStore(runtime, mode), []);
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const attempt = store.begin();
    useLayoutEffect(() => { store.commit(attempt); }, [store, attempt]);
    useEffect(() => {
      store.activate();
      return () => store.scheduleDispose();
    }, [store]);
    return { store, attempt };
  }
  function useSignalTracking() {
    useTrackingStore();
  }
  function useManagedSignals() {
    const { store, attempt } = useTrackingStore();
    return { finish: () => store.finish(attempt, true) };
  }
  return { useSignalValue, useSignalTracking, useManagedSignals };
}

export function managed(scope, render) {
  try { return render(); }
  finally { scope.finish(); }
}
