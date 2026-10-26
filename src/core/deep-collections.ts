// Reactive Map / Set / WeakMap / WeakSet support for the deep signal engine.
//
// This module is reached only through `deepCollectionSignal`, so an app that
// uses `deepSignal` alone never loads it. The engine in deep-signal-engine.ts
// owns the shared proxy cache and metadata; this module adds the collection
// proxies on top of it through the context the engine hands over.
import { plainResultIteratorNext } from "./plain-result-iterators.js";
import { isObjectLike } from "./deep-signal-engine.js";
import type { CollectionContext, CollectionSupport, DeepSignalSource } from "./deep-signal-engine.js";

type VersionSignal = DeepSignalSource<number>;

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

let weakSymbolKeys: boolean | undefined;
// Probed on first use, not at import, so loading this module has no effect.
function supportsWeakSymbolKeys(): boolean {
  return weakSymbolKeys ??= probeWeakSymbolKeys();
}
function probeWeakSymbolKeys(): boolean {
  try {
    const key = Symbol("weak-key-probe");
    const collection = new WeakMap<object, boolean>();
    Reflect.apply(WeakMap.prototype.set, collection, [key, true]);
    return Reflect.apply(WeakMap.prototype.get, collection, [key]) === true;
  } catch {
    return false;
  }
}

function isWeakCollectionKey(value: unknown): value is object | symbol {
  return isObjectLike(value) || (
    supportsWeakSymbolKeys()
    && typeof value === "symbol"
    // Native WeakMap/WeakSet accept non-registered symbols where supported,
    // but Symbol.for() symbols are shared registry entries and never valid
    // weak keys. Symbol.keyFor() returns undefined for local and well-known
    // symbols, both of which follow the native weak-key contract.
    && Symbol.keyFor(value) === undefined
  );
}


/** Builds the collection support for one engine; called once, on first use. */
export function createCollectionSupport(ctx: CollectionContext): CollectionSupport {
  setUpReactiveCollectionIterator();
  const { adapter, shouldTrackDeepRead, toRaw, proxyToRaw, normalizedProxyCarriers, isPlainObjectOrArray } = ctx;
  const reactiveCollections = new WeakMap<object, CollectionMetadata>();
  const scheduledCollectionSweeps = new WeakSet<CollectionMetadata>();
  const hasLinkedSubscribers = (version: VersionSignal): boolean =>
    (adapter.hasLinkedSubscribers ?? adapter.hasSubscribers)(version);
  let support: CollectionSupport;
  const unwrap = <T>(value: T): T => ctx.prepareDeepValue(value, support);
  const wrap = <T>(value: T): T => ctx.wrap(value, support);

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

  function assertReactiveCollection(value: object): void {
    if (!Object.isExtensible(value)) throw new TypeError("deepSignal() cannot proxy a non-extensible collection");
    if (Reflect.ownKeys(value).length !== 0) {
      throw new TypeError("deepSignal() reactive collections do not support own properties");
    }
  }

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


  function proxyFor(raw: object): object {
    const kind = raw instanceof Map ? "Map" : raw instanceof Set ? "Set" : raw instanceof WeakMap ? "WeakMap" : "WeakSet";
    return reactiveCollectionProxy(raw, kind);
  }

  support = {
    kindOf: getNativeCollectionKind,
    isStandard: isStandardCollection,
    isStandardPrototype: isStandardCollectionPrototype,
    assertReactive: assertReactiveCollection,
    proxyFor,
    inspect: inspectCollectionMetadata,
  };
  return support;
}
