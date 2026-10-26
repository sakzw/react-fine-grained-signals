/* React hooks backed by attempt-local render tracking. */
import { useEffect, useInsertionEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { AlienDerivedRenderAdapter, RenderAttempt } from "../core/alien-derived-types.js";
import { executionContext, isRenderExecutionOwner } from "../core/execution-owner.js";

type ScopePolicy = "managed" | "bare";
interface ManagedScope { finish(): void; getSnapshot(): number }
interface CaptureScope extends ManagedScope { capture<T>(callback: () => T): T }

/**
 * A capture or managed scope opened on top of an open bare window
 * (`useSignalTracking()`) suspends it and hands collection back when it pops,
 * instead of closing it: the window is usually the calling component's own,
 * and closing it would leave that component's later reads untracked. React
 * exposes no component identity to tell it apart from a window a previous
 * sibling left open; such a leftover window keeps collecting until the next
 * `useSignalTracking()`, commit, or microtask, which can only over-subscribe
 * (an extra render), never miss a dependency.
 */
const suspendsBareParent = (owner: typeof executionContext.owner): boolean =>
  isRenderExecutionOwner(owner) && owner.scopePolicy === "bare";

export function createAlienDerivedReactAdapter(_core: unknown, render: AlienDerivedRenderAdapter) {
class RenderStore {
  // One subscription covers every dependency of the latest committed render.
  #unsubscribe: (() => void) | undefined;
  #dependencies = new Set<object>();
  #listeners = new Set<() => void>();
  #version = 0;
  #closedAttempts = new WeakSet<RenderAttempt>();
  // Advanced only by lifecycle events that prove the component is mounted and
  // visible again: a layout commit and a passive (re)activation. A render on
  // its own, such as a hidden Activity prerender, must not cancel a scheduled
  // dispose: a hidden tree never commits or activates, and one deleted while
  // hidden gets no second passive cleanup.
  #lifecycle = 0;

  // The attempt this component's latest render began. React checks a
  // non-blocking render's snapshots once the whole render is done, and a
  // component renders at most once per render pass that commits (a Strict
  // Mode or `use()` replay redoes it before moving on), so this is the attempt
  // being checked. After commit, `#version` reports every change on its own.
  #attempt: RenderAttempt | undefined;

  /**
   * A component that has not committed yet has no subscriptions, so
   * `#version` alone cannot move when a signal it read is written while a
   * concurrent render yields. Reporting the stale attempt to React's
   * render-end consistency check makes React re-render the tree synchronously
   * instead of committing it torn. The function stays the same across
   * renders, so an update render costs React no extra store bookkeeping.
   */
  getSnapshot = (): number =>
    this.#attempt === undefined || render.isRenderAttemptCurrent(this.#attempt) ? this.#version : ~this.#version;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  begin(scopePolicy: ScopePolicy, ambient = true): RenderAttempt {
    const attempt = render.createRenderAttempt();
    this.#attempt = attempt;
    if (ambient) {
      attempt.restoreScope = render.pushRenderScope(
        attempt,
        scopePolicy,
        scopePolicy === "managed" && suspendsBareParent(executionContext.owner),
      );
      queueMicrotask(() => this.finish(attempt));
    }
    return attempt;
  }
  finish(attempt: RenderAttempt): void {
    attempt?.restoreScope?.();
    attempt.restoreScope = undefined;
    this.#closedAttempts.add(attempt);
  }
  capture<T>(attempt: RenderAttempt, callback: () => T): T {
    if (this.#closedAttempts.has(attempt)) return callback();
    return render.withRenderScope(attempt, callback, "managed", suspendsBareParent(executionContext.owner));
  }
  commit(attempt: RenderAttempt): void {
    this.#lifecycle += 1;
    this.finish(attempt);
    let changedDuringRender = !render.promoteRenderAttempt(attempt);
    const desired = attempt.dependencies;
    let changed = desired.size !== this.#dependencies.size;
    if (!changed) {
      for (const dependency of desired.keys()) {
        if (!this.#dependencies.has(dependency)) { changed = true; break; }
      }
    }
    if (changed) {
      const dependencies = new Set<object>(desired.keys());
      this.#unsubscribe?.();
      this.#dependencies = dependencies;
      this.#unsubscribe = dependencies.size > 0
        ? render.subscribeReadables([...dependencies], this.#notify)
        : undefined;
    }
    if (!render.settleRenderAttempt(attempt)) changedDuringRender = true;
    if (changedDuringRender) this.#notify();
  }
  #notify = (): void => {
    this.#version = (this.#version + 1) | 0;
    for (const listener of this.#listeners) listener();
  };
  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#dependencies.clear();
  }
  scheduleDispose(): void {
    const lifecycle = ++this.#lifecycle;
    queueMicrotask(() => { if (this.#lifecycle === lifecycle) this.dispose(); });
  }
  activate(): void { this.#lifecycle += 1; }
}

function createReactAdapter() {
  function useTrackingStore(scopePolicy: ScopePolicy, ambient = true): { store: RenderStore; attempt: RenderAttempt } {
    const store = useMemo(() => new RenderStore(), []);
    const attempt = store.begin(scopePolicy, ambient);
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
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
  function useSignalCapture(): CaptureScope {
    const { store, attempt } = useTrackingStore("managed", false);
    return {
      finish: () => store.finish(attempt),
      getSnapshot: store.getSnapshot,
      capture: <T,>(callback: () => T): T => store.capture(attempt, callback),
    };
  }
  return { useSignalTracking, useManagedSignals, useSignalCapture };
}

  return { createReactAdapter };
}
