import { getActiveSub, getBatchDepth } from "alien-signals";
import {
  batch,
  isSignal,
  registerSignal,
  SIGNAL_BRAND,
  SignalImpl,
  signal,
} from "./base.js";
import type { Signal } from "./base.js";
import { hasActiveRenderCollector } from "./render-tracking.js";

/** A signal whose plain-object and array values are reactive by property. */
export interface DeepSignal<T extends object> extends Signal<T> {}

/**
 * Per-key version counter. Typed as the concrete implementation rather than
 * `Signal<number>` so the metadata sweep below can consult its
 * `hasSubscribers()` liveness check; these never escape into user code.
 */
type VersionSignal = SignalImpl<number>;

interface PropertyMetadata {
  properties: Map<PropertyKey, VersionSignal>;
  existence: Map<PropertyKey, VersionSignal>;
  propertyIndices: Set<number>;
  existenceIndices: Set<number>;
  iteration?: Signal<number>;
  arrayMethods: Map<
    PropertyKey,
    { method: (...args: unknown[]) => unknown; wrapper: (...args: unknown[]) => unknown }
  >;
  /**
   * Keys whose property has been removed (deleted, or truncated out of an
   * array) and whose version signals are therefore candidates for removal from
   * the maps above. Drained by `sweepPrunedKeys`; a key that still has a live
   * subscriber stays queued and is retried on the next sweep. Left `undefined`
   * until the first removal so the common append-only workload allocates
   * nothing extra.
   */
  prunable?: Set<PropertyKey> | undefined;
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
const readonlyMapViews = new WeakMap<Map<unknown, unknown>, ReadonlyMap<unknown, unknown>>();
const readonlySetViews = new WeakMap<Set<unknown>, ReadonlySet<unknown>>();
const readonlyCollectionViewToRaw = new WeakMap<object, Map<unknown, unknown> | Set<unknown>>();
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

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Resolves a value that may be one of our proxies or one of our readonly
 * collection views back to the raw object it wraps. Returns `undefined` when
 * `value` is not object-like or is not a value this module has wrapped, so
 * callers can fall back to using it as-is.
 */
function toRaw(value: unknown): object | undefined {
  if (!isObjectLike(value)) return undefined;
  const directRaw = proxyToRaw.get(value);
  if (directRaw !== undefined) return directRaw;
  return readonlyCollectionViewToRaw.get(value);
}

type RejectMutation = (operation: string) => () => never;

/**
 * Shared scaffolding for `readonlyMapView`/`readonlySetView`: cache lookup,
 * the "reject this mutation" factory, defining the descriptors, the
 * feature-detected extras loop, and the dual-WeakMap registration. Only the
 * per-type descriptor bodies (which truly differ between Map and Set) and
 * the extras list are supplied by the caller.
 */
function createReadonlyCollectionView<Raw extends object, View extends object>(
  raw: Raw,
  cache: WeakMap<Raw, View>,
  prototype: object,
  kind: string,
  buildCore: (raw: Raw, view: View, rejectMutation: RejectMutation) => Record<PropertyKey, PropertyDescriptor>,
  buildExtras: (raw: Raw, rejectMutation: RejectMutation) => Array<[string, (...args: unknown[]) => unknown]>,
): View {
  const cached = cache.get(raw);
  if (cached !== undefined) return cached;

  const view = Object.create(prototype) as View;
  const rejectMutation: RejectMutation = (operation: string) => () => {
    throw new TypeError(
      `deepSignal() ${kind}#${operation}() is not allowed through .value; replace the ${kind} immutably`,
    );
  };
  Object.defineProperties(view, buildCore(raw, view, rejectMutation));
  for (const [name, impl] of buildExtras(raw, rejectMutation)) {
    Object.defineProperty(view, name, { enumerable: false, configurable: false, value: impl });
  }

  cache.set(raw, view);
  readonlyCollectionViewToRaw.set(view, raw as Map<unknown, unknown> | Set<unknown>);
  return view;
}

function readonlyMapView<Key, Value>(raw: Map<Key, Value>): ReadonlyMap<Key, Value> {
  return createReadonlyCollectionView(
    raw as Map<unknown, unknown>,
    readonlyMapViews,
    Map.prototype,
    "Map",
    (target, view, rejectMutation) => ({
      size: { enumerable: false, configurable: false, get: () => target.size },
      get: { enumerable: false, configurable: false, value: (key: unknown) => target.get(key) },
      has: { enumerable: false, configurable: false, value: (key: unknown) => target.has(key) },
      entries: {
        enumerable: false,
        configurable: false,
        value: () => Map.prototype.entries.call(target),
      },
      keys: {
        enumerable: false,
        configurable: false,
        value: () => Map.prototype.keys.call(target),
      },
      values: {
        enumerable: false,
        configurable: false,
        value: () => Map.prototype.values.call(target),
      },
      forEach: {
        enumerable: false,
        configurable: false,
        value: (
          callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void,
          thisArg?: unknown,
        ) => {
          Map.prototype.forEach.call(target, (value, key) => callback.call(thisArg, value, key, view));
        },
      },
      [Symbol.iterator]: {
        enumerable: false,
        configurable: false,
        value: () => Map.prototype.entries.call(target),
      },
      set: { enumerable: false, configurable: false, value: rejectMutation("set") },
      delete: { enumerable: false, configurable: false, value: rejectMutation("delete") },
      clear: { enumerable: false, configurable: false, value: rejectMutation("clear") },
    }),
    (_target, rejectMutation) => {
      const extras: Array<[string, (...args: unknown[]) => unknown]> = [];
      // Keep future mutating Map proposals from becoming an integrity bypass when
      // they are present in the running JavaScript engine.
      for (const operation of ["getOrInsert", "getOrInsertComputed", "emplace"]) {
        if (typeof (Map.prototype as unknown as Record<string, unknown>)[operation] === "function") {
          extras.push([operation, rejectMutation(operation)]);
        }
      }
      return extras;
    },
  ) as ReadonlyMap<Key, Value>;
}

function readonlySetView<Value>(raw: Set<Value>): ReadonlySet<Value> {
  return createReadonlyCollectionView(
    raw as Set<unknown>,
    readonlySetViews,
    Set.prototype,
    "Set",
    (target, view, rejectMutation) => ({
      size: { enumerable: false, configurable: false, get: () => target.size },
      has: { enumerable: false, configurable: false, value: (value: unknown) => target.has(value) },
      entries: {
        enumerable: false,
        configurable: false,
        value: () => Set.prototype.entries.call(target),
      },
      keys: {
        enumerable: false,
        configurable: false,
        value: () => Set.prototype.keys.call(target),
      },
      values: {
        enumerable: false,
        configurable: false,
        value: () => Set.prototype.values.call(target),
      },
      forEach: {
        enumerable: false,
        configurable: false,
        value: (
          callback: (value: unknown, key: unknown, set: ReadonlySet<unknown>) => void,
          thisArg?: unknown,
        ) => {
          Set.prototype.forEach.call(target, (value) => callback.call(thisArg, value, value, view));
        },
      },
      [Symbol.iterator]: {
        enumerable: false,
        configurable: false,
        value: () => Set.prototype.values.call(target),
      },
      add: { enumerable: false, configurable: false, value: rejectMutation("add") },
      delete: { enumerable: false, configurable: false, value: rejectMutation("delete") },
      clear: { enumerable: false, configurable: false, value: rejectMutation("clear") },
    }),
    (target) => {
      const extras: Array<[string, (...args: unknown[]) => unknown]> = [];
      const forwardSetOperation = (operation: string) => (other: unknown) => {
        const method = (Set.prototype as unknown as Record<string, unknown>)[operation];
        if (typeof method !== "function") {
          throw new TypeError(`Set#${operation}() is unavailable in this JavaScript engine`);
        }
        const collection =
          isObjectLike(other) ? readonlyCollectionViewToRaw.get(other) ?? other : other;
        return Reflect.apply(method, target, [collection]);
      };
      // ES2025's Set operations are non-mutating. Forward them to the raw Set so
      // native methods receive their required internal-slot receiver. A second
      // deepSignal read-only view is unwrapped first because it is also set-like.
      for (const operation of [
        "union",
        "intersection",
        "difference",
        "symmetricDifference",
        "isSubsetOf",
        "isSupersetOf",
        "isDisjointFrom",
      ]) {
        if (typeof (Set.prototype as unknown as Record<string, unknown>)[operation] === "function") {
          extras.push([operation, forwardSetOperation(operation)]);
        }
      }
      return extras;
    },
  ) as ReadonlySet<Value>;
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
  if (!isObjectLike(value)) return false;
  // A value can be reachable both as reactive plain data and through an opaque
  // value. A proxy beneath an opaque value cannot be unwrapped without changing
  // that value's observable identity, so reject it instead of leaking a proxy
  // into the raw tree.
  const seen = new WeakMap<object, number>();
  const pending: Array<{ value: object; insideOpaque: boolean }> = [
    { value, insideOpaque: false },
  ];
  let needsNormalization = false;

  while (pending.length > 0) {
    const { value: current, insideOpaque } = pending.pop() as {
      value: object;
      insideOpaque: boolean;
    };
    const wrapperRaw = toRaw(current);
    if (wrapperRaw !== undefined) {
      if (insideOpaque) {
        throw new TypeError(
          proxyToRaw.has(current)
            ? "deepSignal() cannot store a deep proxy inside an opaque value"
            : "deepSignal() cannot store a deep collection view inside an opaque value",
        );
      }
      // The raw graph was validated when this proxy (or collection view) was
      // created. Do not walk it again: this makes `{ inner: state.value.large }`
      // proportional to the new carrier rather than the already-known subtree.
      needsNormalization = true;
      continue;
    }
    const raw = current;
    const visitedAs = seen.get(raw) ?? 0;
    const visitFlag = insideOpaque ? 2 : 1;
    if ((visitedAs & visitFlag) !== 0) continue;
    seen.set(raw, visitedAs | visitFlag);

    if (raw instanceof Map) {
      for (const [key, entry] of raw) {
        if (isObjectLike(key)) {
          pending.push({ value: key, insideOpaque: true });
        }
        if (isObjectLike(entry)) {
          pending.push({ value: entry, insideOpaque: true });
        }
      }
      continue;
    }
    if (raw instanceof Set) {
      for (const entry of raw) {
        if (isObjectLike(entry)) {
          pending.push({ value: entry, insideOpaque: true });
        }
      }
      continue;
    }
    if (!isPlainObjectOrArray(raw)) {
      // Class instances, Date, functions, and other opaque values retain their
      // identity. Inspect their own data descriptors without invoking getters
      // so a contained deep proxy cannot enter the raw graph.
      for (const key of Reflect.ownKeys(raw)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
        if (descriptor !== undefined && "value" in descriptor && isObjectLike(descriptor.value)) {
          pending.push({ value: descriptor.value, insideOpaque: true });
        }
      }
      continue;
    }

    if (!insideOpaque) {
      assertExtensible(raw);
      assertDataProperties(raw);
    }
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
      if (descriptor !== undefined && "value" in descriptor) {
        const child = descriptor.value;
        if (isObjectLike(child)) {
          pending.push({ value: child, insideOpaque });
        }
      }
    }
  }

  return needsNormalization;
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

    const wrapperRaw = toRaw(currentSource);
    if (wrapperRaw !== undefined) {
      if (wrapperRaw !== currentTarget) return false;
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
    // `entries()` rather than a plain index read so `key` is typed as a key
    // rather than `key | undefined`: `Reflect.ownKeys` returns a dense array,
    // so every index in range holds one, but only iteration says that in types.
    for (const [index, key] of sourceKeys.entries()) {
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

/**
 * An array of `length` with no own index properties — holes, not `undefined`s.
 * `Array.from({ length })` would materialize every index as an own property,
 * so cloning a sparse carrier produced an array with strictly more own keys
 * than its source. `matchesNormalizedGraph` compares own keys one-for-one, so
 * that clone could never match its source again: the carrier cache missed on
 * every re-assignment, breaking the documented guarantee that assigning the
 * same carrier twice preserves identity and aliasing.
 */
function emptyArrayOfLength(length: number): unknown[] {
  const result: unknown[] = [];
  result.length = length;
  return result;
}

function cloneWithoutProxies<T>(value: T): T {
  const wrapperRaw = toRaw(value);
  if (wrapperRaw !== undefined) return wrapperRaw as T;
  if (!isObjectLike(value)) return value;

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
    const resolvedRaw = toRaw(current);
    if (resolvedRaw !== undefined) return resolvedRaw;
    if (!isPlainObjectOrArray(current)) return current;

    const local = clones.get(current);
    if (local !== undefined) return local;

    const result: object = Array.isArray(current)
      ? emptyArrayOfLength(current.length)
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
  // Reassigning a value obtained from this deep signal is already known-good.
  // Avoid validating its entire graph again on this common O(1) path.
  const wrapperRaw = toRaw(value);
  if (wrapperRaw !== undefined) return wrapperRaw as T;
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

// `wrap`/`unwrap` and their helpers below have no per-call state: every map
// they touch (`rawToMetadata`, `proxyToRaw`, ...) is module-global, and each
// `PropertyMetadata` is threaded through explicit parameters. They are
// module-scoped functions rather than being re-allocated as closures on
// every `deepSignal()` call.

const unwrap = <T>(value: T): T => {
  return prepareDeepValue(value);
};

// Inherited members of the two prototypes a deep-signal target can have.
// Reading one of these through the proxy (`list.map`, `list[Symbol.iterator]`,
// `state.constructor`, ...) used to mint a permanent version signal for a key
// that can never change, so a single `.map()` per render leaked one entry per
// method name for the lifetime of the page. They are only skipped while the
// key is *not* an own property, so a real data property named `map` or
// `toString` — and an array's own `length` — stays fully reactive, and a
// null-prototype object (which inherits nothing) is never affected.
const OBJECT_PROTOTYPE_KEYS: ReadonlySet<PropertyKey> = new Set(
  Reflect.ownKeys(Object.prototype),
);
const ARRAY_PROTOTYPE_KEYS: ReadonlySet<PropertyKey> = new Set([
  ...Reflect.ownKeys(Object.prototype),
  ...Reflect.ownKeys(Array.prototype),
]);

const isInheritedPrototypeMember = (target: object, key: PropertyKey): boolean => {
  if (Object.prototype.hasOwnProperty.call(target, key)) return false;
  const prototype = Object.getPrototypeOf(target) as object | null;
  if (prototype === Object.prototype) return OBJECT_PROTOTYPE_KEYS.has(key);
  if (prototype === Array.prototype) return ARRAY_PROTOTYPE_KEYS.has(key);
  return false;
};

const getVersion = (
  versions: Map<PropertyKey, VersionSignal>,
  key: PropertyKey,
): VersionSignal => {
  let version = versions.get(key);
  if (version === undefined) {
    version = registerSignal(new SignalImpl<number>(0));
    versions.set(key, version);
  }
  return version;
};

const track = (
  target: object,
  versions: Map<PropertyKey, VersionSignal>,
  indices: Set<number>,
  key: PropertyKey,
): void => {
  if (getActiveSub() === undefined && !hasActiveRenderCollector()) return;
  if (isInheritedPrototypeMember(target, key)) return;
  if (isArrayIndex(key)) indices.add(Number(key));
  const version = getVersion(versions, key);
  // Records that something reactive depends on this key right now, which is
  // what keeps `sweepPrunedKeys` from dropping it out from under a subscriber.
  version.markWatched();
  version.value;
};

const notify = (
  versions: Map<PropertyKey, VersionSignal>,
  key: PropertyKey,
): void => {
  const version = versions.get(key);
  if (version !== undefined) version.value += 1;
};

/**
 * Queues `key`'s version signals for removal once nothing depends on them.
 * Only called for a key that has just been removed *and* notified, which is
 * what makes the eventual removal safe: the notification forces every
 * subscriber to re-run, so one that still cares re-reads the key (re-arming
 * `markWatched`) and one that does not has already been unlinked.
 */
const markPrunable = (metadata: PropertyMetadata, key: PropertyKey): void => {
  if (!metadata.properties.has(key) && !metadata.existence.has(key)) return;
  (metadata.prunable ??= new Set()).add(key);
};

/**
 * Drops the version signals of removed keys once they have no subscribers
 * left, so a virtualized or repeatedly-spliced list stops accumulating one
 * entry per key that ever existed.
 *
 * Runs only at batch depth 0, where the write that queued these keys has
 * already flushed its effects; before that, `hasSubscribers()` would still
 * report the pre-flush picture. A key that is still subscribed (typically a
 * React store whose re-render has not committed yet) stays queued and is
 * reconsidered on the next sweep rather than being dropped early.
 */
const sweepPrunedKeys = (metadata: PropertyMetadata, target: object): void => {
  const prunable = metadata.prunable;
  if (prunable === undefined || prunable.size === 0) return;
  if (getBatchDepth() !== 0) return;

  for (const key of prunable) {
    // The key came back (an index was written again, a property re-added):
    // its version signals are live metadata again, not garbage.
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      prunable.delete(key);
      continue;
    }
    const property = metadata.properties.get(key);
    const existence = metadata.existence.get(key);
    if (property?.hasSubscribers() === true || existence?.hasSubscribers() === true) {
      continue;
    }
    metadata.properties.delete(key);
    metadata.existence.delete(key);
    if (isArrayIndex(key)) {
      const index = Number(key);
      metadata.propertyIndices.delete(index);
      metadata.existenceIndices.delete(index);
    }
    prunable.delete(key);
  }

  if (prunable.size === 0) metadata.prunable = undefined;
};

const trackIteration = (metadata: PropertyMetadata): void => {
  if (getActiveSub() === undefined && !hasActiveRenderCollector()) return;
  metadata.iteration ??= signal(0);
  metadata.iteration.value;
};

const notifyIteration = (metadata: PropertyMetadata): void => {
  if (metadata.iteration !== undefined) metadata.iteration.value += 1;
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
      markPrunable(metadata, key);
    }
    return;
  }
  for (const index of metadata.propertyIndices) {
    if (index >= currentLength && index < oldLength) {
      const key = String(index);
      notify(metadata.properties, key);
      markPrunable(metadata, key);
    }
  }
  for (const index of metadata.existenceIndices) {
    if (index >= currentLength && index < oldLength) {
      const key = String(index);
      notify(metadata.existence, key);
      markPrunable(metadata, key);
    }
  }
};

/**
 * Whether `wrap()` would hand back something other than `value` itself — a
 * deep proxy for a plain object/array, or a readonly view for a Map/Set. The
 * `get` trap uses this to reject a non-configurable, non-writable property
 * whose value cannot be substituted, before `wrap()` performs the swap.
 */
const isWrappedByValue = (value: unknown): boolean =>
  isPlainObjectOrArray(value) || value instanceof Map || value instanceof Set;

const wrap = <T>(value: T): T => {
  const rawValue = (toRaw(value) as T | undefined) ?? value;
  if (rawValue instanceof Map) return readonlyMapView(rawValue) as T;
  if (rawValue instanceof Set) return readonlySetView(rawValue) as T;
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
      // Deep state is raw data, never a signal. Answering the identity probe
      // up front keeps `isSignal()` on a nested proxy from allocating a
      // version signal for a key that can never change. An own brand only
      // exists if a raw reference bypassed this proxy, and it is reported so
      // the proxy invariants hold.
      if (key === SIGNAL_BRAND && !Object.prototype.hasOwnProperty.call(target, key)) {
        return undefined;
      }
      track(target, metadata.properties, metadata.propertyIndices, key);
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
          try {
            return batch(() => Reflect.apply(method, this, args));
          } finally {
            sweepPrunedKeys(metadata, target);
          }
        };
        metadata.arrayMethods.set(key, { method, wrapper });
        return wrapper;
      }

      // Checked before `wrap()` substitutes anything: `wrap()` also swaps a
      // Map/Set for a readonly view, and those views are just as unassignable
      // back through a non-configurable, non-writable slot as a nested proxy
      // is. Gating this on `isPlainObjectOrArray(result)` let a frozen
      // Map/Set-valued property past the friendly error and into a raw engine
      // `TypeError` later on.
      if (isWrappedByValue(result)) {
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
      // Storing the brand would make this subtree answer `isSignal()`, which
      // silently stops it from being wrapped and kills its reactivity.
      if (key === SIGNAL_BRAND) {
        throw new TypeError("deepSignal() does not support branding state as a signal");
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
            notifyTruncatedIndices(metadata, currentLength, oldLength);
            notifyIteration(metadata);
          }
        }
      });
      sweepPrunedKeys(metadata, target);

      return true;
    },

    deleteProperty(target, key) {
      const existed = Reflect.has(target, key);
      const owned = Object.prototype.hasOwnProperty.call(target, key);
      const succeeded = Reflect.deleteProperty(target, key);
      if (!succeeded || !owned) return succeeded;

      batch(() => {
        notify(metadata.properties, key);
        if (existed !== Reflect.has(target, key)) {
          notify(metadata.existence, key);
        }
        notifyIteration(metadata);
        markPrunable(metadata, key);
      });
      sweepPrunedKeys(metadata, target);
      return true;
    },

    has(target, key) {
      track(target, metadata.existence, metadata.existenceIndices, key);
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

class DeepSignalImpl<T extends object> implements DeepSignal<T> {
  readonly #source: SignalImpl<T>;

  constructor(initialValue: T) {
    this.#source = new SignalImpl(initialValue);
  }

  get value(): T {
    // Runtime collection views intentionally keep the established `.value: T`
    // public type. `DeepSignal<T>` must remain assignable to `Signal<T>`.
    return wrap(this.#source.value) as T;
  }

  set value(nextValue: T) {
    const rawValue = unwrap(nextValue);
    assertRootValue(rawValue);
    this.#source.value = rawValue as T;
  }

  peek(): T {
    return this.#source.peek();
  }
}

/**
 * Reports the per-key reactive metadata currently retained for a deep proxy
 * (or for the raw object behind it). Exposed for this package's own tests
 * only — it is deliberately absent from every published entry point, and the
 * shape it returns is internal detail, not API.
 */
export function inspectDeepSignalMetadata(value: object): {
  properties: PropertyKey[];
  existence: PropertyKey[];
  propertyIndices: number[];
  existenceIndices: number[];
} | undefined {
  const metadata = rawToMetadata.get(toRaw(value) ?? value);
  if (metadata === undefined) return undefined;
  return {
    properties: [...metadata.properties.keys()],
    existence: [...metadata.existence.keys()],
    propertyIndices: [...metadata.propertyIndices],
    existenceIndices: [...metadata.existenceIndices],
  };
}

/**
 * Creates a signal that lazily tracks nested plain-object and array properties.
 * Mutations must go through `.value`; changes made through the original raw
 * object are intentionally not observable.
 */
export function deepSignal<T extends object>(initialValue: T): DeepSignal<T> {
  const rawInitialValue = prepareDeepValue(initialValue);
  assertRootValue(rawInitialValue);

  wrap(rawInitialValue);
  return registerSignal(new DeepSignalImpl(rawInitialValue as T)) as DeepSignal<T>;
}
