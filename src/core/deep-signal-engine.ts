import {
  attachReadableInterop,
  getReadableInterop,
  getSharedInteropContext,
  isInteropSpeculative,
  markInteropSpeculativeDeepRead,
} from "./interop.js";
import { hasActiveRenderCollector } from "./render-tracking.js";
import { plainResultIteratorNext } from "./plain-result-iterators.js";
import { SIGNAL_BRAND } from "./signal-brand.js";

const ITERATOR_PROTOTYPE: object = /* @__PURE__ */ Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

/**
 * Map/Set iteration through a reactive collection: converts each step's value
 * on the way out. One shared `next` (registered once as returning plain data
 * results) instead of a closure and a descriptor object per iterator.
 */
class ReactiveCollectionIterator {
  readonly #iterator: Iterator<unknown>;
  readonly #convert: (value: unknown) => unknown;
  readonly #tag: string;
  constructor(iterator: Iterator<unknown>, convert: (value: unknown) => unknown, tag: string) {
    this.#iterator = iterator;
    this.#convert = convert;
    this.#tag = tag;
  }
  next(): IteratorResult<unknown> {
    const step = this.#iterator.next();
    return step.done ? step : { done: false, value: this.#convert(step.value) };
  }
  get [Symbol.toStringTag](): string { return this.#tag; }
}

let reactiveIteratorSetUp = false;
/** Inherit %IteratorPrototype% (Iterator helpers) and register the shared `next`, once. */
function setUpReactiveCollectionIterator(): void {
  if (reactiveIteratorSetUp) return;
  reactiveIteratorSetUp = true;
  Object.setPrototypeOf(ReactiveCollectionIterator.prototype, ITERATOR_PROTOTYPE);
  plainResultIteratorNext.add(ReactiveCollectionIterator.prototype.next);
}

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

interface PropertyMetadata {
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

interface CollectionMetadata {
  values: Map<unknown, VersionSignal>;
  existence: Map<unknown, VersionSignal>;
  members: Map<unknown, VersionSignal>;
  objectValues: WeakMap<object, VersionSignal>;
  objectExistence: WeakMap<object, VersionSignal>;
  objectMembers: WeakMap<object, VersionSignal>;
  weakValues: WeakMap<object, VersionSignal>;
  weakExistence: WeakMap<object, VersionSignal>;
  weakMembers: WeakMap<object, VersionSignal>;
  size?: VersionSignal;
  keysIteration?: VersionSignal;
  entriesIteration?: VersionSignal;
  prunable: Map<unknown, number>;
  prunableSweepIterator?: Iterator<[unknown, number]> | undefined;
  prunableRevision: number;
  prunableSweepRevision?: number | undefined;
  /** Whether the current sweep iteration began in a settled (later-task) pass. */
  prunableSweepSettled?: boolean | undefined;
  /** An unsettled pass of the current iteration kept read-only candidates for a settled one. */
  prunableSweepDeferred?: boolean | undefined;
  onUnwatched?: (() => void) | undefined;
  methods: Map<PropertyKey, Function>;
  proxy: object;
}

type VersionSignal = DeepSignalSource<number>;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

const supportsWeakSymbolKeys = (() => {
  try {
    const key = Symbol("weak-key-probe");
    const collection = new WeakMap<object, boolean>();
    Reflect.apply(WeakMap.prototype.set, collection, [key, true]);
    return Reflect.apply(WeakMap.prototype.get, collection, [key]) === true;
  } catch {
    return false;
  }
})();

function isWeakCollectionKey(value: unknown): value is object | symbol {
  return isObjectLike(value) || (
    supportsWeakSymbolKeys
    && typeof value === "symbol"
    // Native WeakMap/WeakSet accept non-registered symbols where supported,
    // but Symbol.for() symbols are shared registry entries and never valid
    // weak keys. Symbol.keyFor() returns undefined for local and well-known
    // symbols, both of which follow the native weak-key contract.
    && Symbol.keyFor(value) === undefined
  );
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
  setUpReactiveCollectionIterator();
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
  const reactiveCollections = new WeakMap<object, CollectionMetadata>();
  const scheduledPropertySweeps = new WeakSet<PropertyMetadata>();
  const scheduledCollectionSweeps = new WeakSet<CollectionMetadata>();
  // A carrier that contains one of our proxies has to be copied before it can be
  // stored. Remember that copy so assigning the same carrier again preserves the
  // same identity and aliases, just like assigning an ordinary raw object does.
  const normalizedProxyCarriers = new WeakMap<object, object>();
  const isSpeculative = adapter.isSpeculative ?? isInteropSpeculative;
  const markSpeculativeDeepRead = adapter.markSpeculativeDeepRead ?? markInteropSpeculativeDeepRead;

  function shouldTrackDeepRead(): boolean {
    if (isSpeculative()) {
      // No per-key metadata during speculation; the computed's speculative
      // result must therefore not be promoted as a complete graph cache.
      markSpeculativeDeepRead();
      return false;
    }
    const shared = getSharedInteropContext();
    return adapter.hasActiveSubscriber() ||
      hasActiveRenderCollector() ||
      shared.graphCollector !== undefined ||
      shared.renderCollector !== undefined;
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

  const isIntrinsicPrototype = (value: unknown): boolean =>
    isObjectLike(value) && INTRINSIC_PROTOTYPES.has(value);

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

  function getNativeCollectionKind(value: unknown): "Map" | "Set" | "WeakMap" | "WeakSet" | undefined {
    if (!isObjectLike(value)) return undefined;
    // Ordinary deep-state nodes are overwhelmingly plain objects and arrays.
    // Avoid four native internal-slot probes (each of the wrong collection
    // brand throws) for every node in those graphs.
    if (isPlainObjectOrArray(value)) return undefined;
    if ((value as object) instanceof Map) return "Map";
    if ((value as object) instanceof Set) return "Set";
    if ((value as object) instanceof WeakMap) return "WeakMap";
    if ((value as object) instanceof WeakSet) return "WeakSet";
    // What remains for the throwing brand probes is a collection from another
    // realm or one whose prototype was replaced. A chain that reaches this
    // realm's Object.prototype without passing a collection prototype (Dates,
    // class instances: every opaque value in stored state) is neither, so the
    // store path does not pay four exceptions per opaque value.
    for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
      if (prototype === Object.prototype) return undefined;
    }
    const probe = {};
    try { Map.prototype.has.call(value, probe); return "Map"; } catch { /* try next brand */ }
    try { Set.prototype.has.call(value, probe); return "Set"; } catch { /* try next brand */ }
    try { WeakMap.prototype.has.call(value, probe); return "WeakMap"; } catch { /* try next brand */ }
    try { WeakSet.prototype.has.call(value, probe); return "WeakSet"; } catch { /* not a collection */ }
    return undefined;
  }

  function isStandardCollection(value: unknown): value is Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> {
    if (!isObjectLike(value) || isPlainObjectOrArray(value)) return false;
    return isStandardCollectionPrototype(value);
  }

  /** `isStandardCollection` for a value already known not to be plain data. */
  function isStandardCollectionPrototype(value: object): value is Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> {
    // `wrap()` runs this for every opaque value read through a proxy (Dates,
    // class instances). Match the prototype first so those reads skip the
    // throwing internal-slot probes in `getNativeCollectionKind`.
    const prototype = Object.getPrototypeOf(value);
    const expectedKind = prototype === Map.prototype ? "Map"
      : prototype === Set.prototype ? "Set"
      : prototype === WeakMap.prototype ? "WeakMap"
      : prototype === WeakSet.prototype ? "WeakSet"
      : undefined;
    return expectedKind !== undefined && getNativeCollectionKind(value) === expectedKind;
  }

  function assertRootValue(value: unknown): asserts value is object {
    if (!isPlainObjectOrArray(value) && !isStandardCollection(value)) {
      throw new TypeError("deepSignal() only accepts plain objects, arrays, or same-realm standard collections");
    }
    if (isStandardCollection(value)) assertReactiveCollection(value);
  }

  function assertReactiveCollection(value: object): void {
    if (!Object.isExtensible(value)) throw new TypeError("deepSignal() cannot proxy a non-extensible collection");
    if (Reflect.ownKeys(value).length !== 0) {
      throw new TypeError("deepSignal() reactive collections do not support own properties");
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

      if (!insideOpaque && getNativeCollectionKind(raw) !== undefined && !isStandardCollection(raw)) {
        throw new TypeError("deepSignal() collections require same-realm standard collections");
      }

      if (raw instanceof Map) {
        if (!insideOpaque) assertReactiveCollection(raw);
        for (const [key, entry] of raw) {
          if (isObjectLike(key)) {
            pending.push({ value: key, insideOpaque });
          }
          if (isObjectLike(entry)) {
            pending.push({ value: entry, insideOpaque });
          }
        }
        continue;
      }
      if (raw instanceof Set) {
        if (!insideOpaque) assertReactiveCollection(raw);
        for (const entry of raw) {
          if (isObjectLike(entry)) {
            pending.push({ value: entry, insideOpaque });
          }
        }
        continue;
      }
      if (raw instanceof WeakMap || raw instanceof WeakSet) {
        if (!insideOpaque) assertReactiveCollection(raw);
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
      const sourceIsMap = currentSource instanceof Map;
      const sourceIsSet = currentSource instanceof Set;
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
  function cloneReactiveGraph<T>(value: T): T {
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
      const map = current instanceof Map;
      const set = current instanceof Set;
      if (!plain && !map && !set) return current;
      const found = clones.get(current);
      if (found !== undefined) return found;
      const clone: object = map ? new Map() : set ? new Set() :
        Array.isArray(current) ? emptyArrayOfLength(current.length) : Object.create(Object.getPrototypeOf(current));
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
      return assertDeepDataGraph(current) ? resolve(current) : current;
    };
    const root = resolve(value) as T;
    while (pending.length > 0) {
      const source = pending.pop() as object;
      const target = clones.get(source) as object;
      if (source instanceof Map && target instanceof Map) {
        for (const [key, entry] of source) {
          const normalizedKey = resolveCollectionEntry(key);
          if (target.has(normalizedKey)) throw new TypeError("deepSignal() collection keys collide after proxy normalization");
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
    for (const [source, target] of created) normalizedProxyCarriers.set(source, target);
    return root;
  }

  function prepareDeepValue<T>(value: T): T {
    // Reassigning a value obtained from this deep signal is already known-good.
    // Avoid validating its entire graph again on this common O(1) path.
    const wrapperRaw = toRaw(value);
    if (wrapperRaw !== undefined) return wrapperRaw as T;
    if (isObjectLike(value)) {
      const cached = normalizedProxyCarriers.get(value);
      if (cached !== undefined && matchesNormalizedGraph(value, cached)) return cached as T;
    }
    const containsProxy = assertDeepDataGraph(value);
    return containsProxy ? cloneReactiveGraph(value) : value;
  }

  // The graph and caches are factory-local, so runtimes keep independent
  // proxies and version sources while sharing this single Proxy implementation.

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
    if (version !== undefined) adapter.untracked(() => { version.value = version.peek() + 1; });
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

  const collectionVersion = (metadata: CollectionMetadata, kind: "values" | "existence" | "members", key: unknown): VersionSignal => {
    const weakKey = isWeakCollectionKey(key);
    const weakVersions = kind === "values" ? metadata.objectValues : kind === "existence" ? metadata.objectExistence : metadata.objectMembers;
    let version = weakKey ? weakVersions.get(key as object) : metadata[kind].get(key);
    if (version === undefined) {
      version = adapter.createVersionSignal(0);
      if (weakKey) weakVersions.set(key as object, version);
      else metadata[kind].set(key, version);
      if (!weakKey) {
        metadata.onUnwatched ??= () => {
          if (metadata.prunable.size) scheduleCollectionSweep(metadata, true);
        };
        adapter.onUnwatched?.(version, metadata.onUnwatched);
      }
    }
    // Primitive keys cannot be weakly keyed. Record exactly which categories
    // have a version so mutation cleanup need not probe three maps per key.
    if (!weakKey) {
      const bit = kind === "values" ? 1 : kind === "existence" ? 2 : 4;
      const candidates = metadata.prunable.get(key) ?? 0;
      if ((candidates & bit) === 0) {
        metadata.prunable.set(key, candidates | bit);
        metadata.prunableRevision += 1;
        // Lookup-only keys are never followed by a write to this collection,
        // so mutation-triggered sweeping alone cannot reclaim them.
        scheduleCollectionSweep(metadata, true);
      }
    }
    return version;
  };

  const weakCollectionVersion = (metadata: CollectionMetadata, kind: "weakValues" | "weakExistence" | "weakMembers", key: object): VersionSignal => {
    const versions = metadata[kind];
    let version = versions.get(key);
    if (version === undefined) {
      version = adapter.createVersionSignal(0);
      versions.set(key, version);
    }
    return version;
  };

  const trackWeakCollectionKey = (
    metadata: CollectionMetadata,
    weakKind: "weakValues" | "weakExistence" | "weakMembers",
    strongKind: "values" | "existence" | "members",
    key: object | symbol,
  ): VersionSignal => isWeakCollectionKey(key)
    ? weakCollectionVersion(metadata, weakKind, key as object)
    : collectionVersion(metadata, strongKind, key);

  const notifyWeakCollectionKey = (
    metadata: CollectionMetadata,
    weakKind: "weakValues" | "weakExistence" | "weakMembers",
    strongKind: "values" | "existence" | "members",
    key: object | symbol,
  ): void => {
    const version = isWeakCollectionKey(key)
      ? metadata[weakKind].get(key as object)
      : metadata[strongKind].get(key);
    if (version !== undefined) version.value += 1;
  };

  const trackCollectionVersion = (version: VersionSignal): void => {
    adapter.markWatched(version);
    version.value;
  };

  const collectionAggregate = (metadata: CollectionMetadata, kind: "size" | "keysIteration" | "entriesIteration"): VersionSignal => {
    let version = metadata[kind];
    if (version === undefined) metadata[kind] = version = adapter.createVersionSignal(0);
    return version;
  };

  const notifyCollectionKey = (metadata: CollectionMetadata, kind: "values" | "existence" | "members", key: unknown): void => {
    const weakKey = isWeakCollectionKey(key);
    const weakVersions = kind === "values" ? metadata.objectValues : kind === "existence" ? metadata.objectExistence : metadata.objectMembers;
    const version = weakKey ? weakVersions.get(key as object) : metadata[kind].get(key);
    if (version !== undefined) version.value += 1;
  };

  // Collection keys are often only looked up (search, cache, existence checks)
  // and never written, so the write-cleared watched flag would retain them
  // forever. A settled sweep (a later task) drops them by actual graph links
  // instead and advances each dropped version once more: a render attempt that
  // read it but has not subscribed yet sees the revision change at commit and
  // re-renders onto a fresh version. The synchronous sweep that follows a
  // mutation drops only versions nothing has read since their last write, so
  // an unrelated write never invalidates a render that is still in progress.
  const retireCollectionVersion = (version: VersionSignal | undefined): void => {
    if (version !== undefined) adapter.untracked(() => { version.value = version.peek() + 1; });
  };

  const sweepCollectionKeys = (metadata: CollectionMetadata, settled = false): void => {
    // Primitive-key versions are the only strong metadata retained here. Avoid
    // creating an empty iterator after collection writes with no subscribers.
    if (metadata.prunable.size === 0) return;
    if (adapter.getBatchDepth() !== 0) {
      scheduleCollectionSweep(metadata, false);
      return;
    }
    // Revisit only primitive candidates and only the categories with versions.
    // Keep subscribed categories for another mutation-driven cleanup after a
    // later effect run/disposal; drop each unsubscribed category independently.
    let iterator = metadata.prunableSweepIterator;
    if (iterator === undefined) {
      iterator = metadata.prunable.entries();
      metadata.prunableSweepIterator = iterator;
      metadata.prunableSweepRevision = metadata.prunableRevision;
      metadata.prunableSweepSettled = settled;
      metadata.prunableSweepDeferred = false;
    }
    const release = (version: VersionSignal | undefined): boolean => {
      if (version === undefined) return true;
      if (settled) {
        if (hasLinkedSubscribers(version)) return false;
        retireCollectionVersion(version);
        return true;
      }
      if (!adapter.hasSubscribers(version)) return true;
      // Read since its last write but not linked yet: a render in progress
      // or a reader already gone. Leave it to the settled sweep.
      if (adapter.hasLinkedSubscribers !== undefined && !adapter.hasLinkedSubscribers(version)) metadata.prunableSweepDeferred = true;
      return false;
    };
    let processed = 0;
    while (processed < 128) {
      const next = iterator.next();
      if (next.done) {
        metadata.prunableSweepIterator = undefined;
        const revised = metadata.prunableSweepRevision !== metadata.prunableRevision;
        // Candidates an unsettled pass kept may sit before the point a later
        // settled pass resumed from; revisit them all in a fresh settled pass.
        const deferred = metadata.prunableSweepDeferred === true && metadata.prunableSweepSettled !== true;
        metadata.prunableSweepRevision = undefined;
        metadata.prunableSweepSettled = undefined;
        metadata.prunableSweepDeferred = undefined;
        if (revised || deferred) scheduleCollectionSweep(metadata, true);
        return;
      }
      // Avoid spelling this as `.value`: the managed transform treats static
      // `.value` reads as signal reads and would capture this iterator result.
      const [key, candidates] = Reflect.get(next, "value") as [unknown, number];
      processed += 1;
      let remaining = candidates;
      if ((candidates & 1) !== 0) {
        const version = metadata.values.get(key);
        if (release(version)) { metadata.values.delete(key); remaining &= ~1; }
      }
      if ((candidates & 2) !== 0) {
        const version = metadata.existence.get(key);
        if (release(version)) { metadata.existence.delete(key); remaining &= ~2; }
      }
      if ((candidates & 4) !== 0) {
        const version = metadata.members.get(key);
        if (release(version)) { metadata.members.delete(key); remaining &= ~4; }
      }
      if (remaining === 0) metadata.prunable.delete(key);
      else if (remaining !== candidates) metadata.prunable.set(key, remaining);
    }
    // Large candidate sets are drained over timer turns so each collection
    // mutation pays a fixed synchronous budget and the browser can paint
    // between cleanup chunks. The live Map iterator also sees appended keys.
    scheduleCollectionSweep(metadata, true);
  };

  const scheduleCollectionSweep = (metadata: CollectionMetadata, yieldToTask: boolean): void => {
    if (scheduledCollectionSweeps.has(metadata)) return;
    scheduledCollectionSweeps.add(metadata);
    const resume = () => {
      scheduledCollectionSweeps.delete(metadata);
      sweepCollectionKeys(metadata, yieldToTask);
    };
    if (yieldToTask) setTimeout(resume, 0);
    else queueMicrotask(resume);
  };

  function reactiveCollectionProxy(raw: object, kind: "Map" | "Set" | "WeakMap" | "WeakSet"): object {
    const found = reactiveCollections.get(raw);
    if (found !== undefined) return found.proxy;
    const metadata: CollectionMetadata = {
      values: new Map(), existence: new Map(), members: new Map(),
      objectValues: new WeakMap(), objectExistence: new WeakMap(), objectMembers: new WeakMap(),
      weakValues: new WeakMap(), weakExistence: new WeakMap(), weakMembers: new WeakMap(),
      prunable: new Map(), prunableRevision: 0, methods: new Map(), proxy: undefined as unknown as object,
    };
    const normalize = (value: unknown): unknown => unwrap(value);
    // Lookups (`get`/`has`/`delete`) only need the identity a stored key would
    // have. Validating the key's whole reachable graph like a write would make
    // every lookup O(graph) and throw for values that are merely absent.
    const normalizeLookupKey = (value: unknown): unknown => {
      if (!isObjectLike(value)) return value;
      return toRaw(value) ?? storedCarrierKey(value) ?? normalizedProxyCarriers.get(value) ?? value;
    };
    // A key/member that is a carrier (a plain object holding a deep proxy) is
    // stored as a normalized clone. Its entry identity is fixed by the first
    // insertion: later mutation of the caller's object must keep addressing the
    // same entry, as it does for a native Map/Set, instead of re-cloning the
    // carrier into a second entry. Entries are per collection and only honored
    // while the stored clone is still a key/member of it.
    const carrierKeys = new WeakMap<object, object>();
    const hasStoredKey = (key: unknown): boolean =>
      kind === "Map" ? Map.prototype.has.call(raw, key) : Set.prototype.has.call(raw, key);
    const storedCarrierKey = (value: object): object | undefined => {
      if (kind !== "Map" && kind !== "Set") return undefined;
      const stored = carrierKeys.get(value);
      return stored !== undefined && hasStoredKey(stored) ? stored : undefined;
    };
    // Writes validate a new key's whole graph, but a key that already identifies
    // an entry was validated when it was stored, so re-setting it stays O(1).
    const normalizeWriteKey = (value: unknown): unknown => {
      if (kind !== "Map" && kind !== "Set") return normalize(value);
      const existing = normalizeLookupKey(value);
      if (hasStoredKey(existing)) return existing;
      const normalized = normalize(value);
      if (isObjectLike(value) && normalized !== value && toRaw(value) === undefined) carrierKeys.set(value, normalized as object);
      return normalized;
    };
    const normalizeWeakKey = (value: unknown): unknown => {
      if (isObjectLike(value)) {
        const raw = toRaw(value);
        if (raw !== undefined) return raw;
        // Native weak collections treat every object key as an opaque identity,
        // including proxies whose ownKeys/getPrototypeOf traps throw. Only
        // unwrap proxies created by this deepSignal factory; traversing an
        // arbitrary key would change native acceptance and identity semantics.
        return value;
      }
      return normalize(value);
    };
    const wrapRead = <T>(value: T): T => wrap(value);
    /**
     * Mirrors GetSetRecord so native Set methods observe `other` in spec order:
     * `size` is read, converted, and validated (NaN -> TypeError, negative ->
     * RangeError) before `has` is read and checked, then `keys` is read and
     * checked. Members are translated between raw and reactive identities
     * without adding observable accesses: `done` and `value` are read once per
     * step, and `return` is only looked up when the method closes the iterator.
     * `has` is retried with the reactive proxy only for arguments known to hold
     * proxies (built-in Sets/Maps, whose `has` is unobservable, and reactive
     * collections); other set-likes see exactly one `has` call per member.
     * `origins` records the caller-visible member behind each translated key.
     */
    const normalizedSetLike = (other: unknown, origins?: Map<unknown, unknown>): unknown => {
      if (!isObjectLike(other)) return other;
      const record = other as { size: unknown; has: unknown; keys: unknown };
      const numSize = +(record.size as number);
      if (Number.isNaN(numSize)) throw new TypeError("The 'size' property of the set-like argument is not a number");
      const size = Math.trunc(numSize);
      if (size < 0) throw new RangeError("The 'size' property of the set-like argument must not be negative");
      const has = record.has;
      if (typeof has !== "function") throw new TypeError("The 'has' property of the set-like argument is not a function");
      const keys = record.keys;
      if (typeof keys !== "function") throw new TypeError("The 'keys' property of the set-like argument is not a function");
      const retryWithProxy = has === Set.prototype.has || has === Map.prototype.has || toRaw(other) !== undefined;
      return {
        size: size === 0 ? 0 : size,
        has(value: unknown): boolean {
          if (Reflect.apply(has, other, [value])) return true;
          if (!retryWithProxy) return false;
          const reactive = wrapRead(value);
          return reactive !== value && Boolean(Reflect.apply(has, other, [reactive]));
        },
        keys(): Iterator<unknown> {
          const iterator = Reflect.apply(keys, other, []) as Iterator<unknown>;
          if (!isObjectLike(iterator)) throw new TypeError("The 'keys' method of the set-like argument returned a non-object");
          const next = iterator.next;
          return {
            next(): IteratorResult<unknown> {
              const step = Reflect.apply(next, iterator, []) as IteratorResult<unknown>;
              if (!isObjectLike(step)) return step;
              if (step.done) return { done: true, value: undefined };
              const original = step.value;
              const converted = normalizeLookupKey(original);
              if (origins !== undefined && converted !== original) origins.set(converted, original);
              return { done: false, value: converted };
            },
            // A method that stops early (`isDisjointFrom`, `isSubsetOf`)
            // closes the keys iterator. Look `return` up on the original only
            // when that happens and call it with the original as receiver, so
            // its lookup, call count, result check, and errors stay native.
            get return(): (() => unknown) | undefined {
              const close = (iterator as { return?: unknown }).return;
              if (close == null) return undefined;
              return () => Reflect.apply(close as Function, iterator, []);
            },
          } as Iterator<unknown>;
        },
      };
    };
    const trackAggregate = (name: "size" | "keysIteration" | "entriesIteration"): void => {
      if (shouldTrackDeepRead()) trackCollectionVersion(collectionAggregate(metadata, name));
    };
    const batchWrite = <T>(callback: () => T): T => adapter.batch(() => adapter.untracked(callback));
    const memoMethod = <T extends Function>(key: PropertyKey, create: () => T): T => {
      let method = metadata.methods.get(key);
      if (method === undefined) metadata.methods.set(key, method = create());
      return method as T;
    };
    // Inherit %IteratorPrototype% like native Map/Set iterators, so Iterator
    // helpers (`keys().toArray()`, `values().map()`) and `instanceof Iterator`
    // keep working where the engine provides them.
    const wrapIterator = (iterator: Iterator<unknown>, convert: (value: unknown) => unknown, tag: string): IterableIterator<unknown> & { readonly [Symbol.toStringTag]: string } =>
      new ReactiveCollectionIterator(iterator, convert, tag) as unknown as IterableIterator<unknown> & { readonly [Symbol.toStringTag]: string };
    const proxy = new Proxy(raw, {
      get(target, key) {
        if (kind === "Map" && key === "size" || kind === "Set" && key === "size") {
          trackAggregate("size");
          return Reflect.get(target, "size", target);
        }
        const cachedMethod = metadata.methods.get(key);
        if (cachedMethod !== undefined) return cachedMethod;
        const method = (target as unknown as Record<PropertyKey, unknown>)[key];
        if (typeof method !== "function") return Reflect.get(target, key, target);

        if ((kind === "Map" || kind === "WeakMap") && key === "get") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakMap" ? normalizeWeakKey(input) : normalizeLookupKey(input);
          if (kind === "WeakMap") {
            if (!isWeakCollectionKey(normalized)) return Reflect.apply(WeakMap.prototype.get, target, [normalized]);
            if (shouldTrackDeepRead()) trackCollectionVersion(trackWeakCollectionKey(metadata, "weakValues", "values", normalized));
            return wrapRead(Reflect.apply(WeakMap.prototype.get, target, [normalized]));
          }
          if (shouldTrackDeepRead()) trackCollectionVersion(collectionVersion(metadata, "values", normalized));
          return wrapRead(Map.prototype.get.call(target, normalized));
        });
        if ((kind === "Map" || kind === "WeakMap") && key === "has") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakMap" ? normalizeWeakKey(input) : normalizeLookupKey(input);
          if (kind === "WeakMap") {
            if (!isWeakCollectionKey(normalized)) return Reflect.apply(WeakMap.prototype.has, target, [normalized]);
            if (shouldTrackDeepRead()) trackCollectionVersion(trackWeakCollectionKey(metadata, "weakExistence", "existence", normalized));
            return Reflect.apply(WeakMap.prototype.has, target, [normalized]);
          }
          if (shouldTrackDeepRead()) trackCollectionVersion(collectionVersion(metadata, "existence", normalized));
          return Map.prototype.has.call(target, normalized);
        });
        if (kind === "Map" && key === "set" || kind === "WeakMap" && key === "set") return memoMethod(key, () => (inputKey: unknown, inputValue: unknown) => {
          const normalizedKey = kind === "WeakMap" ? normalizeWeakKey(inputKey) : normalizeWriteKey(inputKey);
          if (kind === "WeakMap" && !isWeakCollectionKey(normalizedKey)) return WeakMap.prototype.set.call(target, normalizedKey as object, normalize(inputValue));
          const had = kind === "Map" ? Map.prototype.has.call(target, normalizedKey) : WeakMap.prototype.has.call(target, normalizedKey as object);
          const oldValue = kind === "Map" ? Map.prototype.get.call(target, normalizedKey) : WeakMap.prototype.get.call(target, normalizedKey as object);
          // Re-storing the very value an entry already holds needs no revalidation.
          const normalizedValue = had && isObjectLike(inputValue) && Object.is(oldValue, inputValue) ? oldValue : normalize(inputValue);
          batchWrite(() => {
            if (kind === "Map") Map.prototype.set.call(target, normalizedKey, normalizedValue);
            else WeakMap.prototype.set.call(target, normalizedKey as object, normalizedValue);
            if (!had) {
              if (kind === "Map") {
                notifyCollectionKey(metadata, "values", normalizedKey);
                notifyCollectionKey(metadata, "existence", normalizedKey);
                const size = metadata.size; if (size !== undefined) size.value += 1;
                const keys = metadata.keysIteration; if (keys !== undefined) keys.value += 1;
                const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
              } else {
                notifyWeakCollectionKey(metadata, "weakValues", "values", normalizedKey as object | symbol);
                notifyWeakCollectionKey(metadata, "weakExistence", "existence", normalizedKey as object | symbol);
              }
            } else if (!Object.is(oldValue, normalizedValue)) {
              if (kind === "Map") {
                notifyCollectionKey(metadata, "values", normalizedKey);
                const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
              } else {
                notifyWeakCollectionKey(metadata, "weakValues", "values", normalizedKey as object | symbol);
              }
            }
          });
          sweepCollectionKeys(metadata);
          return proxy;
        });
        if ((kind === "Map" || kind === "WeakMap") && key === "delete") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakMap" ? normalizeWeakKey(input) : normalizeLookupKey(input);
          const had = kind === "Map" ? Map.prototype.has.call(target, normalized) : WeakMap.prototype.has.call(target, normalized as object);
          if (!had) return false;
          batchWrite(() => {
            if (kind === "Map") Map.prototype.delete.call(target, normalized);
            else WeakMap.prototype.delete.call(target, normalized as object);
            if (kind === "Map") {
              notifyCollectionKey(metadata, "values", normalized);
              notifyCollectionKey(metadata, "existence", normalized);
              const size = metadata.size; if (size !== undefined) size.value += 1;
              const keys = metadata.keysIteration; if (keys !== undefined) keys.value += 1;
              const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
            } else {
              notifyWeakCollectionKey(metadata, "weakValues", "values", normalized as object | symbol);
              notifyWeakCollectionKey(metadata, "weakExistence", "existence", normalized as object | symbol);
            }
          });
          sweepCollectionKeys(metadata);
          return true;
        });
        if ((kind === "Map" || kind === "Set") && key === "clear") return memoMethod(key, () => () => {
          if ((kind === "Map" ? (target as Map<unknown, unknown>).size : (target as Set<unknown>).size) === 0) return undefined;
          batchWrite(() => {
            if (kind === "Map") {
              for (const item of Map.prototype.keys.call(target) as IterableIterator<unknown>) {
                notifyCollectionKey(metadata, "values", item); notifyCollectionKey(metadata, "existence", item);
              }
              Map.prototype.clear.call(target);
            } else {
              for (const item of Set.prototype.values.call(target) as IterableIterator<unknown>) {
                notifyCollectionKey(metadata, "members", item);
              }
              Set.prototype.clear.call(target);
            }
            const size = metadata.size; if (size !== undefined) size.value += 1;
            const keys = metadata.keysIteration; if (keys !== undefined) keys.value += 1;
            const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
          });
          sweepCollectionKeys(metadata);
          return undefined;
        });
        if ((kind === "Set" || kind === "WeakSet") && key === "has") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakSet" ? normalizeWeakKey(input) : normalizeLookupKey(input);
          if (kind === "WeakSet") {
            if (!isWeakCollectionKey(normalized)) return Reflect.apply(WeakSet.prototype.has, target, [normalized]);
            if (shouldTrackDeepRead()) trackCollectionVersion(trackWeakCollectionKey(metadata, "weakMembers", "members", normalized));
            return Reflect.apply(WeakSet.prototype.has, target, [normalized]);
          }
          if (shouldTrackDeepRead()) trackCollectionVersion(collectionVersion(metadata, "members", normalized));
          return Set.prototype.has.call(target, normalized);
        });
        if ((kind === "Set" || kind === "WeakSet") && key === "add") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakSet" ? normalizeWeakKey(input) : normalizeWriteKey(input);
          if (kind === "WeakSet" && !isWeakCollectionKey(normalized)) return WeakSet.prototype.add.call(target, normalized as object);
          const had = kind === "Set" ? Set.prototype.has.call(target, normalized) : WeakSet.prototype.has.call(target, normalized as object);
          batchWrite(() => {
            if (kind === "Set") Set.prototype.add.call(target, normalized); else WeakSet.prototype.add.call(target, normalized as object);
            if (!had) {
              if (kind === "Set") {
                notifyCollectionKey(metadata, "members", normalized);
                const size = metadata.size; if (size !== undefined) size.value += 1;
                const keys = metadata.keysIteration; if (keys !== undefined) keys.value += 1;
                const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
              } else {
                notifyWeakCollectionKey(metadata, "weakMembers", "members", normalized as object | symbol);
              }
            }
          });
          sweepCollectionKeys(metadata);
          return proxy;
        });
        if ((kind === "Set" || kind === "WeakSet") && key === "delete") return memoMethod(key, () => (input: unknown) => {
          const normalized = kind === "WeakSet" ? normalizeWeakKey(input) : normalizeLookupKey(input);
          const had = kind === "Set" ? Set.prototype.has.call(target, normalized) : WeakSet.prototype.has.call(target, normalized as object);
          if (!had) return false;
          batchWrite(() => {
            if (kind === "Set") Set.prototype.delete.call(target, normalized); else WeakSet.prototype.delete.call(target, normalized as object);
            if (kind === "Set") {
              notifyCollectionKey(metadata, "members", normalized);
              const size = metadata.size; if (size !== undefined) size.value += 1;
              const keys = metadata.keysIteration; if (keys !== undefined) keys.value += 1;
              const entries = metadata.entriesIteration; if (entries !== undefined) entries.value += 1;
            } else {
              notifyWeakCollectionKey(metadata, "weakMembers", "members", normalized as object | symbol);
            }
          });
          sweepCollectionKeys(metadata);
          return true;
        });

        if (kind === "Map" && (key === "keys" || key === "values" || key === "entries" || key === Symbol.iterator)) return memoMethod(key, () => () => {
          trackAggregate(key === "keys" ? "keysIteration" : "entriesIteration");
          const iterator = key === "keys" ? Map.prototype.keys.call(target) : key === "values" ? Map.prototype.values.call(target) : Map.prototype.entries.call(target);
          const convert = key === "entries" || key === Symbol.iterator
            ? (item: unknown) => { const pair = item as [unknown, unknown]; return [wrapRead(pair[0]), wrapRead(pair[1])]; }
            : (item: unknown) => wrapRead(item);
          return wrapIterator(iterator as Iterator<unknown>, convert, "Map Iterator");
        });
        if (kind === "Set" && (key === "keys" || key === "values" || key === "entries" || key === Symbol.iterator)) return memoMethod(key, () => () => {
          trackAggregate("entriesIteration");
          const iterator = key === "entries" ? Set.prototype.entries.call(target) : Set.prototype.values.call(target);
          const convert = key === "entries"
            ? (item: unknown) => { const pair = item as [unknown, unknown]; const value = wrapRead(pair[0]); return [value, value]; }
            : (item: unknown) => wrapRead(item);
          return wrapIterator(iterator as Iterator<unknown>, convert, "Set Iterator");
        });
        if ((kind === "Map" || kind === "Set") && key === "forEach") return memoMethod(key, () => (callback: (value: unknown, key: unknown, collection: object) => void, thisArg?: unknown) => {
          if (typeof callback !== "function") throw new TypeError("callback must be a function");
          trackAggregate("entriesIteration");
          const native = kind === "Map" ? Map.prototype.forEach : Set.prototype.forEach;
          return Reflect.apply(native, target, [(value: unknown, entryKey: unknown) => Reflect.apply(callback, thisArg, [wrapRead(value), wrapRead(entryKey), proxy])]);
        });
        if (kind === "Set" && ["union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"].includes(String(key))) return memoMethod(key, () => {
          const producesSet = key === "union" || key === "intersection" || key === "difference" || key === "symmetricDifference";
          return (other: unknown) => {
            trackAggregate("entriesIteration");
            // Set methods consume `other` through the set-like protocol
            // (size/has/keys) against this raw target. Reading through a reactive
            // `other` keeps its tracking, but its keys come back as proxies and a
            // plain Set built from reactive iteration holds proxies too, so
            // members would never match the raw ones here. Hand native code a
            // record that compares raw identities in both directions.
            if (!producesSet) return Reflect.apply(method, target, [normalizedSetLike(other)]);
            const origins = new Map<unknown, unknown>();
            const result = Reflect.apply(method, target, [normalizedSetLike(other, origins)]) as Set<unknown>;
            // The native result holds raw members. Return a plain Set whose
            // members read like every other path: receiver members become
            // proxies; members that only came from `other` keep the identity
            // `other` held, except that a reactive collection's are proxies too.
            const fromReactive = isObjectLike(other) && toRaw(other) !== undefined;
            const wrapped = new Set<unknown>();
            for (const member of Set.prototype.values.call(result) as IterableIterator<unknown>) {
              if (Set.prototype.has.call(target, member)) wrapped.add(wrapRead(member));
              else {
                const original = origins.has(member) ? origins.get(member) : member;
                wrapped.add(fromReactive ? wrapRead(original) : original);
              }
            }
            return wrapped;
          };
        });
        // Map upsert methods, where the engine has them: compose them from the
        // reactive `has`/`get`/`set` so reads are tracked and inserts notify.
        // Calling the native method on the raw target would bypass both.
        if ((kind === "Map" || kind === "WeakMap") && key === "getOrInsert") return memoMethod(key, () => (entryKey: unknown, value: unknown) => {
          const map = proxy as Map<unknown, unknown>;
          if (!map.has(entryKey)) map.set(entryKey, value);
          return map.get(entryKey);
        });
        if ((kind === "Map" || kind === "WeakMap") && key === "getOrInsertComputed") return memoMethod(key, () => (entryKey: unknown, callback: unknown) => {
          // Spec order: a WeakMap rejects an unusable key before anything else,
          // then the callback must be callable; a Map canonicalizes -0 to +0
          // before the callback sees the key.
          if (kind === "WeakMap" && !isWeakCollectionKey(normalizeWeakKey(entryKey))) throw new TypeError("Invalid value used as weak map key");
          if (typeof callback !== "function") throw new TypeError("getOrInsertComputed callback must be a function");
          const map = proxy as Map<unknown, unknown>;
          const canonicalKey = kind === "Map" && Object.is(entryKey, -0) ? 0 : entryKey;
          if (map.has(canonicalKey)) return map.get(canonicalKey);
          map.set(canonicalKey, Reflect.apply(callback, undefined, [canonicalKey]));
          return map.get(canonicalKey);
        });
        if ((kind === "Map" || kind === "WeakMap") && key === "emplace") return memoMethod(key, () => () => {
          throw new TypeError("deepSignal() reactive collections do not support emplace; use getOrInsert or has/get/set");
        });
        return Reflect.get(target, key, target);
      },
      set() { throw new TypeError("deepSignal() reactive collections do not support own properties"); },
      deleteProperty() { throw new TypeError("deepSignal() reactive collections do not support own properties"); },
      defineProperty() { throw new TypeError("deepSignal() does not support collection property descriptors"); },
      preventExtensions() { throw new TypeError("deepSignal() reactive collections must remain extensible"); },
      setPrototypeOf() { throw new TypeError("deepSignal() does not support prototype mutation"); },
    });
    metadata.proxy = proxy;
    reactiveCollections.set(raw, metadata);
    proxyToRaw.set(proxy, raw);
    return proxy;
  }

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
   * deep proxy for a plain object/array or a collection.
   * `get` trap uses this to reject a non-configurable, non-writable property
   * whose value cannot be substituted, before `wrap()` performs the swap.
   */
  const isWrappedByValue = (value: unknown): boolean =>
    isPlainObjectOrArray(value) || value instanceof Map || value instanceof Set ||
    value instanceof WeakMap || value instanceof WeakSet;

  const wrap = <T>(value: T): T => {
    const rawValue = (toRaw(value) as T | undefined) ?? value;
    if (!isObjectLike(rawValue)) return rawValue;
    // Plain data first: it is the common case, and testing it once also
    // answers the collection check below for every non-plain value.
    if (!isPlainObjectOrArray(rawValue)) {
      if (!isStandardCollectionPrototype(rawValue)) return rawValue;
      const kind = (rawValue as object) instanceof Map ? "Map" : (rawValue as object) instanceof Set ? "Set" : (rawValue as object) instanceof WeakMap ? "WeakMap" : "WeakSet";
      return reactiveCollectionProxy(rawValue, kind) as T;
    }
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
        track(metadata, target, metadata.properties, metadata.propertyIndices, key);
        const result = Reflect.get(target, key, receiver);

        if (
          Array.isArray(target) &&
          ARRAY_MUTATORS.has(key) &&
          typeof result === "function"
        ) {
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

        if (
          Array.isArray(target) &&
          ARRAY_SEARCHES.has(key) &&
          typeof result === "function"
        ) {
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
        const rawNextValue = unwrap(nextValue);
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

        adapter.batch(() => adapter.untracked(() => {
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
        }));
        sweepPrunedKeys(metadata, target);

        return true;
      },

      deleteProperty(target, key) {
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const succeeded = Reflect.deleteProperty(target, key);
        if (!succeeded || !owned) return succeeded;

        adapter.batch(() => adapter.untracked(() => {
          notify(metadata.properties, key);
          // An own key was removed, which own-key existence checks observe even
          // when `in` still finds the key on the prototype.
          notify(metadata.existence, key);
          notifyIteration(metadata);
          markPrunable(metadata, key);
        }));
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

        descriptor.value = wrap(descriptor.value);
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

    constructor(source: DeepSignalSource<T>) {
      this.#source = source;
      const protocol = getReadableInterop(this.#source);
      if (protocol !== undefined) attachReadableInterop(this, protocol);
    }

    get value(): T {
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
  function inspectDeepSignalMetadata(value: object): {
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

  /** Primitive collection keys that still retain version metadata. */
  function inspectCollectionMetadata(value: object): {
    values: unknown[];
    existence: unknown[];
    members: unknown[];
  } | undefined {
    const metadata = reactiveCollections.get(toRaw(value) ?? value);
    if (metadata === undefined) return undefined;
    return {
      values: [...metadata.values.keys()],
      existence: [...metadata.existence.keys()],
      members: [...metadata.members.keys()],
    };
  }

  /**
   * Creates a signal that lazily tracks nested plain-object, array, and standard
   * collection reads. Mutations must go through `.value`; changes made through
   * the original raw value or `.peek()` are intentionally not observable.
   */
  function deepSignal<T extends object>(initialValue: T): DeepSignalLike<T> {
    const rawInitialValue = prepareDeepValue(initialValue);
    assertRootValue(rawInitialValue);

    wrap(rawInitialValue);
    const root = adapter.createSignal(rawInitialValue as T);
    const result = new DeepSignalImpl(root);
    adapter.registerDeepSignal?.(result);
    return result;
  }
  return { deepSignal, inspectDeepSignalMetadata, inspectCollectionMetadata };
}
