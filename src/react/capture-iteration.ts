/* Capture helpers for `for...of` and `for...in` in the managed transform's output. */
import { plainResultIteratorNext } from "../core/plain-result-iterators.js";

type Capture = <R>(callback: () => R) => R;

const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");

/**
 * Built-in `next` methods always return a fresh ordinary result object whose
 * `done`/`value` are data properties, so reading them can never run user code.
 */
const NATIVE_ITERATOR_NEXT: ReadonlySet<unknown> = new Set<unknown>(
  [
    Object.getPrototypeOf([][Symbol.iterator]()).next,
    Object.getPrototypeOf(new Map().entries()).next,
    Object.getPrototypeOf(new Set().values()).next,
    Object.getPrototypeOf(""[Symbol.iterator]()).next,
    // Generators are not listed: `yield*` hands back the delegate's result
    // object as is, which can be any custom result with getters.
    // Iterator helpers (`values().map(...)`) where the engine provides them.
    Object.getPrototypeOf(
      ([].values() as unknown as { map?: (fn: (value: unknown) => unknown) => object }).map?.((value) => value) ?? {},
    ).next,
  ].filter((next) => typeof next === "function"),
);

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
  get done(): boolean | undefined {
    return this.#capture(() => this.#result.done);
  }
  get value(): T {
    return this.#capture(() => this.#result.value);
  }
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
export function captureIteration<T>(capture: Capture, getIterable: () => Iterable<T>): Iterable<T> {
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
    [Symbol.iterator]() {
      return forwarded;
    },
  };
  return forwarded;
}

/** The native loop itself, so enumeration order, laziness, and traps match. */
function* forInKeys(source: unknown): Generator<string, void, undefined> {
  for (const key in source as object) yield key;
}

/**
 * `for (k in source)`: run the native `for...in` inside a generator and
 * capture each step, the way `iterate` captures a `for...of`. The engine
 * enumerates lazily (a Proxy's `getOwnPropertyDescriptor` and the prototype
 * walk run as the loop advances, a key deleted before its turn is skipped, and
 * `break` stops before the remaining keys are inspected); each step's reads
 * are collected without adding any trap call the native loop would not make.
 */
export function captureForIn(capture: Capture, getObject: () => unknown): Iterable<string> {
  const keys = forInKeys(capture(getObject));
  const forwarded: Iterator<string> & Iterable<string> = {
    next: () => capture(() => keys.next()),
    return: () => capture(() => keys.return()),
    [Symbol.iterator]() {
      return forwarded;
    },
  };
  return forwarded;
}
