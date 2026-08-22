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
const rawToMetadata = new WeakMap<object, PropertyMetadata>();
// A carrier that contains one of our proxies has to be copied before it can be
// stored. Remember that copy so assigning the same carrier again preserves the
// same identity and aliases, just like assigning an ordinary raw object does.
const normalizedProxyCarriers = new WeakMap<object, object>();

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

function assertDeepDataGraph(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  // A value can be reachable both as reactive plain data and through an opaque
  // collection. Keep those traversals distinct: a proxy under Map/Set cannot be
  // unwrapped without changing the collection, so it must be rejected instead.
  const seen = new WeakMap<object, number>();
  const pending: Array<{ value: object; insideCollection: boolean }> = [
    { value, insideCollection: false },
  ];
  let containsProxy = false;

  while (pending.length > 0) {
    const { value: current, insideCollection } = pending.pop() as {
      value: object;
      insideCollection: boolean;
    };
    const directRaw = proxyToRaw.get(current);
    if (directRaw !== undefined) {
      if (insideCollection) {
        throw new TypeError(
          "deepSignal() cannot store a deep proxy inside a Map or Set",
        );
      }
      containsProxy = true;
    }
    const raw = directRaw ?? current;
    const visitedAs = seen.get(raw) ?? 0;
    const visitFlag = insideCollection ? 2 : 1;
    if ((visitedAs & visitFlag) !== 0) continue;
    seen.set(raw, visitedAs | visitFlag);

    if (raw instanceof Map) {
      for (const [key, entry] of raw) {
        if (typeof key === "object" && key !== null) {
          pending.push({ value: key, insideCollection: true });
        }
        if (typeof entry === "object" && entry !== null) {
          pending.push({ value: entry, insideCollection: true });
        }
      }
      continue;
    }
    if (raw instanceof Set) {
      for (const entry of raw) {
        if (typeof entry === "object" && entry !== null) {
          pending.push({ value: entry, insideCollection: true });
        }
      }
      continue;
    }
    if (!isPlainObjectOrArray(raw)) continue;

    if (!insideCollection) {
      assertExtensible(raw);
      assertDataProperties(raw);
    }
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
      if (descriptor !== undefined && "value" in descriptor) {
        const child = descriptor.value;
        if (typeof child === "object" && child !== null) {
          pending.push({ value: child, insideCollection });
        }
      }
    }
  }

  return containsProxy;
}

function matchesNormalizedGraph(source: object, normalized: object): boolean {
  const sources = new WeakMap<object, object>();
  const targets = new WeakMap<object, object>();
  const pending: Array<[unknown, unknown]> = [[source, normalized]];

  while (pending.length > 0) {
    const [currentSource, currentTarget] = pending.pop() as [unknown, unknown];
    if (typeof currentSource !== "object" || currentSource === null) {
      if (!Object.is(currentSource, currentTarget)) return false;
      continue;
    }

    const directRaw = proxyToRaw.get(currentSource);
    if (directRaw !== undefined) {
      if (directRaw !== currentTarget) return false;
      continue;
    }
    if (!isPlainObjectOrArray(currentSource)) {
      if (currentSource !== currentTarget) return false;
      continue;
    }
    if (
      typeof currentTarget !== "object" ||
      currentTarget === null ||
      !isPlainObjectOrArray(currentTarget)
    ) {
      return false;
    }

    const knownTarget = sources.get(currentSource);
    if (knownTarget !== undefined) {
      if (knownTarget !== currentTarget) return false;
      continue;
    }
    const knownSource = targets.get(currentTarget);
    if (knownSource !== undefined && knownSource !== currentSource) return false;
    sources.set(currentSource, currentTarget);
    targets.set(currentTarget, currentSource);

    if (
      Array.isArray(currentSource) !== Array.isArray(currentTarget) ||
      Object.getPrototypeOf(currentSource) !== Object.getPrototypeOf(currentTarget)
    ) {
      return false;
    }
    const sourceKeys = Reflect.ownKeys(currentSource);
    const targetKeys = Reflect.ownKeys(currentTarget);
    if (sourceKeys.length !== targetKeys.length) return false;
    for (let index = 0; index < sourceKeys.length; index++) {
      const key = sourceKeys[index];
      if (key !== targetKeys[index]) return false;
      const sourceDescriptor = Reflect.getOwnPropertyDescriptor(currentSource, key);
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(currentTarget, key);
      if (
        sourceDescriptor === undefined ||
        targetDescriptor === undefined ||
        !("value" in sourceDescriptor) ||
        !("value" in targetDescriptor) ||
        sourceDescriptor.configurable !== targetDescriptor.configurable ||
        sourceDescriptor.enumerable !== targetDescriptor.enumerable ||
        sourceDescriptor.writable !== targetDescriptor.writable
      ) {
        return false;
      }
      pending.push([sourceDescriptor.value, targetDescriptor.value]);
    }
  }

  return true;
}

function cloneWithoutProxies<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const directRaw = proxyToRaw.get(value);
  if (directRaw !== undefined) return directRaw as T;

  const cachedRoot = normalizedProxyCarriers.get(value);
  if (
    cachedRoot !== undefined &&
    matchesNormalizedGraph(value, cachedRoot)
  ) {
    return cachedRoot as T;
  }

  const clones = new WeakMap<object, object>();
  const created: Array<[object, object]> = [];
  const pending: object[] = [];

  const resolve = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current;
    const raw = proxyToRaw.get(current);
    if (raw !== undefined) return raw;
    if (!isPlainObjectOrArray(current)) return current;

    const local = clones.get(current);
    if (local !== undefined) return local;

    const result: object = Array.isArray(current)
      ? new Array(current.length)
      : Object.create(Object.getPrototypeOf(current));
    clones.set(current, result);
    created.push([current, result]);
    pending.push(current);
    return result;
  };

  const root = resolve(value) as T;
  while (pending.length > 0) {
    const source = pending.pop() as object;
    const target = clones.get(source) as object;
    for (const key of Reflect.ownKeys(source)) {
      if (Array.isArray(source) && key === "length") continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined) continue;
      // Validation has already rejected accessors, before any clone is exposed.
      if (!("value" in descriptor)) {
        throw new TypeError("deepSignal() does not support accessor properties");
      }
      descriptor.value = resolve(descriptor.value);
      Reflect.defineProperty(target, key, descriptor);
    }
  }

  for (const [source, target] of created) {
    normalizedProxyCarriers.set(source, target);
  }
  return root;
}

function prepareDeepValue<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    const directRaw = proxyToRaw.get(value);
    // Reassigning a value obtained from this deep signal is already known-good.
    // Avoid validating its entire graph again on this common O(1) path.
    if (directRaw !== undefined) return directRaw as T;
  }
  const containsProxy = assertDeepDataGraph(value);
  return containsProxy ? cloneWithoutProxies(value) : value;
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
  const unwrap = <T>(value: T): T => {
    return prepareDeepValue(value);
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
    const metadata = rawToMetadata.get(target);
    if (metadata !== undefined) callback(metadata);
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
    const rawValue =
      typeof value === "object" && value !== null
        ? (proxyToRaw.get(value) as T | undefined) ?? value
        : value;
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
    super.value = rawValue as T;
  }
}

/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
export function deepSignal<T extends object>(initialValue: T): DeepSignal<T> {
  const rawInitialValue = prepareDeepValue(initialValue);
  assertRootValue(rawInitialValue);

  const context = createDeepContext();
  context.wrap(rawInitialValue);
  return registerSignal(new DeepSignalImpl(rawInitialValue as T, context));
}
