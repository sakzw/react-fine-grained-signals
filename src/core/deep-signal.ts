import { getActiveSub } from "alien-signals";
import {
  batch,
  isSignal,
  registerSignal,
  SignalImpl,
  signal,
} from "./base.js";
import type { Signal } from "./base.js";

/** A signal whose plain-object and array values are reactive by property. */
export interface DeepSignal<T extends object> extends Signal<T> {}

interface PropertyMetadata {
  properties: Map<PropertyKey, Signal<number>>;
  existence: Map<PropertyKey, Signal<number>>;
  iteration?: Signal<number>;
  arrayMethods: Map<
    PropertyKey,
    { method: (...args: unknown[]) => unknown; wrapper: (...args: unknown[]) => unknown }
  >;
  proxy: object;
}

const ARRAY_MUTATORS = new Set<PropertyKey>([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const proxyToRaw = new WeakMap<object, object>();

function isPlainObjectOrArray(value: unknown): value is object {
  if (typeof value !== "object" || value === null || isSignal(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRootValue(value: unknown): asserts value is object {
  if (!isPlainObjectOrArray(value)) {
    throw new TypeError("deepSignal() only accepts a plain object or array root");
  }
}

function assertExtensible(value: object): void {
  if (!Object.isExtensible(value)) {
    throw new TypeError("deepSignal() cannot proxy a non-extensible object or array");
  }
}

function assertDataProperties(value: object): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) {
      throw new TypeError("deepSignal() does not support accessor properties");
    }
  }
}

function isArrayIndex(key: PropertyKey): key is string {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 0xffff_ffff &&
    String(index) === key
  );
}

function createDeepContext() {
  const rawToMetadata = new WeakMap<object, PropertyMetadata>();

  const unwrap = <T>(value: T): T => {
    if (typeof value !== "object" || value === null) return value;
    return (proxyToRaw.get(value) ?? value) as T;
  };

  const getVersion = (
    versions: Map<PropertyKey, Signal<number>>,
    key: PropertyKey,
  ): Signal<number> => {
    let version = versions.get(key);
    if (version === undefined) {
      version = signal(0);
      versions.set(key, version);
    }
    return version;
  };

  const track = (
    versions: Map<PropertyKey, Signal<number>>,
    key: PropertyKey,
  ): void => {
    if (getActiveSub() === undefined) return;
    getVersion(versions, key).value;
  };

  const notify = (
    versions: Map<PropertyKey, Signal<number>>,
    key: PropertyKey,
  ): void => {
    const version = versions.get(key);
    if (version !== undefined) version.value += 1;
  };

  const trackIteration = (metadata: PropertyMetadata): void => {
    if (getActiveSub() === undefined) return;
    metadata.iteration ??= signal(0);
    metadata.iteration.value;
  };

  const notifyIteration = (metadata: PropertyMetadata): void => {
    if (metadata.iteration !== undefined) metadata.iteration.value += 1;
  };

  const wrap = <T>(value: T): T => {
    const rawValue = unwrap(value);
    if (!isPlainObjectOrArray(rawValue)) return rawValue;
    assertExtensible(rawValue);

    const cached = rawToMetadata.get(rawValue);
    if (cached !== undefined) return cached.proxy as T;
    assertDataProperties(rawValue);

    const metadata: PropertyMetadata = {
      properties: new Map(),
      existence: new Map(),
      arrayMethods: new Map(),
      proxy: undefined as unknown as object,
    };

    const proxy = new Proxy(rawValue, {
      get(target, key, receiver) {
        track(metadata.properties, key);
        const result = Reflect.get(target, key, receiver);

        if (
          Array.isArray(target) &&
          ARRAY_MUTATORS.has(key) &&
          typeof result === "function"
        ) {
          const cachedMethod = metadata.arrayMethods.get(key);
          if (cachedMethod?.method === result) return cachedMethod.wrapper;

          const method = result as (...args: unknown[]) => unknown;
          const wrapper = function (this: unknown, ...args: unknown[]) {
            return batch(() => Reflect.apply(method, this, args));
          };
          metadata.arrayMethods.set(key, { method, wrapper });
          return wrapper;
        }

        if (isPlainObjectOrArray(result)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (
            descriptor !== undefined &&
            "value" in descriptor &&
            descriptor.configurable === false &&
            descriptor.writable === false
          ) {
            throw new TypeError(
              "deepSignal() cannot wrap a non-configurable, non-writable object property",
            );
          }
        }

        return wrap(result);
      },

      set(target, key, nextValue) {
        if (key === "__proto__") {
          throw new TypeError("deepSignal() does not support prototype mutation");
        }
        const oldValue = Reflect.get(target, key, target);
        const existed = Reflect.has(target, key);
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const oldLength = Array.isArray(target) ? target.length : undefined;
        const rawNextValue = unwrap(nextValue);
        if (isPlainObjectOrArray(rawNextValue)) assertExtensible(rawNextValue);
        const succeeded = Reflect.set(target, key, rawNextValue, target);
        if (!succeeded) return false;

        const currentValue = Reflect.get(target, key, target);
        const existsNow = Reflect.has(target, key);
        const ownedNow = Object.prototype.hasOwnProperty.call(target, key);

        batch(() => {
          if (!Object.is(oldValue, currentValue) || owned !== ownedNow) {
            notify(metadata.properties, key);
          }
          if (existed !== existsNow) notify(metadata.existence, key);
          if (owned !== ownedNow) notifyIteration(metadata);

          if (Array.isArray(target) && oldLength !== undefined) {
            const currentLength = target.length;
            if (key !== "length" && oldLength !== currentLength) {
              notify(metadata.properties, "length");
            }
            if (key === "length" && currentLength < oldLength) {
              for (const trackedKey of metadata.properties.keys()) {
                if (isArrayIndex(trackedKey) && Number(trackedKey) >= currentLength) {
                  notify(metadata.properties, trackedKey);
                }
              }
              for (const trackedKey of metadata.existence.keys()) {
                if (isArrayIndex(trackedKey) && Number(trackedKey) >= currentLength) {
                  notify(metadata.existence, trackedKey);
                }
              }
              notifyIteration(metadata);
            }
          }
        });

        return true;
      },

      deleteProperty(target, key) {
        const existed = Reflect.has(target, key);
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const succeeded = Reflect.deleteProperty(target, key);
        if (!succeeded || !owned) return succeeded;

        batch(() => {
          notify(metadata.properties, key);
          if (existed !== Reflect.has(target, key)) notify(metadata.existence, key);
          notifyIteration(metadata);
        });
        return true;
      },

      has(target, key) {
        track(metadata.existence, key);
        return Reflect.has(target, key);
      },

      ownKeys(target) {
        trackIteration(metadata);
        return Reflect.ownKeys(target);
      },

      defineProperty() {
        throw new TypeError("deepSignal() does not support property descriptors");
      },

      preventExtensions() {
        throw new TypeError("deepSignal() state must remain extensible");
      },

      setPrototypeOf() {
        throw new TypeError("deepSignal() does not support prototype mutation");
      },
    });

    metadata.proxy = proxy;
    rawToMetadata.set(rawValue, metadata);
    proxyToRaw.set(proxy, rawValue);
    return proxy as T;
  };

  return { unwrap, wrap };
}

type DeepContext = ReturnType<typeof createDeepContext>;

class DeepSignalImpl<T extends object>
  extends SignalImpl<T>
  implements DeepSignal<T>
{
  readonly #context: DeepContext;

  constructor(initialValue: T, context: DeepContext) {
    super(initialValue);
    this.#context = context;
  }

  override get value(): T {
    return this.#context.wrap(super.value);
  }

  override set value(nextValue: T) {
    const rawValue = this.#context.unwrap(nextValue);
    assertRootValue(rawValue);
    assertExtensible(rawValue);
    super.value = rawValue as T;
  }
}

/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
export function deepSignal<T extends object>(initialValue: T): DeepSignal<T> {
  const rawInitialValue = proxyToRaw.get(initialValue) ?? initialValue;
  assertRootValue(rawInitialValue);

  const context = createDeepContext();
  context.wrap(rawInitialValue);
  return registerSignal(new DeepSignalImpl(rawInitialValue as T, context));
}
