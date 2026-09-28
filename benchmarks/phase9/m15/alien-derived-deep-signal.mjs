const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
const brandDescriptor = { value: 1, enumerable: false, writable: false, configurable: false };

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function createDeepSignalFactory(runtime) {
  const signal = runtime.signalClassBrandHelper;
  const proxyToRaw = new WeakMap();
  const rawToProxy = new WeakMap();

  function proxyFor(raw) {
    if (!isPlainObject(raw)) return raw;
    const existing = rawToProxy.get(raw);
    if (existing !== undefined) return existing;
    const state = { properties: new Map(), existence: new Map(), iteration: undefined };
    const version = (map, key) => {
      let readable = map.get(key);
      if (readable === undefined) map.set(key, readable = signal(0));
      return readable;
    };
    const proxy = new Proxy(raw, {
      get(target, key, receiver) {
        if (key === SIGNAL_BRAND) return 1;
        if (key === "peek") return () => target;
        version(state.properties, key).value;
        return proxyFor(Reflect.get(target, key, receiver));
      },
      set(target, key, value) {
        const rawValue = proxyToRaw.get(value) ?? value;
        const had = Object.hasOwn(target, key);
        const previous = Reflect.get(target, key);
        const result = Reflect.set(target, key, rawValue, target);
        if (result && !Object.is(previous, rawValue)) {
          version(state.properties, key).value += 1;
          if (had !== Object.hasOwn(target, key)) version(state.existence, key).value += 1;
          if (!had) (state.iteration ??= signal(0)).value += 1;
        }
        return result;
      },
      deleteProperty(target, key) {
        const had = Object.hasOwn(target, key);
        const result = Reflect.deleteProperty(target, key);
        if (result && had) {
          version(state.properties, key).value += 1;
          version(state.existence, key).value += 1;
          (state.iteration ??= signal(0)).value += 1;
        }
        return result;
      },
      has(target, key) {
        version(state.existence, key).value;
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        (state.iteration ??= signal(0)).value;
        return Reflect.ownKeys(target);
      },
    });
    proxyToRaw.set(proxy, raw);
    rawToProxy.set(raw, proxy);
    return proxy;
  }

  return function deepSignal(initial) {
    if (!isPlainObject(initial)) throw new TypeError("deepSignal() requires a plain object or array root");
    const root = signal(proxyFor(initial));
    const readable = {
      get value() { return root.value; },
      set value(value) { root.value = proxyFor(value); },
      peek() {
        const current = root.peek();
        return proxyToRaw.get(current) ?? current;
      },
    };
    Object.defineProperty(readable, SIGNAL_BRAND, brandDescriptor);
    return readable;
  };
}
