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
  /** `batch(() => untracked(callback))` in one frame; defaults to exactly that. */
  batchUntracked?<T>(callback: () => T): T;
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
export type CollectionKind = "Map" | "Set" | "WeakMap" | "WeakSet";

export interface CollectionSupport {
  /**
   * The brand of a standard collection, including one from another realm or
   * one whose prototype chain still reaches a collection prototype. See
   * `collectionKindOf` for the replaced-prototype cases it does not detect.
   */
  kindOf(value: unknown): CollectionKind | undefined;
  isStandard(value: unknown): boolean;
  /** `isStandard` for a value already known not to be plain data. */
  isStandardPrototype(value: object): boolean;
  assertReactive(value: object): void;
  proxyFor(raw: object): object;
  inspect(value: object): { values: unknown[]; existence: unknown[]; members: unknown[] } | undefined;
}

/**
 * The state a chunked sweep keeps between timer turns, on the metadata object
 * it sweeps. `prunableRevision` counts candidate additions.
 */
export interface SweepState {
  prunableRevision?: number | undefined;
  prunableSweepIterator?: Iterator<unknown> | undefined;
  prunableSweepRevision?: number | undefined;
  /** An unsettled pass of the current iteration kept read-only candidates for a settled one. */
  prunableSweepDeferred?: boolean | undefined;
}

/** What one kind of metadata sweeps; see `runSweep`. */
export interface SweepPlan<M extends SweepState> {
  /** Candidates left; 0 ends the sweep. */
  size(metadata: M): number;
  begin(metadata: M): Iterator<unknown>;
  /** Drops what `release` allows of one candidate's version sources. */
  visit(metadata: M, candidate: unknown, release: (version: DeepSignalSource<number> | undefined) => boolean): void;
  /** Called once no candidates are left. */
  finish?(metadata: M): void;
}

/** Engine internals the collection module builds on. */
export interface CollectionContext {
  readonly adapter: DeepSignalRuntimeAdapter;
  /** How every deep write notifies: batched, and without subscribing the running effect. */
  batchUntracked<T>(callback: () => T): T;
  shouldTrackDeepRead(): boolean;
  toRaw(value: unknown): object | undefined;
  readonly proxyToRaw: WeakMap<object, object>;
  lookupIdentity(value: object, support: CollectionSupport | undefined): unknown;
  collectionKindOf(value: unknown): CollectionKind | undefined;
  runSweep<M extends SweepState>(metadata: M, plan: SweepPlan<M>, settled?: boolean): void;
  scheduleSweep<M extends SweepState>(metadata: M, plan: SweepPlan<M>, yieldToTask: boolean): void;
  isPlainObjectOrArray(value: unknown): value is object;
  prepareDeepValue<T>(value: T, support: CollectionSupport | undefined): T;
  wrap<T>(value: T, support: CollectionSupport | undefined): T;
}

interface PropertyMetadata extends SweepState {
  /** The mode this object was first wrapped in; `undefined` is plain `deepSignal`. */
  support: CollectionSupport | undefined;
  properties: Map<PropertyKey, VersionSignal>;
  existence: Map<PropertyKey, VersionSignal>;
  propertyIndices: Set<number>;
  existenceIndices: Set<number>;
  iteration?: DeepSignalSource<number>;
  arrayMethods: Map<PropertyKey, { method: (...args: unknown[]) => unknown; wrapper: (...args: unknown[]) => unknown }>;
  prunable?: Set<PropertyKey> | undefined;
  onUnwatched?: (() => void) | undefined;
  proxy: object;
}

type VersionSignal = DeepSignalSource<number>;

/**
 * A deep-state error, named after the API the state belongs to: `undefined`
 * is plain `deepSignal`, anything else (the collection mode's support, or
 * `"collection"` inside the collection module) is `deepCollectionSignal`.
 */
export function deepError(support: CollectionSupport | undefined | "collection", text: string): TypeError {
  return new TypeError(`${support === undefined ? "deepSignal()" : "deepCollectionSignal()"} ${text}`);
}

/** Message texts both the plain and the collection proxies throw. */
export const PROTOTYPE_MUTATION = "does not support prototype mutation";

export function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

const ACCESSOR_PROPERTIES = "does not support accessor properties";

function assertExtensible(value: object, support: CollectionSupport | undefined): void {
  if (!Object.isExtensible(value)) throw deepError(support, "cannot proxy a non-extensible object or array");
}

function assertDataProperties(value: object, support: CollectionSupport | undefined): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) throw deepError(support, ACCESSOR_PROPERTIES);
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

/** `collectionKindOf` for a value already known not to be plain data. */
function nonPlainCollectionKind(value: object): CollectionKind | undefined {
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
  try {
    Map.prototype.has.call(value, probe);
    return "Map";
  } catch {
    /* try next brand */
  }
  try {
    Set.prototype.has.call(value, probe);
    return "Set";
  } catch {
    /* try next brand */
  }
  try {
    WeakMap.prototype.has.call(value, probe);
    return "WeakMap";
  } catch {
    /* try next brand */
  }
  try {
    WeakSet.prototype.has.call(value, probe);
    return "WeakSet";
  } catch {
    /* not a collection */
  }
  return undefined;
}

function modeError(): TypeError {
  return new TypeError(
    "deepSignal() and deepCollectionSignal() cannot share the same plain object or array; keep each object in one kind of signal",
  );
}

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
  const scheduledSweeps = new WeakSet<SweepState>();
  // A carrier that contains one of our proxies has to be copied before it can be
  // stored. Remember that copy so assigning the same carrier again preserves the
  // same identity and aliases, just like assigning an ordinary raw object does.
  const normalizedProxyCarriers = new WeakMap<object, object>();
  // The mode each cached carrier copy was made for; `null` is plain `deepSignal`.
  const carrierSupports = new WeakMap<object, CollectionSupport | null>();
  let collectionSupport: CollectionSupport | undefined;
  const isSpeculative = adapter.isSpeculative ?? (() => false);
  const batchUntracked: <T>(callback: () => T) => T =
    adapter.batchUntracked ?? ((callback) => adapter.batch(() => adapter.untracked(callback)));
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
   * The brand of a standard collection, including one from another realm. The
   * one collection test of both modes: plain `deepSignal` inspects a
   * collection's entries as an opaque value, and the collection mode decides
   * which collections it proxies.
   *
   * It does not detect a collection whose prototype was replaced so that it no
   * longer reaches a collection prototype. Telling those apart costs four
   * throwing internal-slot probes per value, so they are skipped where the
   * value is far more likely something else:
   * - prototype `null` or `Object.prototype`: counts as a plain object, as an
   *   empty `Object.create(null)` dictionary is;
   * - any other chain that reaches this realm's `Object.prototype`: counts as
   *   an opaque value, as a Date or a class instance is, and its entries are
   *   not inspected.
   * The guides tell users not to store such a collection.
   */
  function collectionKindOf(value: unknown): CollectionKind | undefined {
    return isObjectLike(value) && !isPlainObjectOrArray(value) ? nonPlainCollectionKind(value) : undefined;
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
    // The collection module (and its brand probe) is not loaded here, so read
    // the tag: a collection from another realm gets the same hint.
    if (/^\[object (?:Weak)?(?:Map|Set)\]$/.test(Object.prototype.toString.call(value))) {
      throw new TypeError(
        "deepSignal() does not track Map, Set, WeakMap or WeakSet; use deepCollectionSignal() for a collection root",
      );
    }
    throw new TypeError("deepSignal() only accepts plain objects and arrays");
  }

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
          throw deepError(
            support,
            proxyToRaw.has(current)
              ? "cannot store a deep proxy inside an opaque value"
              : "cannot store a deep collection view inside an opaque value",
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
        throw deepError(support, "cannot store a built-in prototype object in deep state");
      }

      const plain = isPlainObjectOrArray(raw);
      const kind = plain ? undefined : nonPlainCollectionKind(raw);
      if (kind !== undefined && !insideOpaque && support !== undefined && !support.isStandard(raw)) {
        throw deepError(support, "collections require same-realm standard collections");
      }

      // Without collection support a Map or Set is an opaque value like a
      // Date: its entries are only inspected so a deep proxy cannot slip into
      // the raw graph through one. The intrinsic methods read the entries of a
      // collection from another realm too.
      if (kind === "Map" || kind === "Set") {
        const opaque = insideOpaque || support === undefined;
        if (!opaque) support.assertReactive(raw);
        const inspect = (entry: unknown, key: unknown) => {
          if (kind === "Map" && isObjectLike(key)) pending.push({ value: key, insideOpaque: opaque });
          if (isObjectLike(entry)) pending.push({ value: entry, insideOpaque: opaque });
        };
        if (kind === "Map") Map.prototype.forEach.call(raw, inspect);
        else Set.prototype.forEach.call(raw, inspect);
        continue;
      }
      if (kind !== undefined) {
        if (!insideOpaque && support !== undefined) support.assertReactive(raw);
        continue;
      }
      if (!plain) {
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
        assertExtensible(raw, support);
        assertDataProperties(raw, support);
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
          if (target.has(normalizedKey)) throw deepError(support, "collection keys collide after proxy normalization");
          target.set(normalizedKey, resolveCollectionEntry(entry));
        }
      } else if (source instanceof Set && target instanceof Set) {
        for (const entry of source) {
          const normalized = resolveCollectionEntry(entry);
          if (target.has(normalized)) throw deepError(support, "Set members collide after proxy normalization");
          target.add(normalized);
        }
      } else {
        for (const key of Reflect.ownKeys(source)) {
          if (Array.isArray(source) && key === "length") continue;
          const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
          if (descriptor === undefined) continue;
          if (!("value" in descriptor)) throw deepError(support, ACCESSOR_PROPERTIES);
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

  /**
   * The identity a lookup (`includes`/`indexOf`, a collection's `has`/`get`/
   * `delete`) compares against stored raw data: a proxy's raw target, or the
   * copy a carrier was normalized into for this mode when it was stored. Unlike
   * a write (`prepareDeepValue`), it does not re-validate the carrier's graph:
   * that would make every lookup O(graph) and throw for values merely absent.
   */
  function lookupIdentity(value: object, support: CollectionSupport | undefined): unknown {
    const raw = toRaw(value);
    if (raw !== undefined) return raw;
    const carrier = normalizedProxyCarriers.get(value);
    return carrier !== undefined && carrierSupports.get(value) === (support ?? null) ? carrier : value;
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
        if (metadata.prunable?.size) schedulePropertySweep(metadata);
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
      schedulePropertySweep(metadata);
    }
  };

  // Sweeps drop version signals for absent keys (and lookup-only collection
  // keys) once they have no subscribers left, so dynamic lookups and
  // repeatedly-spliced lists do not retain every key they have ever read.
  const hasLinkedSubscribers = (version: VersionSignal): boolean =>
    (adapter.hasLinkedSubscribers ?? adapter.hasSubscribers)(version);
  const retireVersion = (version: VersionSignal): void => {
    adapter.untracked(() => {
      version.value = version.peek() + 1;
    });
  };
  const clearSweep = (metadata: SweepState): void => {
    metadata.prunableSweepIterator = undefined;
    metadata.prunableSweepRevision = undefined;
    metadata.prunableSweepDeferred = undefined;
  };

  /**
   * One chunk of a sweep, shared by object properties and collection keys.
   *
   * The synchronous sweep that follows a write (`settled` false) drops only
   * versions nothing has read since their last write, so an unrelated write
   * never invalidates a render still in progress. A version read but not
   * linked yet (a render in progress, or a reader already gone) is left to a
   * settled sweep in a later task, which drops by actual graph links and
   * advances each dropped version once more: a render attempt that read it
   * but has not subscribed yet sees the revision change at commit and
   * re-renders onto a fresh version.
   *
   * Runs only at batch depth 0, where the write that queued the candidates has
   * already flushed its effects; before that, `hasSubscribers()` would still
   * report the pre-flush picture, so a sweep inside a batch is queued instead.
   * Large candidate sets are drained over timer turns, so each write pays a
   * fixed synchronous budget and the browser can paint between chunks.
   */
  function runSweep<M extends SweepState>(metadata: M, plan: SweepPlan<M>, settled = false): void {
    if (plan.size(metadata) === 0) return;
    if (adapter.getBatchDepth() !== 0) {
      scheduleSweep(metadata, plan, false);
      return;
    }
    let iterator = metadata.prunableSweepIterator;
    if (iterator === undefined) {
      iterator = plan.begin(metadata);
      metadata.prunableSweepIterator = iterator;
      metadata.prunableSweepRevision = metadata.prunableRevision ?? 0;
      metadata.prunableSweepDeferred = false;
    }
    const release = (version: VersionSignal | undefined): boolean => {
      if (version === undefined) return true;
      if (settled) {
        if (hasLinkedSubscribers(version)) return false;
        retireVersion(version);
        return true;
      }
      if (!adapter.hasSubscribers(version)) return true;
      if (adapter.hasLinkedSubscribers !== undefined && !adapter.hasLinkedSubscribers(version)) {
        metadata.prunableSweepDeferred = true;
      }
      return false;
    };
    for (let processed = 0; processed < 128; processed += 1) {
      const next = iterator.next();
      if (next.done === true) {
        const revised = metadata.prunableSweepRevision !== (metadata.prunableRevision ?? 0);
        // A chunk that ran unsettled (the first one after a write, or a write
        // landing in the middle of a settled iteration) kept candidates for a
        // settled pass, which may have resumed past them: revisit them all in a
        // fresh settled pass. A settled chunk never defers, so this ends.
        const deferred = metadata.prunableSweepDeferred === true;
        clearSweep(metadata);
        if (plan.size(metadata) === 0) plan.finish?.(metadata);
        else if (revised || deferred) scheduleSweep(metadata, plan, true);
        return;
      }
      // Avoid spelling this as `.value`: the managed transform treats static
      // `.value` reads as signal reads and would capture this iterator result.
      plan.visit(metadata, Reflect.get(next, "value"), release);
    }
    if (plan.size(metadata) === 0) {
      clearSweep(metadata);
      plan.finish?.(metadata);
      return;
    }
    // The live iterator also sees candidates appended meanwhile.
    scheduleSweep(metadata, plan, true);
  }

  function scheduleSweep<M extends SweepState>(metadata: M, plan: SweepPlan<M>, yieldToTask: boolean): void {
    if (scheduledSweeps.has(metadata)) return;
    scheduledSweeps.add(metadata);
    const resume = () => {
      scheduledSweeps.delete(metadata);
      runSweep(metadata, plan, yieldToTask);
    };
    if (yieldToTask) setTimeout(resume, 0);
    else queueMicrotask(resume);
  }

  /** Missing keys of a plain object or array. */
  const propertySweep: SweepPlan<PropertyMetadata> = {
    size: (metadata) => metadata.prunable?.size ?? 0,
    begin: (metadata) => metadata.prunable!.values(),
    visit(metadata, candidate, release) {
      const key = candidate as PropertyKey;
      const target = proxyToRaw.get(metadata.proxy)!;
      // The key came back (an index was written again, a property re-added):
      // its version signals are live metadata again, not garbage.
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        metadata.prunable!.delete(key);
        return;
      }
      // Each version is dropped on its own, as the collection sweep does: a
      // settled release retires a version, so one kept only because its sibling
      // is still linked would be retired again on every later sweep.
      const index = isArrayIndex(key) ? Number(key) : undefined;
      if (metadata.properties.has(key) && release(metadata.properties.get(key))) {
        metadata.properties.delete(key);
        if (index !== undefined) metadata.propertyIndices.delete(index);
      }
      if (metadata.existence.has(key) && release(metadata.existence.get(key))) {
        metadata.existence.delete(key);
        if (index !== undefined) metadata.existenceIndices.delete(index);
      }
      if (!metadata.properties.has(key) && !metadata.existence.has(key)) metadata.prunable!.delete(key);
    },
    finish(metadata) {
      metadata.prunable = undefined;
    },
  };
  const sweepPrunedKeys = (metadata: PropertyMetadata): void => runSweep(metadata, propertySweep);
  const schedulePropertySweep = (metadata: PropertyMetadata): void => scheduleSweep(metadata, propertySweep, true);

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
    assertExtensible(rawValue, support);

    const cached = rawToMetadata.get(rawValue);
    if (cached !== undefined) {
      if (cached.support !== support) throw modeError();
      return cached.proxy as T;
    }
    assertDataProperties(rawValue, support);

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
              return batchUntracked(() => Reflect.apply(method, this, args));
            } finally {
              sweepPrunedKeys(metadata);
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
            args[0] = lookupIdentity(args[0], support);
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
            throw deepError(support, "cannot wrap a non-configurable, non-writable object property");
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
          throw deepError(support, PROTOTYPE_MUTATION);
        }
        // Storing the brand would make this subtree answer `isSignal()`, which
        // silently stops it from being wrapped and kills its reactivity.
        if (key === SIGNAL_BRAND) {
          throw deepError(support, "does not support branding state as a signal");
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

        batchUntracked(() => {
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
        });
        sweepPrunedKeys(metadata);

        return true;
      },

      deleteProperty(target, key) {
        const owned = Object.prototype.hasOwnProperty.call(target, key);
        const succeeded = Reflect.deleteProperty(target, key);
        if (!succeeded || !owned) return succeeded;

        batchUntracked(() => {
          notify(metadata.properties, key);
          // An own key was removed, which own-key existence checks observe even
          // when `in` still finds the key on the prototype.
          notify(metadata.existence, key);
          notifyIteration(metadata);
          markPrunable(metadata, key);
        });
        sweepPrunedKeys(metadata);
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
        throw deepError(support, "does not support property descriptors");
      },

      preventExtensions() {
        throw deepError(support, "state must remain extensible");
      },

      setPrototypeOf() {
        throw deepError(support, PROTOTYPE_MUTATION);
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
    batchUntracked,
    shouldTrackDeepRead,
    toRaw,
    proxyToRaw,
    lookupIdentity,
    collectionKindOf,
    runSweep,
    scheduleSweep,
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
