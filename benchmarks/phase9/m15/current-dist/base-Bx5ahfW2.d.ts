//#region src/core/base.d.ts
/** A readable reactive value. */
interface ReadonlySignal<T> {
  readonly value: T;
  peek(): T;
}
/** A readable and writable reactive value. */
interface Signal<T> extends ReadonlySignal<T> {
  value: T;
}
/** Returns whether a value came from this package's signal APIs, any copy. */
declare function isSignal(value: unknown): value is ReadonlySignal<unknown>;
/** Creates a writable reactive value. */
declare function signal<T>(initialValue: T): Signal<T>;
/** Creates a lazily evaluated reactive value. */
declare function computed<T>(getter: () => T): ReadonlySignal<T>;
/** Runs a reactive side effect and returns a disposer. */
declare function effect(fn: () => void | (() => void)): () => void;
/** Groups writes, deferring effect notifications until the callback completes. */
declare function batch<T>(fn: () => T): T;
/** Runs a callback without collecting reactive dependencies. */
declare function untracked<T>(fn: () => T): T;
//#endregion
export { effect as a, untracked as c, computed as i, Signal as n, isSignal as o, batch as r, signal as s, ReadonlySignal as t };
