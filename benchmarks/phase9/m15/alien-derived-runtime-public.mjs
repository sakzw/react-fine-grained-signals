/*
 * Disposable M1.5 public-wrapper/brand candidate. It layers only the public
 * `.value`/`.peek()` and package brand contract over the isolated Alien-derived
 * Object.is graph. Cross-copy interop remains intentionally out of scope.
 */
import * as graph from "./alien-derived-runtime-objectis.mjs";

const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
const SIGNAL_BRAND_VERSION = 1;
const SIGNAL_BRAND_MIN_VERSION = 1;
const localSignals = new WeakSet();

function registerSignal(value) {
  localSignals.add(value);
  Object.defineProperty(value, SIGNAL_BRAND, {
    value: SIGNAL_BRAND_VERSION,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

class PublicSignal {
  #source;
  constructor(source) { this.#source = source; registerSignal(this); }
  get value() { return this.#source.value; }
  set value(value) { this.#source.value = value; }
  peek() { return this.#source.peek(); }
}

class PublicComputed {
  #readable;
  constructor(readable) { this.#readable = readable; registerSignal(this); }
  get value() { return this.#readable.value; }
  peek() { return this.#readable.peek(); }
}

export function signal(initialValue) {
  return new PublicSignal(graph.signalClassInline(initialValue));
}
export function computed(getter) { return new PublicComputed(graph.computed(getter)); }
export function isSignal(value) {
  if (typeof value !== "object" || value === null) return false;
  if (localSignals.has(value)) return true;
  const brand = value[SIGNAL_BRAND];
  return typeof brand === "number" && brand >= SIGNAL_BRAND_MIN_VERSION && typeof value.peek === "function";
}
export const effect = graph.effect;
export const batch = graph.batch;
export const untracked = graph.untracked;
export { SIGNAL_BRAND };
