/* React hooks backed by attempt-local render tracking. */
import { useEffect, useInsertionEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { AlienDerivedRenderAdapter, RenderAttempt, RuntimeReadable } from "../core/alien-derived-types.js";
import type { ReadableProtocolV1 } from "../core/execution-owner.js";
import { executionContext, isRenderExecutionOwner } from "../core/execution-owner.js";
import { plainResultIteratorNext } from "../core/plain-result-iterators.js";

type ScopePolicy = "managed" | "bare";
type SubscriptionMode = "combined" | "per-readable";
interface SnapshotEntry { readonly dependencies: Map<object, number>; readonly value: unknown }
interface SnapshotCache { readonly readable: object; current: SnapshotEntry | undefined }
interface ManagedScope { finish(): void; getSnapshot(): number }
interface SignalCaptureScope extends ManagedScope {
  capture<T>(callback: () => T): T;
  iterate<T>(getIterable: () => Iterable<T>): Iterable<T>;
  forIn(getObject: () => unknown): Iterable<string>;
}

const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
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

type Capture = <R>(callback: () => R) => R;

/**
 * Built-in `next` methods always return a fresh ordinary result object whose
 * `done`/`value` are data properties, so reading them can never run user code.
 */
const NATIVE_ITERATOR_NEXT: ReadonlySet<unknown> = new Set<unknown>([
  Object.getPrototypeOf([][Symbol.iterator]()).next,
  Object.getPrototypeOf(new Map().entries()).next,
  Object.getPrototypeOf(new Set().values()).next,
  Object.getPrototypeOf(""[Symbol.iterator]()).next,
  // Generators are not listed: `yield*` hands back the delegate's result
  // object as is, which can be any custom result with getters.
  // Iterator helpers (`values().map(...)`) where the engine provides them.
  Object.getPrototypeOf(
    (([].values() as unknown as { map?: (fn: (value: unknown) => unknown) => object }).map?.((value) => value)) ?? {},
  ).next,
].filter((next) => typeof next === "function"));

/**
 * Defers `done`/`value` to the moment the loop reads them, each in its own
 * capture, so getter reads on a custom result stay tracked. The loop reads
 * `value` only when `done` is false, exactly as it would on the original.
 */
class CapturedIteratorResult<T> {
  readonly #result: IteratorResult<T>;
  readonly #capture: Capture;
  constructor(result: IteratorResult<T>, capture: Capture) {
    this.#result = result;
    this.#capture = capture;
  }
  get done(): boolean | undefined { return this.#capture(() => this.#result.done); }
  get value(): T { return this.#capture(() => this.#result.value); }
}

/**
 * `for (x of source)` pulls each element after the source expression returns.
 * Capture the source, GetIterator (including the single `next` lookup), every
 * `next()` call, each result's `done`/`value` read, and the `return` lookup and
 * call at close, one at a time and only when the loop performs them. The loop
 * keeps native laziness, order, `this` binding, early exit, iterator closing
 * and exception propagation while the reads performed during iteration stay
 * tracked.
 */
function captureIteration<T>(capture: Capture, getIterable: () => Iterable<T>): Iterable<T> {
  const iterable = capture(getIterable);
  const iterator = capture(() => {
    // GetIterator: one @@iterator lookup, called with the source as `this`.
    const method = iterable == null ? undefined : (iterable as Iterable<T>)[Symbol.iterator];
    if (typeof method !== "function") {
      throw new TypeError(`${isObject(iterable) ? typeof iterable : String(iterable)} is not iterable`);
    }
    return Reflect.apply(method, iterable, []) as Iterator<T>;
  });
  if (!isObject(iterator)) throw new TypeError("Result of the Symbol.iterator method is not an object");
  // GetIterator reads `next` once and reuses it for the whole loop.
  const next = capture(() => iterator.next);
  const nativeResults = NATIVE_ITERATOR_NEXT.has(next) || plainResultIteratorNext.has(next as Function);
  const forwarded: Iterator<T> & Iterable<T> = {
    next: () => {
      const result = capture(() => Reflect.apply(next, iterator, []) as IteratorResult<T>);
      if (nativeResults) return result;
      if (!isObject(result)) throw new TypeError(`Iterator result ${String(result)} is not an object`);
      return new CapturedIteratorResult(result, capture) as IteratorResult<T>;
    },
    return: () => {
      const close = capture(() => iterator.return);
      // IteratorClose skips an absent method; report a completed result so the
      // outer loop's own close step sees an object, as with no method at all.
      if (close == null) return { done: true, value: undefined };
      return capture(() => Reflect.apply(close, iterator, []) as IteratorResult<T>);
    },
    [Symbol.iterator]() { return forwarded; },
  };
  return forwarded;
}

/**
 * `for (k in source)`: enumerate the keys (own and inherited, as the native
 * loop does) inside a capture so the enumeration is tracked, then hand them
 * out lazily, skipping any key deleted before its turn like the native loop.
 */
function captureForIn(capture: Capture, getObject: () => unknown): Iterable<string> {
  const value = capture(getObject);
  const target = value == null ? undefined : Object(value) as object;
  const keys: string[] = [];
  if (target !== undefined) capture(() => { for (const key in target) keys.push(key); });
  return {
    *[Symbol.iterator]() {
      for (const key of keys) if (capture(() => key in target!)) yield key;
    },
  };
}

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
  #closedAttempts = new WeakSet<RenderAttempt>();
  // Advanced only by lifecycle events that prove the component is mounted and
  // visible again: a layout commit and a passive (re)activation. A render on
  // its own, such as a hidden Activity prerender, must not cancel a scheduled
  // dispose: a hidden tree never commits or activates, and one deleted while
  // hidden gets no second passive cleanup.
  #lifecycle = 0;

  constructor(mode: SubscriptionMode) { this.#mode = mode; }
  getSnapshot = () => this.#version;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  begin(scopePolicy: ScopePolicy, ambient = true): RenderAttempt {
    const attempt = render.createRenderAttempt();
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
    const lifecycle = ++this.#lifecycle;
    queueMicrotask(() => { if (this.#lifecycle === lifecycle) this.dispose(); });
  }
  activate(): void { this.#lifecycle += 1; }
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
  function useTrackingStore(scopePolicy: ScopePolicy, ambient = true): { store: RenderStore; attempt: RenderAttempt } {
    const store = useMemo(() => new RenderStore(mode), []);
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const attempt = store.begin(scopePolicy, ambient);
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
  function useSignalCapture(): SignalCaptureScope {
    const { store, attempt } = useTrackingStore("managed", false);
    const capture = <T,>(callback: () => T): T => store.capture(attempt, callback);
    return {
      finish: () => store.finish(attempt),
      getSnapshot: store.getSnapshot,
      capture,
      iterate: (getIterable) => captureIteration(capture, getIterable),
      forIn: (getObject) => captureForIn(capture, getObject),
    };
  }
  return { useSignalValue, useSignalTracking, useManagedSignals, useSignalCapture };
}

function managed<T>(scope: ManagedScope, callback: () => T): T {
  try { return callback(); }
  finally { scope.finish(); }
}

  return { createReactAdapter, managed };
}
