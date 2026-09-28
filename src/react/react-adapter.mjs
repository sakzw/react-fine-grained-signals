/* React hooks backed by attempt-local render tracking. */
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";

export function createAlienDerivedReactAdapter(core, render) {function isInteropProtocol(dependency) {
  return dependency !== null && typeof dependency === "object"
    && dependency.version === 1
    && typeof dependency.getRevision === "function"
    && typeof dependency.subscribe === "function";
}
function dependencyVersion(dependency) {
  return isInteropProtocol(dependency)
    ? dependency.getRevision()
    : render.getRenderVersion(dependency);
}
function subscribeDependency(dependency, notify) {
  if (isInteropProtocol(dependency)) return dependency.subscribe(() => notify()).unsubscribe;
  if (typeof dependency?.subscribeRender === "function") return dependency.subscribeRender(notify);
  return render.subscribeReadables([dependency], notify);
}

function snapshot(readable, cache) {
  const captured = render.captureRenderSnapshot(readable);
  const same = cache.current !== undefined
    && cache.current.dependencies.size === captured.dependencies.size
    && [...captured.dependencies].every(([dependency, revision]) =>
      cache.current.dependencies.get(dependency) === revision
      && dependencyVersion(dependency) === revision);
  if (same) return cache.current.value;
  cache.current = captured;
  return captured.value;
}

class RenderStore {
  #mode;
  #subscriptions = new Map();
  #combinedDependencies = new Set();
  #listeners = new Set();
  #version = 0;
  #epoch = 0;

  constructor(mode) { this.#mode = mode; }
  getSnapshot = () => this.#version;
  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  begin() {
    const attempt = render.createRenderAttempt();
    attempt.restoreScope = render.pushRenderScope(attempt);
    this.#epoch += 1;
    queueMicrotask(() => this.finish(attempt));
    return attempt;
  }
  finish(attempt) {
    attempt?.restoreScope?.();
    attempt.restoreScope = undefined;
  }
  commit(attempt) {
    this.finish(attempt);
    let changedDuringRender = !render.promoteRenderAttempt(attempt);
    const desired = attempt.dependencies;
    if (this.#mode === "combined") {
      const local = new Set([...desired.keys()].filter((dependency) => !isInteropProtocol(dependency)));
      const same = local.size === this.#combinedDependencies.size
        && [...local].every((dependency) => this.#combinedDependencies.has(dependency));
      if (!same) {
        this.#subscriptions.get(this)?.();
        this.#subscriptions.delete(this);
        this.#combinedDependencies = local;
        if (local.size > 0) this.#subscriptions.set(this, render.subscribeReadables([...local], this.#notify));
      }
      for (const [dependency, unsubscribe] of this.#subscriptions) {
        if (dependency !== this && (!isInteropProtocol(dependency) || !desired.has(dependency))) {
          unsubscribe();
          this.#subscriptions.delete(dependency);
        }
      }
      for (const dependency of desired.keys()) {
        if (isInteropProtocol(dependency) && !this.#subscriptions.has(dependency)) {
          this.#subscriptions.set(dependency, subscribeDependency(dependency, this.#notify));
        }
      }
    } else {
      for (const [dependency, unsubscribe] of this.#subscriptions) {
        if (!desired.has(dependency)) {
          unsubscribe();
          this.#subscriptions.delete(dependency);
        }
      }
      for (const dependency of desired.keys()) {
        if (!this.#subscriptions.has(dependency)) {
          this.#subscriptions.set(dependency, subscribeDependency(dependency, this.#notify));
        }
      }
    }
    if (!render.settleRenderAttempt(attempt)) changedDuringRender = true;
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

function createReactAdapter(runtimeOrOptions, maybeOptions) {
  const mode = maybeOptions?.mode ?? runtimeOrOptions?.mode ?? "combined";
  if (mode !== "combined" && mode !== "per-readable") throw new Error(`Unknown render subscription mode: ${mode}`);
  function useSignalValue(readable) {
    const subscribe = useMemo(() => (notify) => subscribeDependency(readable, notify), [readable]);
    const cache = useMemo(() => ({ readable, current: undefined }), [readable]);
    const getSnapshot = useMemo(() => () => snapshot(readable, cache), [readable, cache]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  function useTrackingStore() {
    const store = useMemo(() => new RenderStore(mode), []);
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const attempt = store.begin();
    useLayoutEffect(() => { store.commit(attempt); }, [store, attempt]);
    useEffect(() => {
      store.activate();
      return () => store.scheduleDispose();
    }, [store]);
    return { store, attempt };
  }
  function useSignalTracking() { useTrackingStore(); }
  function useManagedSignals() {
    const { store, attempt } = useTrackingStore();
    return { finish: () => store.finish(attempt), getSnapshot: store.getSnapshot };
  }
  return { useSignalValue, useSignalTracking, useManagedSignals };
}

function managed(scope, callback) {
  try { return callback(); }
  finally { scope.finish(); }
}

  return { createReactAdapter, managed };
}
