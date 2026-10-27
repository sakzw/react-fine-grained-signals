import { delegateSubscription } from "./readable-subscription.js";
import { hasActiveRenderCollector } from "./render-tracking.js";
import { SIGNAL_BRAND } from "./signal-brand.js";

export interface DeepSignalSource<T> {
  value: T;
  peek(): T;
}

export interface DeepSignalLike<T extends object> {
  value: T;
  peek(): T;
}

export interface DeepSignalRuntimeAdapter {
  /** Creates the root source behind the public DeepSignal wrapper. */
  createSignal<T>(initial: T): DeepSignalSource<T>;
  /** Creates an internal property/existence/iteration version source. */
  createVersionSignal<T>(initial: T): DeepSignalSource<T>;
  /** Called after the last linked graph subscriber detaches from a version source. */
  onUnwatched?(source: DeepSignalSource<unknown>, callback: () => void): void;
  markWatched(source: DeepSignalSource<unknown>): void;
  hasSubscribers(source: DeepSignalSource<unknown>): boolean;
  /** Graph links only, ignoring the watched flag; defaults to `hasSubscribers`. */
  hasLinkedSubscribers?(source: DeepSignalSource<unknown>): boolean;
  batch<T>(callback: () => T): T;
  /** Runs a callback without collecting dependencies, as the public `untracked`. */
  untracked<T>(callback: () => T): T;
  isSignal(value: unknown): boolean;
  hasActiveSubscriber(): boolean;
  getBatchDepth(): number;
  registerDeepSignal?(value: DeepSignalLike<object>): void;
  /** Optional execution-owner hooks for alternate internal runtime adapters. */
  isSpeculative?(): boolean;
  markSpeculativeDeepRead?(): void;
}

/**
 * What `deepCollectionSignal` adds to the engine: reactive proxies for Map,
 * Set, WeakMap and WeakSet. `undefined` everywhere means the plain mode of
 * `deepSignal`, where those collections are opaque values. The object itself
 * is the mode: a plain object or array carries the one it was first wrapped
 * with, and reaching it through the other mode throws.
 */
export interface CollectionSupport {
  /** The brand of a standard collection, including one from another realm or with a replaced prototype. */
  kindOf(value: unknown): "Map" | "Set" | "WeakMap" | "WeakSet" | undefined;
  isStandard(value: unknown): boolean;
  /** `isStandard` for a value already known not to be plain data. */
  isStandardPrototype(value: object): boolean;
  assertReactive(value: object): void;
  proxyFor(raw: object): object;
  inspect(value: object): { values: unknown[]; existence: unknown[]; members: unknown[] } | undefined;
}

/** Engine internals the collection module builds on. */
export interface CollectionContext {
  readonly adapter: DeepSignalRuntimeAdapter;
  shouldTrackDeepRead(): boolean;
  toRaw(value: unknown): object | undefined;
  readonly proxyToRaw: WeakMap<object, object>;
  readonly normalizedProxyCarriers: WeakMap<object, object>;
  isPlainObjectOrArray(value: unknown): value is object;
  prepareDeepValue<T>(value: T, support: CollectionSupport | undefined): T;
  wrap<T>(value: T, support: CollectionSupport | undefined): T;
}

interface PropertyMetadata {
  /** The mode this object was first wrapped in; `undefined` is plain `deepSignal`. */
  support: CollectionSupport | undefined;
  properties: Map<PropertyKey, VersionSignal>;
  existence: Map<PropertyKey, VersionSignal>;
  propertyIndices: Set<number>;
  existenceIndices: Set<number>;
  iteration?: DeepSignalSource<number>;
  arrayMethods: Map<PropertyKey, { method: (...args: unknown[]) => unknown; wrapper: (...args: unknown[]) => unknown }>;
  prunable?: Set<PropertyKey> | undefined;
  prunableRevision?: number | undefined;
  prunableSweepIterator?: Iterator<PropertyKey> | undefined;
  prunableSweepRevision?: number | undefined;
  prunableSweepDeferred?: boolean | undefined;
  prunableSweepSettled?: boolean | undefined;
  onUnwatched?: (() => void) | undefined;
  proxy: object;
}

type VersionSignal = DeepSignalSource<number>;

export function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
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

function emptyArrayOfLength(length: number): unknown[] {
  const result: unknown[] = [];
  result.length = length;
  return result;
}

function isArrayIndex(key: PropertyKey): key is string {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key;
}

const notify = (versions: Map<PropertyKey, VersionSignal>, key: PropertyKey): void => {
  const version = versions.get(key);
  if (version !== undefined) version.value += 1;
};

const queuePrunable = (metadata: PropertyMetadata, key: PropertyKey): void => {
  (metadata.prunable ??= new Set()).add(key);
  metadata.prunableRevision = (metadata.prunableRevision ?? 0) + 1;
};

const markPrunable = (metadata: PropertyMetadata, key: PropertyKey): void => {
  if (!metadata.properties.has(key) && !metadata.existence.has(key)) return;
  queuePrunable(metadata, key);
};

const notifyIteration = (metadata: PropertyMetadata): void => {
  if (metadata.iteration !== undefined) metadata.iteration.value += 1;
};

export function createDeepSignalFactory(adapter: DeepSignalRuntimeAdapter) {
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
  const ARRAY_SEARCHES = new Set<PropertyKey>(["includes", "indexOf", "lastIndexOf"]);
  const proxyToRaw = new WeakMap<object, object>();
  const rawToMetadata = new WeakMap<object, PropertyMetadata>();
  const scheduledPropertySweeps = new WeakSet<PropertyMetadata>();
  // A carrier that contains one of our proxies has to be copied before it can be
  // stored. Remember that copy so assigning the same carrier again preserves the
  // same identity and aliases, just like assigning an ordinary raw object does.
  const normalizedProxyCarriers = new WeakMap<object, object>();
  // The mode each cached carrier copy was made for; `null` is plain `deepSignal`.
  const carrierSupports = new WeakMap<object, CollectionSupport | null>();
  let collectionSupport: CollectionSupport | undefined;
  const isSpeculative = adapter.isSpeculative ?? (() => false);
  const markSpeculativeDeepRead = adapter.markSpeculativeDeepRead ?? (() => {});

  function shouldTrackDeepRead(): boolean {
    if (isSpeculative()) {
      // No per-key metadata during speculation; the computed's speculative
      // result must therefore not be promoted as a complete graph cache.
      markSpeculativeDeepRead();
      return false;
    }
    return adapter.hasActiveSubscriber() || hasActiveRenderCollector();
  }

  /**
   * The realm's built-in prototype objects, rejected deliberately rather than by
   * accident. Several of them look exactly like plain data to the rest of this
   * module: `Array.prototype` is array-exotic (so `Array.isArray` short-circuits
   * the prototype check below), while `Error.prototype`, `Date.prototype`,
   * `Promise.prototype`, `String.prototype`, ... all inherit straight from
   * `Object.prototype` and expose only extensible, writable data properties, so
   * neither `assertExtensible` nor `assertDataProperties` stops them. Adopting
   * one as deep state would let the `set` trap `Reflect.set` onto the real,
   * globally shared intrinsic. Some of them (`Object.prototype.__proto__`,
   * `Map.prototype.size`, ...) happen to be caught today by the accessor check,
   * but that protection is incidental and asymmetric; this set makes it uniform.
   *
   * Built from `globalThis` so an engine missing a builtin simply contributes
   * nothing. Only this realm's intrinsics are listed: an object from another
   * realm already fails the `Object.prototype` identity check below (the one
   * exception being a cross-realm array, which stays accepted as it is today).
   */
  const INTRINSIC_PROTOTYPES: ReadonlySet<object> = (() => {
    const prototypes = new Set<object>();
    for (const name of [
      "Object",
      "Array",
      "Function",
      "Boolean",
      "Number",
      "String",
      "Symbol",
      "BigInt",
      "Date",
      "RegExp",
      "Error",
      "AggregateError",
      "EvalError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "TypeError",
      "URIError",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "WeakRef",
      "FinalizationRegistry",
      "Promise",
      "ArrayBuffer",
      "SharedArrayBuffer",
      "DataView",
    ]) {
      const intrinsic = (globalThis as unknown as Record<string, unknown>)[name];
      if (typeof intrinsic !== "function") continue;
      const prototype: unknown = (intrinsic as { prototype?: unknown }).prototype;
      if ((typeof prototype === "object" && prototype !== null) || typeof prototype === "function") {
        prototypes.add(prototype as object);
      }
    }
    return prototypes;
  })();

  const isIntrinsicPrototype = (value: unknown): boolean => isObjectLike(value) && INTRINSIC_PROTOTYPES.has(value);

  function isPlainObjectOrArray(value: unknown): value is object {
    if (typeof value !== "object" || value === null || adapter.isSignal(value)) return false;
    // Before `Array.isArray`, which would otherwise wave `Array.prototype`
    // through: it is array-exotic, extensible, and carries only data properties.
    if (INTRINSIC_PROTOTYPES.has(value)) return false;
    if (Array.isArray(value)) return true;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  /**
   * Resolves a value that may be one of our proxies back to the raw object it
   * wraps. Returns `undefined` when
   * `value` is not object-like or is not a value this module has wrapped, so
   * callers can fall back to using it as-is.
   */
  function toRaw(value: unknown): object | undefined {
    if (!isObjectLike(value)) return undefined;
    return proxyToRaw.get(value);
  }

  function assertRootValue(value: unknown, support: CollectionSupport | undefined): asserts value is object {
    if (isPlainObjectOrArray(value)) return;
    if (support !== undefined) {
      if (support.isStandard(value)) {
        support.assertReactive(value as object);
        return;
      }
      throw new TypeError(
        "deepCollectionSignal() only accepts plain objects, arrays, or same-realm standard collections",
      );
    }
    if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
      throw new TypeError(
        "deepSignal() does not track Map, Set, WeakMap or WeakSet; use deepCollectionSignal() for a collection root",
      );
    }
    throw new TypeError("deepSignal() only accepts plain objects and arrays");
  }

  const modeError = (): TypeError =>
    new TypeError(
      "deepSignal() and deepCollectionSignal() cannot share the same plain object or array; keep each object in one kind of signal",
    );

  function assertDeepDataGraph(value: unknown, support: CollectionSupport | undefined): boolean {
    if (!isObjectLike(value)) return false;
    // A value can be reachable both as reactive plain data and through an opaque
    // value. A proxy beneath an opaque value cannot be unwrapped without changing
    // that value's observable identity, so reject it instead of leaking a proxy
    // into the raw tree.
    const seen = new WeakMap<object, number>();
    const pending: Array<{ value: object; insideOpaque: boolean }> = [{ value, insideOpaque: false }];
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
        // A proxy that is only a carrier's member is not caught by the check in
        // `prepareDeepValue`, which looks at the assigned value itself.
        const wrapped = rawToMetadata.get(wrapperRaw);
        if (wrapped !== undefined && wrapped.support !== support) throw modeError();
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

      // A built-in prototype adopted as reactive data would be written through
      // by the `set` trap, landing on the realm's shared intrinsic. Reject it
      // here, ahead of every branch below, so the diagnosis is the same for
      // `Array.prototype` (which nothing else catches) and for `Object.prototype`
      // (which only trips the accessor check by accident). Values reached
      // *through* an opaque one are exempt: they are never proxied and never
      // written to, and `{ ctor: Array }` reaches `Array.prototype` that way.
      if (!insideOpaque && isIntrinsicPrototype(raw)) {
        throw new TypeError("deepSignal() cannot store a built-in prototype object in deep state");
      }

      if (support !== undefined && !insideOpaque && support.kindOf(raw) !== undefined && !support.isStandard(raw)) {
        throw new TypeError("deepSignal() collections require same-realm standard collections");
      }

      // Without collection support a Map or Set is an opaque value like a
      // Date: its entries are only inspected so a deep proxy cannot slip into
      // the raw graph through one.
      if (raw instanceof Map) {
        const opaque = insideOpaque || support === undefined;
        if (!opaque) support.assertReactive(raw);
        for (const [key, entry] of raw) {
          if (isObjectLike(key)) {
            pending.push({ value: key, insideOpaque: opaque });
          }
          if (isObjectLike(entry)) {
            pending.push({ value: entry, insideOpaque: opaque });
          }
        }
        continue;
      }
      if (raw instanceof Set) {
        const opaque = insideOpaque || support === undefined;
        if (!opaque) support.assertReactive(raw);
        for (const entry of raw) {
          if (isObjectLike(entry)) {
            pending.push({ value: entry, insideOpaque: opaque });
          }
        }
        continue;
      }
      if (raw instanceof WeakMap || raw instanceof WeakSet) {
        if (!insideOpaque && support !== undefined) support.assertReactive(raw);
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
        // A raw object another kind of signal already wrapped (for example one
        // handed out by `peek()`) cannot be adopted here either.
        const existing = rawToMetadata.get(raw);
        if (existing !== undefined && existing.support !== support) throw modeError();
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

  function matchesNormalizedGraph(source: object, normalized: object, support: CollectionSupport | undefined): boolean {
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
      const sourceIsMap = support !== undefined && currentSource instanceof Map;
      const sourceIsSet = support !== undefined && currentSource instanceof Set;
      if (sourceIsMap || sourceIsSet) {
        if (typeof currentTarget !== "object" || currentTarget === null) return false;
        const targetCollection = currentTarget as object;
        if (sourceIsMap ? !(targetCollection instanceof Map) : !(targetCollection instanceof Set)) return false;
        const knownTarget = sources.get(currentSource);
        if (knownTarget !== undefined) {
          if (knownTarget !== targetCollection) return false;
          continue;
        }
        const knownSource = targets.get(targetCollection);
        if (knownSource !== undefined && knownSource !== currentSource) return false;
        sources.set(currentSource, targetCollection);
        targets.set(targetCollection, currentSource);
        if (sourceIsMap) {
          const sourceEntries = [...(currentSource as Map<unknown, unknown>)];
          const targetEntries = [...(targetCollection as Map<unknown, unknown>)];
          if (sourceEntries.length !== targetEntries.length) return false;
          for (let index = 0; index < sourceEntries.length; index++) {
            const sourceEntry = sourceEntries[index] as [unknown, unknown];
            const targetEntry = targetEntries[index] as [unknown, unknown];
            pending.push([sourceEntry[0], targetEntry[0]], [sourceEntry[1], targetEntry[1]]);
          }
        } else {
          const sourceValues = [...(currentSource as Set<unknown>)];
          const targetValues = [...(targetCollection as Set<unknown>)];
          if (sourceValues.length !== targetValues.length) return false;
          for (let index = 0; index < sourceValues.length; index++) {
            pending.push([sourceValues[index], targetValues[index]]);
          }
        }
        continue;
      }
      if (!isPlainObjectOrArray(currentSource)) {
        if (currentSource !== currentTarget) return false;
        continue;
      }
      if (typeof currentTarget !== "object" || currentTarget === null || !isPlainObjectOrArray(currentTarget)) {
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
  function cloneReactiveGraph<T>(value: T, support: CollectionSupport | undefined): T {
    const clones = new WeakMap<object, object>();
    const created: Array<[object, object]> = [];
    const pending: object[] = [];
    const resolve = (current: unknown): unknown => {
      // A proxy is already an identity-bearing reference to a known raw node.
      // Keep that raw identity instead of cloning it; this preserves aliases
      // from the existing deep graph when a proxy is placed in a new carrier.
      const raw = toRaw(current);
      if (raw !== undefined) return raw;
      if (!isObjectLike(current)) return current;
      if (current instanceof WeakMap || current instanceof WeakSet) return current;
      const plain = isPlainObjectOrArray(current);
      const map = support !== undefined && current instanceof Map;
      const set = support !== undefined && current instanceof Set;
      if (!plain && !map && !set) return current;
      const found = clones.get(current);
      if (found !== undefined) return found;
      const clone: object = map
        ? new Map()
        : set
          ? new Set()
          : Array.isArray(current)
            ? emptyArrayOfLength(current.length)
            : Object.create(Object.getPrototypeOf(current));
      clones.set(current, clone);
      created.push([current, clone]);
      pending.push(current);
      return clone;
    };
    const resolveCollectionEntry = (current: unknown): unknown => {
      const raw = toRaw(current);
      if (raw !== undefined) return raw;
      if (!isObjectLike(current)) return current;
      // Collection keys and values that are already raw keep their identity.
      // If an entry is itself a carrier containing a proxy, clone that carrier
      // so no proxy can be stored in the raw collection graph.
      return assertDeepDataGraph(current, support) ? resolve(current) : current;
    };
    const root = resolve(value) as T;
    while (pending.length > 0) {
      const source = pending.pop() as object;
      const target = clones.get(source) as object;
      if (source instanceof Map && target instanceof Map) {
        for (const [key, entry] of source) {
          const normalizedKey = resolveCollectionEntry(key);
          if (target.has(normalizedKey))
            throw new TypeError("deepSignal() collection keys collide after proxy normalization");
          target.set(normalizedKey, resolveCollectionEntry(entry));
        }
      } else if (source instanceof Set && target instanceof Set) {
        for (const entry of source) {
          const normalized = resolveCollectionEntry(entry);
          if (target.has(normalized)) throw new TypeError("deepSignal() Set members collide after proxy normalization");
          target.add(normalized);
        }
      } else {
        for (const key of Reflect.ownKeys(source)) {
          if (Array.isArray(source) && key === "length") continue;
          const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
          if (descriptor === undefined) continue;
          if (!("value" in descriptor)) throw new TypeError("deepSignal() does not support accessor properties");
          descriptor.value = resolve(descriptor.value);
          Reflect.defineProperty(target, key, descriptor);
        }
      }
    }
    for (const [source, target] of created) {
      normalizedProxyCarriers.set(source, target);
      carrierSupports.set(source, support ?? null);
    }
    return root;
  }

  function prepareDeepValue<T>(value: T, support: CollectionSupport | undefined): T {
    // Reassigning a value obtained from this deep signal is already known-good.
    // Avoid validating its entire graph again on this common O(1) path.
    const wrapperRaw = toRaw(value);
    if (wrapperRaw !== undefined) {
      // A proxy from the other kind of signal would put an object of the wrong
      // mode into this state, so refuse it where it is assigned.
      const existing = rawToMetadata.get(wrapperRaw);
      if (existing !== undefined && existing.support !== support) throw modeError();
      return wrapperRaw as T;
    }
    if (isObjectLike(value)) {
      const cached = normalizedProxyCarriers.get(value);
      if (
        cached !== undefined &&
        carrierSupports.get(value) === (support ?? null) &&
        matchesNormalizedGraph(value, cached, support)
      )
        return cached as T;
    }
    const containsProxy = assertDeepDataGraph(value, support);
    return containsProxy ? cloneReactiveGraph(value, support) : value;
  }

  // The graph and caches are factory-local, so runtimes keep independent
  // proxies and version sources while sharing this single Proxy implementation.

  const unwrap = <T>(value: T, support: CollectionSupport | undefined): T => {
    return prepareDeepValue(value, support);
  };

  // Inherited members of the two prototypes a deep-signal target can have.
  // Reading one of these through the proxy (`list.map`, `list[Symbol.iterator]`,
  // `state.constructor`, ...) used to mint a permanent version signal for a key
  // that can never change, so a single `.map()` per render leaked one entry per
  // method name for the lifetime of the page. They are only skipped while the
  // key is *not* an own property, so a real data property named `map` or
  // `toString` — and an array's own `length` — stays fully reactive, and a
  // null-prototype object (which inherits nothing) is never affected.
  const OBJECT_PROTOTYPE_KEYS: ReadonlySet<PropertyKey> = new Set(Reflect.ownKeys(Object.prototype));
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
    metadata: PropertyMetadata,
    target: object,
    versions: Map<PropertyKey, VersionSignal>,
    key: PropertyKey,
  ): VersionSignal => {
    let version = versions.get(key);
    if (version === undefined) {
      version = adapter.createVersionSignal<number>(0);
      versions.set(key, version);
      metadata.onUnwatched ??= () => {
        if (metadata.prunable?.size) schedulePropertySweep(metadata, target);
      };
      adapter.onUnwatched?.(version, metadata.onUnwatched);
    }
    return version;
  };

  const track = (
    metadata: PropertyMetadata,
    target: object,
    versions: Map<PropertyKey, VersionSignal>,
    indices: Set<number>,
    key: PropertyKey,
  ): void => {
    if (!shouldTrackDeepRead()) return;
    if (isInheritedPrototypeMember(target, key)) {
      // An inherited member can only change by becoming (or ceasing to be) an
      // own property, which is exactly what the iteration version reports.
      // Plain objects subscribe to that, so dictionary-style state keyed by
      // "constructor" or "toString" stays reactive without minting a version
      // per inherited name. Arrays keep skipping: their inherited members are
      // the methods every `.map()` reads, and an own data property named after
      // one is not a supported shape.
      if (!Array.isArray(target)) trackIterationOf(metadata);
      return;
    }
    if (isArrayIndex(key)) indices.add(Number(key));
    const version = getVersion(metadata, target, versions, key);
    // Records that something reactive depends on this key right now, which is
    // what keeps `sweepPrunedKeys` from dropping it out from under a subscriber.
    adapter.markWatched(version);
    version.value;
    // Missing properties have no mutation that will naturally enqueue them
    // for cleanup. Keep them on the same bounded pruning path as removed
    // properties, then inspect them after this render/effect turn has settled.
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      queuePrunable(metadata, key);
      schedulePropertySweep(metadata, target);
    }
  };

  /**
   * Drops version signals for absent keys once they have no subscribers left,
   * so dynamic lookups and repeatedly-spliced lists do not retain every key
   * they have ever read.
   *
   * Runs only at batch depth 0, where the write that queued these keys has
   * already flushed its effects; before that, `hasSubscribers()` would still
   * report the pre-flush picture. Settled sweeps check graph links and
   * invalidate a render attempt that read but has not committed yet.
   */
  const hasLinkedSubscribers = (version: VersionSignal): boolean =>
    (adapter.hasLinkedSubscribers ?? adapter.hasSubscribers)(version);
  const retirePropertyVersion = (version: VersionSignal | undefined): void => {
    if (version !== undefined)
      adapter.untracked(() => {
        version.value = version.peek() + 1;
      });
  };

  const sweepPrunedKeys = (metadata: PropertyMetadata, target: object, settled = false): void => {
    const prunable = metadata.prunable;
    if (prunable === undefined || prunable.size === 0) return;
    if (adapter.getBatchDepth() !== 0) return;

    let iterator = metadata.prunableSweepIterator;
    if (iterator === undefined) {
      iterator = prunable.values();
      metadata.prunableSweepIterator = iterator;
      metadata.prunableSweepRevision = metadata.prunableRevision ?? 0;
      metadata.prunableSweepSettled = settled;
      metadata.prunableSweepDeferred = false;
    }
    const settledPass = metadata.prunableSweepSettled === true;
    const release = (version: VersionSignal | undefined): boolean => {
      if (version === undefined) return true;
      if (settledPass) {
        if (hasLinkedSubscribers(version)) return false;
        // A concurrent render may have read the old source without committing
        // a graph link yet. Advancing it makes that attempt retry at commit.
        retirePropertyVersion(version);
        return true;
      }
      if (!adapter.hasSubscribers(version)) return true;
      if (adapter.hasLinkedSubscribers !== undefined && !hasLinkedSubscribers(version)) {
        metadata.prunableSweepDeferred = true;
      }
      return false;
    };
    let processed = 0;
    while (processed < 128) {
      const next = iterator.next();
      if (next.done) {
        metadata.prunableSweepIterator = undefined;
        const revised = metadata.prunableSweepRevision !== (metadata.prunableRevision ?? 0);
        const deferred = metadata.prunableSweepDeferred === true && !settledPass;
        if (prunable.size === 0) metadata.prunable = undefined;
        metadata.prunableSweepRevision = undefined;
        metadata.prunableSweepDeferred = undefined;
        metadata.prunableSweepSettled = undefined;
        if ((revised || deferred) && prunable.size > 0) schedulePropertySweep(metadata, target);
        return;
      }
      const key = next.value;
      processed += 1;
      // The key came back (an index was written again, a property re-added):
      // its version signals are live metadata again, not garbage.
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        prunable.delete(key);
        continue;
      }
      const property = metadata.properties.get(key);
      const existence = metadata.existence.get(key);
      if (!release(property) || !release(existence)) {
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

    if (prunable.size === 0) {
      metadata.prunable = undefined;
      metadata.prunableSweepIterator = undefined;
      metadata.prunableSweepRevision = undefined;
      metadata.prunableSweepDeferred = undefined;
      metadata.prunableSweepSettled = undefined;
      return;
    }
    // A long-lived object can see arbitrarily many dynamic missing keys.
    // Yield between chunks just as collection-key pruning does.
    schedulePropertySweep(metadata, target);
  };

  const schedulePropertySweep = (metadata: PropertyMetadata, target: object): void => {
    if (scheduledPropertySweeps.has(metadata)) return;
    scheduledPropertySweeps.add(metadata);
    if (metadata.prunableSweepIterator !== undefined) metadata.prunableSweepSettled = true;
    setTimeout(() => {
      scheduledPropertySweeps.delete(metadata);
      sweepPrunedKeys(metadata, target, true);
    }, 0);
  };

  const trackIterationOf = (metadata: PropertyMetadata): void => {
    metadata.iteration ??= adapter.createVersionSignal(0);
    metadata.iteration.value;
  };

  const trackIteration = (metadata: PropertyMetadata): void => {
    if (!shouldTrackDeepRead()) return;
    trackIterationOf(metadata);
  };

  const notifyTruncatedIndices = (metadata: PropertyMetadata, currentLength: number, oldLength: number): void => {
    const truncatedCount = oldLength - currentLength;
    const trackedCount = metadata.propertyIndices.size + metadata.existenceIndices.size;
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
   * deep proxy for a plain object/array or a collection.
   * `get` trap uses this to reject a non-configurable, non-writable property
   * whose value cannot be substituted, before `wrap()` performs the swap.
   */
  const isWrappedByValue = (value: unknown, support: CollectionSupport | undefined): boolean =>
    isPlainObjectOrArray(value) ||
    (support !== undefined &&
      (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet));

  const wrap = <T>(value: T, support: CollectionSupport | undefined): T => {
    const rawValue = (toRaw(value) as T | undefined) ?? value;
    if (!isObjectLike(rawValue)) return rawValue;
    // Plain data first: it is the common case, and testing it once also
    // answers the collection check below for every non-plain value.
    if (!isPlainObjectOrArray(rawValue)) {
      if (support === undefined || !support.isStandardPrototype(rawValue)) return rawValue;
      return support.proxyFor(rawValue) as T;
    }
    assertExtensible(rawValue);

    const cached = rawToMetadata.get(rawValue);
    if (cached !== undefined) {
      if (cached.support !== support) throw modeError();
      return cached.proxy as T;
    }
    assertDataProperties(rawValue);

    const metadata: PropertyMetadata = {
      support,
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
        track(metadata, target, metadata.properties, metadata.propertyIndices, key);
        const result = Reflect.get(target, key, receiver);

        if (Array.isArray(target) && ARRAY_MUTATORS.has(key) && typeof result === "function") {
          const cachedMethod = metadata.arrayMethods.get(key);
          if (cachedMethod?.method === result) return cachedMethod.wrapper;

          const method = result as (...args: unknown[]) => unknown;
          // A mutator's own reads (`length`, the indices it shifts) are an
          // implementation detail of the write, not something the caller
          // depends on: tracked, `push` inside an effect would subscribe that
          // effect to `length` and re-run it on every later push. Vue 3.6's
          // array instrumentations pause tracking the same way. The writes
          // still go through the proxy (`this`), so they notify as usual.
          const wrapper = function (this: unknown, ...args: unknown[]) {
            try {
              return adapter.batch(() => adapter.untracked(() => Reflect.apply(method, this, args)));
            } finally {
              sweepPrunedKeys(metadata, target);
            }
          };
          metadata.arrayMethods.set(key, { method, wrapper });
          return wrapper;
        }

        if (Array.isArray(target) && ARRAY_SEARCHES.has(key) && typeof result === "function") {
          const cachedMethod = metadata.arrayMethods.get(key);
          if (cachedMethod?.method === result) return cachedMethod.wrapper;

          const method = result as (...args: unknown[]) => unknown;
          // Elements read through the proxy as proxies, so an identity search
          // for the raw object that was stored misses (and `splice(indexOf(a),
          // 1)` then removes the last element). The proxied search runs first,
          // keeping its reads tracked and native results unchanged; only an
          // object it missed is searched again, as raw, in the raw array --
          // elements are stored raw. Vue 3.6's `searchProxy` does the same.
          const wrapper = function (this: unknown, ...args: unknown[]) {
            const found = Reflect.apply(method, this, args);
            if ((found !== -1 && found !== false) || !isObjectLike(args[0])) return found;
            args[0] = toRaw(args[0]) ?? args[0];
            return Reflect.apply(method, toRaw(this) ?? this, args);
          };
          metadata.arrayMethods.set(key, { method, wrapper });
          return wrapper;
        }

        // Checked before `wrap()` substitutes anything: collection values are
        // proxied too, and those proxies are just as unassignable
        // back through a non-configurable, non-writable slot as a nested proxy
        // is. Gating this on `isPlainObjectOrArray(result)` let a frozen
        // Map/Set-valued property past the friendly error and into a raw engine
        // `TypeError` later on.
        if (isWrappedByValue(result, metadata.support)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (
            descriptor !== undefined &&
            "value" in descriptor &&
            descriptor.configurable === false &&
            descriptor.writable === false
          ) {
            throw new TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
          }
        }

        return wrap(result, metadata.support);
      },

      set(target, key, nextValue, receiver) {
        // A write that only reaches this proxy through the prototype chain
        // (`Object.create(state).x = 1`) defines `x` on that receiver, as an
        // ordinary [[Set]] would; it changes nothing in this deep state.
        if (receiver !== metadata.proxy) return Reflect.set(target, key, nextValue, receiver);
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
        const rawNextValue = unwrap(nextValue, metadata.support);
        const succeeded = Reflect.set(target, key, rawNextValue, target);
        if (!succeeded) return false;

        const currentValue = Reflect.get(target, key, target);
        const existsNow = Reflect.has(target, key);
        const ownedNow = Object.prototype.hasOwnProperty.call(target, key);
        if (ownedNow && !owned && metadata.prunable?.has(key)) {
          // If a chunked sweep already passed this candidate, make it revisit
          // the now-live property before the queue is considered settled.
          metadata.prunableRevision = (metadata.prunableRevision ?? 0) + 1;
        }

        adapter.batch(() =>
          adapter.untracked(() => {
            if (!Object.is(oldValue, currentValue) || owned !== ownedNow) {
              notify(metadata.properties, key);
            }
            // Existence versions back both `in` (any key in the chain) and own-key
            // checks such as `Object.hasOwn` (see `getOwnPropertyDescriptor`), so
            // either kind of change notifies them.
            if (existed !== existsNow || owned !== ownedNow) notify(metadata.existence, key);
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
          }),
        );
        sweepPrunedKeys(metadata, target);

        return true;
      },

      deleteProperty(target, key) {
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const succeeded = Reflect.deleteProperty(target, key);
        if (!succeeded || !owned) return succeeded;

        adapter.batch(() =>
          adapter.untracked(() => {
            notify(metadata.properties, key);
            // An own key was removed, which own-key existence checks observe even
            // when `in` still finds the key on the prototype.
            notify(metadata.existence, key);
            notifyIteration(metadata);
            markPrunable(metadata, key);
          }),
        );
        sweepPrunedKeys(metadata, target);
        return true;
      },

      getOwnPropertyDescriptor(target, key) {
        // [[GetOwnProperty]] is what `Object.hasOwn`, `hasOwnProperty.call`,
        // and the enumerability check inside `Object.keys`/`for...in` use, so it
        // subscribes to the key's *existence*, not its value: tracking the value
        // here made a keys-only reader re-run on every property write. Reads
        // that need the value (`Object.entries`, spread, JSON) also go through
        // [[Get]] and track it there; a value read through a descriptor alone
        // (`Object.getOwnPropertyDescriptor(state, key).value`) does not re-run
        // on value changes. The value is still wrapped so no raw nested object
        // escapes through `Object.getOwnPropertyDescriptors`.
        track(metadata, target, metadata.existence, metadata.existenceIndices, key);
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (descriptor === undefined || !("value" in descriptor)) return descriptor;

        // The one value that cannot be substituted. [[GetOwnProperty]] requires
        // the reported descriptor to be compatible with the target's, and for a
        // non-configurable, non-writable data property that means reporting the
        // very same value — a proxy may not lie about it, so the engine throws
        // at the call site if we swap in a wrapper. `get` refuses such a
        // property outright rather than hand back an unwrapped reference; here
        // refusing would break `Object.getOwnPropertyDescriptors()` for the
        // whole object, so report it exactly as it is, which is also all the
        // invariant ever lets a caller observe.
        if (descriptor.configurable === false && descriptor.writable === false) {
          return descriptor;
        }

        descriptor.value = wrap(descriptor.value, metadata.support);
        return descriptor;
      },

      has(target, key) {
        track(metadata, target, metadata.existence, metadata.existenceIndices, key);
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

  class DeepSignalImpl<T extends object> implements DeepSignalLike<T> {
    readonly #source: DeepSignalSource<T>;
    readonly #support: CollectionSupport | undefined;

    constructor(source: DeepSignalSource<T>, support: CollectionSupport | undefined) {
      this.#source = source;
      this.#support = support;
      delegateSubscription(this, this.#source);
    }

    get value(): T {
      return wrap(this.#source.value, this.#support) as T;
    }

    set value(nextValue: T) {
      const rawValue = unwrap(nextValue, this.#support);
      assertRootValue(rawValue, this.#support);
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
  function inspectDeepSignalMetadata(value: object):
    | {
        properties: PropertyKey[];
        existence: PropertyKey[];
        propertyIndices: number[];
        existenceIndices: number[];
      }
    | undefined {
    const metadata = rawToMetadata.get(toRaw(value) ?? value);
    if (metadata === undefined) return undefined;
    return {
      properties: [...metadata.properties.keys()],
      existence: [...metadata.existence.keys()],
      propertyIndices: [...metadata.propertyIndices],
      existenceIndices: [...metadata.existenceIndices],
    };
  }

  const collectionContext: CollectionContext = {
    adapter,
    shouldTrackDeepRead,
    toRaw,
    proxyToRaw,
    normalizedProxyCarriers,
    isPlainObjectOrArray,
    prepareDeepValue,
    wrap,
  };

  /** Primitive collection keys that still retain version metadata. */
  function inspectCollectionMetadata(value: object) {
    return collectionSupport?.inspect(toRaw(value) ?? value);
  }

  /**
   * Creates a signal that lazily tracks nested plain-object and array reads.
   * Map, Set, WeakMap and WeakSet values inside are opaque, like a Date: the
   * signal notifies only when one is replaced. Mutations must go through
   * `.value`; changes made through the original raw value or `.peek()` are
   * intentionally not observable.
   */
  function deepSignal<T extends object>(initialValue: T): DeepSignalLike<T> {
    return createRoot(initialValue, undefined);
  }

  /**
   * Like `deepSignal`, and it also tracks Map, Set, WeakMap and WeakSet values
   * (the root and nested ones). `createSupport` builds the collection module's
   * support on first use, so callers that never pass one never load it.
   */
  function deepCollectionSignal<T extends object>(
    initialValue: T,
    createSupport: (context: CollectionContext) => CollectionSupport,
  ): DeepSignalLike<T> {
    collectionSupport ??= createSupport(collectionContext);
    return createRoot(initialValue, collectionSupport);
  }

  function createRoot<T extends object>(initialValue: T, support: CollectionSupport | undefined): DeepSignalLike<T> {
    const rawInitialValue = prepareDeepValue(initialValue, support);
    assertRootValue(rawInitialValue, support);

    wrap(rawInitialValue, support);
    const root = adapter.createSignal(rawInitialValue as T);
    const result = new DeepSignalImpl(root, support);
    adapter.registerDeepSignal?.(result);
    return result;
  }
  return { deepSignal, deepCollectionSignal, inspectDeepSignalMetadata, inspectCollectionMetadata };
}
