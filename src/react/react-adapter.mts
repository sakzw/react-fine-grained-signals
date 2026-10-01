/* React hooks backed by attempt-local render tracking. */
import { useEffect, useInsertionEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { AlienDerivedRenderAdapter, RenderAttempt, RuntimeReadable } from "../core/alien-derived-types.js";
import type { ReadableProtocolV1 } from "../core/execution-owner.js";

type ScopePolicy = "managed" | "bare";
type SubscriptionMode = "combined" | "per-readable";
interface SnapshotEntry { readonly dependencies: Map<object, number>; readonly value: unknown }
interface SnapshotCache { readonly readable: object; current: SnapshotEntry | undefined }
interface ManagedScope { finish(): void; getSnapshot(): number }

export function createAlienDerivedReactAdapter(_core: unknown, render: AlienDerivedRenderAdapter) {
function isInteropProtocol(dependency: object): dependency is ReadableProtocolV1 {
  return Reflect.get(dependency, "version") === 1
    && typeof Reflect.get(dependency, "getRevision") === "function"
    && typeof Reflect.get(dependency, "subscribe") === "function";
}
function dependencyVersion(dependency: object): number {
  return isInteropProtocol(dependency)
    ? dependency.getRevision()
    : render.getRenderVersion(dependency);
}
function subscribeDependency(dependency: object, notify: () => void): () => void {
  if (isInteropProtocol(dependency)) return dependency.subscribe(() => notify()).unsubscribe;
  const subscribeRender = Reflect.get(dependency, "subscribeRender");
  if (typeof subscribeRender === "function") return subscribeRender.call(dependency, notify) as () => void;
  return render.subscribeReadables([dependency], notify);
}

function snapshot<T>(readable: RuntimeReadable<T>, cache: SnapshotCache): T {
  const captured = render.captureRenderSnapshot(readable);
  const current = cache.current;
  const same = current !== undefined
    && current.dependencies.size === captured.dependencies.size
    && [...captured.dependencies].every(([dependency, revision]) =>
      current.dependencies.get(dependency) === revision
      && dependencyVersion(dependency) === revision);
  if (same) return current.value as T;
  cache.current = captured;
  return captured.value as T;
}

class RenderStore {
  #mode: SubscriptionMode;
  #subscriptions = new Map<object, () => void>();
  #combinedDependencies = new Set<object>();
  #listeners = new Set<() => void>();
  #version = 0;
  #epoch = 0;

  constructor(mode: SubscriptionMode) { this.#mode = mode; }
  getSnapshot = () => this.#version;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  begin(scopePolicy: ScopePolicy): RenderAttempt {
    const attempt = render.createRenderAttempt();
    attempt.restoreScope = render.pushRenderScope(attempt, scopePolicy);
    this.#epoch += 1;
    queueMicrotask(() => this.finish(attempt));
    return attempt;
  }
  finish(attempt: RenderAttempt): void {
    attempt?.restoreScope?.();
    attempt.restoreScope = undefined;
  }
  commit(attempt: RenderAttempt): void {
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
  #notify = (): void => {
    this.#version = (this.#version + 1) | 0;
    for (const listener of this.#listeners) listener();
  };
  dispose(): void {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    this.#combinedDependencies.clear();
  }
  scheduleDispose(): void {
    const epoch = ++this.#epoch;
    queueMicrotask(() => { if (this.#epoch === epoch) this.dispose(); });
  }
  activate(): void { this.#epoch += 1; }
}

function createReactAdapter(
  runtimeOrOptions: { readonly mode?: SubscriptionMode } = {},
  maybeOptions: { readonly mode?: SubscriptionMode } = {},
) {
  const mode = maybeOptions.mode ?? runtimeOrOptions.mode ?? "combined";
  if (mode !== "combined" && mode !== "per-readable") throw new Error(`Unknown render subscription mode: ${mode}`);
  function useSignalValue<T>(readable: RuntimeReadable<T>): T {
    const subscribe = useMemo(() => (notify: () => void) => subscribeDependency(readable, notify), [readable]);
    const cache = useMemo<SnapshotCache>(() => ({ readable, current: undefined }), [readable]);
    const getSnapshot = useMemo(() => () => snapshot(readable, cache), [readable, cache]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }
  function useTrackingStore(scopePolicy: ScopePolicy): { store: RenderStore; attempt: RenderAttempt } {
    const store = useMemo(() => new RenderStore(mode), []);
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const attempt = store.begin(scopePolicy);
    // A bare scope deliberately stays open after this component returns, so
    // descendants rendered without their own scope are still attributed to it.
    // Rendering is over once React starts committing, though, and every
    // insertion effect in the tree runs before any layout effect or ref
    // callback. Closing here keeps descendants' layout effects and refs (which
    // run before this component's own layout effect) out of the render attempt.
    useInsertionEffect(() => { store.finish(attempt); }, [store, attempt]);
    useLayoutEffect(() => { store.commit(attempt); }, [store, attempt]);
    useEffect(() => {
      store.activate();
      return () => store.scheduleDispose();
    }, [store]);
    return { store, attempt };
  }
  function useSignalTracking(): void { useTrackingStore("bare"); }
  function useManagedSignals(): ManagedScope {
    const { store, attempt } = useTrackingStore("managed");
    return { finish: () => store.finish(attempt), getSnapshot: store.getSnapshot };
  }
  return { useSignalValue, useSignalTracking, useManagedSignals };
}

function managed<T>(scope: ManagedScope, callback: () => T): T {
  try { return callback(); }
  finally { scope.finish(); }
}

  return { createReactAdapter, managed };
}
