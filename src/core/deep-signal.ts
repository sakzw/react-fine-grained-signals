import { getActiveSub } from "alien-signals";
import {
  batch,
  isSignal,
  registerSignal,
  SignalImpl,
  signal,
} from "./base.js";
import type { Signal } from "./base.js";
import { hasActiveRenderCollector } from "./render-tracking.js";

/** A signal whose plain-object and array values are reactive by property. */
export interface DeepSignal<T extends object> extends Signal<T> {}

interface PropertyMetadata {
  properties: Map<PropertyKey, Signal<number>>;
  existence: Map<PropertyKey, Signal<number>>;
  propertyIndices: Set<number>;
  existenceIndices: Set<number>;
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
const rawToAllMetadata = new WeakMap<object, Set<PropertyMetadata>>();

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

function normalizeProxies<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const directRaw = proxyToRaw.get(value);
  if (directRaw !== undefined) return directRaw as T;
  if (!isPlainObjectOrArray(value)) return value;

  const seen = new WeakSet<object>();
  const proxyTargets = new WeakSet<object>();
  let foundProxy = false;
  const collectProxyTargets = (current: object): void => {
    const raw = proxyToRaw.get(current);
    if (raw !== undefined) {
      foundProxy = true;
      proxyTargets.add(raw);
      return;
    }
    if (!isPlainObjectOrArray(current) || seen.has(current)) return;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) {
        const child = descriptor.value;
        if (typeof child === "object" && child !== null) {
          collectProxyTargets(child);
        }
      }
    }
  };
  collectProxyTargets(value);
  if (!foundProxy) return value;

  const clones = new WeakMap<object, object>();
  const clone = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current;
    const raw = proxyToRaw.get(current);
    if (raw !== undefined) return raw;
    if (!isPlainObjectOrArray(current) || proxyTargets.has(current)) return current;

    const cached = clones.get(current);
    if (cached !== undefined) return cached;
    const result: object = Array.isArray(current)
      ? new Array(current.length)
      : Object.create(Object.getPrototypeOf(current));
    clones.set(current, result);
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === "length") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined) continue;
      if ("value" in descriptor) descriptor.value = clone(descriptor.value);
      Reflect.defineProperty(result, key, descriptor);
    }
    return result;
  };

  return clone(value) as T;
}

function assertDeepDataGraph(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const seen = new WeakSet<object>();
  const visit = (current: object): void => {
    const raw = proxyToRaw.get(current) ?? current;
    if (!isPlainObjectOrArray(raw) || seen.has(raw)) return;
    seen.add(raw);
    assertExtensible(raw);
    assertDataProperties(raw);
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
      if (descriptor !== undefined && "value" in descriptor) {
        const child = descriptor.value;
        if (typeof child === "object" && child !== null) visit(child);
      }
    }
  };
  visit(value);
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
    return normalizeProxies(value);
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
    indices: Set<number>,
    key: PropertyKey,
  ): void => {
    if (getActiveSub() === undefined && !hasActiveRenderCollector()) return;
    if (isArrayIndex(key)) indices.add(Number(key));
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
    if (getActiveSub() === undefined && !hasActiveRenderCollector()) return;
    metadata.iteration ??= signal(0);
    metadata.iteration.value;
  };

  const notifyIteration = (metadata: PropertyMetadata): void => {
    if (metadata.iteration !== undefined) metadata.iteration.value += 1;
  };

  const notifyEveryMetadata = (
    target: object,
    callback: (metadata: PropertyMetadata) => void,
  ): void => {
    const metadatas = rawToAllMetadata.get(target);
    if (metadatas === undefined) return;
    for (const metadata of [...metadatas]) callback(metadata);
  };

  const notifyTruncatedIndices = (
    metadata: PropertyMetadata,
    currentLength: number,
    oldLength: number,
  ): void => {
    const truncatedCount = oldLength - currentLength;
    const trackedCount =
      metadata.propertyIndices.size + metadata.existenceIndices.size;
    if (trackedCount === 0) return;

    if (truncatedCount <= trackedCount) {
      for (let index = currentLength; index < oldLength; index++) {
        const key = String(index);
        notify(metadata.properties, key);
        notify(metadata.existence, key);
      }
      return;
    }
    for (const index of metadata.propertyIndices) {
      if (index >= currentLength && index < oldLength) {
        notify(metadata.properties, String(index));
      }
    }
    for (const index of metadata.existenceIndices) {
      if (index >= currentLength && index < oldLength) {
        notify(metadata.existence, String(index));
      }
    }
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
      propertyIndices: new Set(),
      existenceIndices: new Set(),
      arrayMethods: new Map(),
      proxy: undefined as unknown as object,
    };

    const proxy = new Proxy(rawValue, {
      get(target, key, receiver) {
        track(metadata.properties, metadata.propertyIndices, key);
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
        assertDeepDataGraph(rawNextValue);
        const succeeded = Reflect.set(target, key, rawNextValue, target);
        if (!succeeded) return false;

        const currentValue = Reflect.get(target, key, target);
        const existsNow = Reflect.has(target, key);
        const ownedNow = Object.prototype.hasOwnProperty.call(target, key);

        batch(() => {
          notifyEveryMetadata(target, (targetMetadata) => {
            if (!Object.is(oldValue, currentValue) || owned !== ownedNow) {
              notify(targetMetadata.properties, key);
            }
            if (existed !== existsNow) notify(targetMetadata.existence, key);
            if (owned !== ownedNow) notifyIteration(targetMetadata);

            if (Array.isArray(target) && oldLength !== undefined) {
              const currentLength = target.length;
              if (key !== "length" && oldLength !== currentLength) {
                notify(targetMetadata.properties, "length");
              }
              if (key === "length" && currentLength < oldLength) {
                notifyTruncatedIndices(targetMetadata, currentLength, oldLength);
                notifyIteration(targetMetadata);
              }
            }
          });
        });

        return true;
      },

      deleteProperty(target, key) {
        const existed = Reflect.has(target, key);
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const succeeded = Reflect.deleteProperty(target, key);
        if (!succeeded || !owned) return succeeded;

        batch(() => {
          notifyEveryMetadata(target, (targetMetadata) => {
            notify(targetMetadata.properties, key);
            if (existed !== Reflect.has(target, key)) {
              notify(targetMetadata.existence, key);
            }
            notifyIteration(targetMetadata);
          });
        });
        return true;
      },

      has(target, key) {
        track(metadata.existence, metadata.existenceIndices, key);
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
    let allMetadata = rawToAllMetadata.get(rawValue);
    if (allMetadata === undefined) {
      allMetadata = new Set();
      rawToAllMetadata.set(rawValue, allMetadata);
    }
    allMetadata.add(metadata);
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
    assertDeepDataGraph(rawValue);
    super.value = rawValue as T;
  }
}

/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
export function deepSignal<T extends object>(initialValue: T): DeepSignal<T> {
  const rawInitialValue = normalizeProxies(initialValue);
  assertRootValue(rawInitialValue);

  const context = createDeepContext();
  context.wrap(rawInitialValue);
  return registerSignal(new DeepSignalImpl(rawInitialValue as T, context));
}
