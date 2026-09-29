import { a as attachReadableInterop, c as isInteropSpeculative, i as untrackedRender, l as markInteropSpeculativeDeepRead, n as hasActiveRenderCollector, o as getReadableInterop, r as notifyListener, s as getSharedInteropContext, t as coreRuntime, u as executionContext } from "./core-runtime-Dqo8e5cK.js";
import { a as registerSignal, c as SIGNAL_BRAND, i as isSignal, n as computed, o as signal, r as effect, s as untracked, t as batch } from "./base-BmMmSiK1.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
//#region src/core/deep-signal-engine.ts
function isObjectLike(value) {
	return typeof value === "object" && value !== null || typeof value === "function";
}
function assertExtensible(value) {
	if (!Object.isExtensible(value)) throw new TypeError("deepSignal() cannot proxy a non-extensible object or array");
}
function assertDataProperties(value) {
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		if (descriptor !== void 0 && !("value" in descriptor)) throw new TypeError("deepSignal() does not support accessor properties");
	}
}
function emptyArrayOfLength(length) {
	const result = [];
	result.length = length;
	return result;
}
function isArrayIndex(key) {
	if (typeof key !== "string" || key === "") return false;
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key;
}
const notify = (versions, key) => {
	const version = versions.get(key);
	if (version !== void 0) version.value += 1;
};
const markPrunable = (metadata, key) => {
	if (!metadata.properties.has(key) && !metadata.existence.has(key)) return;
	(metadata.prunable ??= /* @__PURE__ */ new Set()).add(key);
};
const notifyIteration = (metadata) => {
	if (metadata.iteration !== void 0) metadata.iteration.value += 1;
};
function createDeepSignalFactory(adapter) {
	const ARRAY_MUTATORS = /* @__PURE__ */ new Set([
		"copyWithin",
		"fill",
		"pop",
		"push",
		"reverse",
		"shift",
		"sort",
		"splice",
		"unshift"
	]);
	const proxyToRaw = /* @__PURE__ */ new WeakMap();
	const rawToMetadata = /* @__PURE__ */ new WeakMap();
	const readonlyMapViews = /* @__PURE__ */ new WeakMap();
	const readonlySetViews = /* @__PURE__ */ new WeakMap();
	const readonlyCollectionViewToRaw = /* @__PURE__ */ new WeakMap();
	const normalizedProxyCarriers = /* @__PURE__ */ new WeakMap();
	const isSpeculative = adapter.isSpeculative ?? isInteropSpeculative;
	const markSpeculativeDeepRead = adapter.markSpeculativeDeepRead ?? markInteropSpeculativeDeepRead;
	function shouldTrackDeepRead() {
		if (isSpeculative()) {
			markSpeculativeDeepRead();
			return false;
		}
		const shared = getSharedInteropContext();
		return adapter.hasActiveSubscriber() || hasActiveRenderCollector() || shared.graphCollector !== void 0 || shared.renderCollector !== void 0;
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
	const INTRINSIC_PROTOTYPES = (() => {
		const prototypes = /* @__PURE__ */ new Set();
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
			"DataView"
		]) {
			const intrinsic = globalThis[name];
			if (typeof intrinsic !== "function") continue;
			const prototype = intrinsic.prototype;
			if (typeof prototype === "object" && prototype !== null || typeof prototype === "function") prototypes.add(prototype);
		}
		return prototypes;
	})();
	const isIntrinsicPrototype = (value) => isObjectLike(value) && INTRINSIC_PROTOTYPES.has(value);
	function isPlainObjectOrArray(value) {
		if (typeof value !== "object" || value === null || adapter.isSignal(value)) return false;
		if (INTRINSIC_PROTOTYPES.has(value)) return false;
		if (Array.isArray(value)) return true;
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	}
	/**
	* Resolves a value that may be one of our proxies or one of our readonly
	* collection views back to the raw object it wraps. Returns `undefined` when
	* `value` is not object-like or is not a value this module has wrapped, so
	* callers can fall back to using it as-is.
	*/
	function toRaw(value) {
		if (!isObjectLike(value)) return void 0;
		const directRaw = proxyToRaw.get(value);
		if (directRaw !== void 0) return directRaw;
		return readonlyCollectionViewToRaw.get(value);
	}
	/**
	* Shared scaffolding for `readonlyMapView`/`readonlySetView`: cache lookup,
	* the "reject this mutation" factory, defining the descriptors, the
	* feature-detected extras loop, and the dual-WeakMap registration. Only the
	* per-type descriptor bodies (which truly differ between Map and Set) and
	* the extras list are supplied by the caller.
	*/
	function createReadonlyCollectionView(raw, cache, prototype, kind, buildCore, buildExtras) {
		const cached = cache.get(raw);
		if (cached !== void 0) return cached;
		const view = Object.create(prototype);
		const rejectMutation = (operation) => () => {
			throw new TypeError(`deepSignal() ${kind}#${operation}() is not allowed through .value; replace the ${kind} immutably`);
		};
		Object.defineProperties(view, buildCore(raw, view, rejectMutation));
		for (const [name, impl] of buildExtras(raw, rejectMutation)) Object.defineProperty(view, name, {
			enumerable: false,
			configurable: false,
			value: impl
		});
		cache.set(raw, view);
		readonlyCollectionViewToRaw.set(view, raw);
		return view;
	}
	function readonlyMapView(raw) {
		return createReadonlyCollectionView(raw, readonlyMapViews, Map.prototype, "Map", (target, view, rejectMutation) => ({
			size: {
				enumerable: false,
				configurable: false,
				get: () => target.size
			},
			get: {
				enumerable: false,
				configurable: false,
				value: (key) => target.get(key)
			},
			has: {
				enumerable: false,
				configurable: false,
				value: (key) => target.has(key)
			},
			entries: {
				enumerable: false,
				configurable: false,
				value: () => Map.prototype.entries.call(target)
			},
			keys: {
				enumerable: false,
				configurable: false,
				value: () => Map.prototype.keys.call(target)
			},
			values: {
				enumerable: false,
				configurable: false,
				value: () => Map.prototype.values.call(target)
			},
			forEach: {
				enumerable: false,
				configurable: false,
				value: (callback, thisArg) => {
					Map.prototype.forEach.call(target, (value, key) => callback.call(thisArg, value, key, view));
				}
			},
			[Symbol.iterator]: {
				enumerable: false,
				configurable: false,
				value: () => Map.prototype.entries.call(target)
			},
			set: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("set")
			},
			delete: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("delete")
			},
			clear: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("clear")
			}
		}), (_target, rejectMutation) => {
			const extras = [];
			for (const operation of [
				"getOrInsert",
				"getOrInsertComputed",
				"emplace"
			]) if (typeof Map.prototype[operation] === "function") extras.push([operation, rejectMutation(operation)]);
			return extras;
		});
	}
	function readonlySetView(raw) {
		return createReadonlyCollectionView(raw, readonlySetViews, Set.prototype, "Set", (target, view, rejectMutation) => ({
			size: {
				enumerable: false,
				configurable: false,
				get: () => target.size
			},
			has: {
				enumerable: false,
				configurable: false,
				value: (value) => target.has(value)
			},
			entries: {
				enumerable: false,
				configurable: false,
				value: () => Set.prototype.entries.call(target)
			},
			keys: {
				enumerable: false,
				configurable: false,
				value: () => Set.prototype.keys.call(target)
			},
			values: {
				enumerable: false,
				configurable: false,
				value: () => Set.prototype.values.call(target)
			},
			forEach: {
				enumerable: false,
				configurable: false,
				value: (callback, thisArg) => {
					Set.prototype.forEach.call(target, (value) => callback.call(thisArg, value, value, view));
				}
			},
			[Symbol.iterator]: {
				enumerable: false,
				configurable: false,
				value: () => Set.prototype.values.call(target)
			},
			add: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("add")
			},
			delete: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("delete")
			},
			clear: {
				enumerable: false,
				configurable: false,
				value: rejectMutation("clear")
			}
		}), (target) => {
			const extras = [];
			const forwardSetOperation = (operation) => (other) => {
				const method = Set.prototype[operation];
				if (typeof method !== "function") throw new TypeError(`Set#${operation}() is unavailable in this JavaScript engine`);
				const collection = isObjectLike(other) ? readonlyCollectionViewToRaw.get(other) ?? other : other;
				return Reflect.apply(method, target, [collection]);
			};
			for (const operation of [
				"union",
				"intersection",
				"difference",
				"symmetricDifference",
				"isSubsetOf",
				"isSupersetOf",
				"isDisjointFrom"
			]) if (typeof Set.prototype[operation] === "function") extras.push([operation, forwardSetOperation(operation)]);
			return extras;
		});
	}
	function assertRootValue(value) {
		if (!isPlainObjectOrArray(value)) throw new TypeError("deepSignal() only accepts a plain object or array root");
	}
	function assertDeepDataGraph(value) {
		if (!isObjectLike(value)) return false;
		const seen = /* @__PURE__ */ new WeakMap();
		const pending = [{
			value,
			insideOpaque: false
		}];
		let needsNormalization = false;
		while (pending.length > 0) {
			const { value: current, insideOpaque } = pending.pop();
			if (toRaw(current) !== void 0) {
				if (insideOpaque) throw new TypeError(proxyToRaw.has(current) ? "deepSignal() cannot store a deep proxy inside an opaque value" : "deepSignal() cannot store a deep collection view inside an opaque value");
				needsNormalization = true;
				continue;
			}
			const raw = current;
			const visitedAs = seen.get(raw) ?? 0;
			const visitFlag = insideOpaque ? 2 : 1;
			if ((visitedAs & visitFlag) !== 0) continue;
			seen.set(raw, visitedAs | visitFlag);
			if (!insideOpaque && isIntrinsicPrototype(raw)) throw new TypeError("deepSignal() cannot store a built-in prototype object in deep state");
			if (raw instanceof Map) {
				for (const [key, entry] of raw) {
					if (isObjectLike(key)) pending.push({
						value: key,
						insideOpaque: true
					});
					if (isObjectLike(entry)) pending.push({
						value: entry,
						insideOpaque: true
					});
				}
				continue;
			}
			if (raw instanceof Set) {
				for (const entry of raw) if (isObjectLike(entry)) pending.push({
					value: entry,
					insideOpaque: true
				});
				continue;
			}
			if (!isPlainObjectOrArray(raw)) {
				for (const key of Reflect.ownKeys(raw)) {
					const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
					if (descriptor !== void 0 && "value" in descriptor && isObjectLike(descriptor.value)) pending.push({
						value: descriptor.value,
						insideOpaque: true
					});
				}
				continue;
			}
			if (!insideOpaque) {
				assertExtensible(raw);
				assertDataProperties(raw);
			}
			for (const key of Reflect.ownKeys(raw)) {
				const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
				if (descriptor !== void 0 && "value" in descriptor) {
					const child = descriptor.value;
					if (isObjectLike(child)) pending.push({
						value: child,
						insideOpaque
					});
				}
			}
		}
		return needsNormalization;
	}
	function matchesNormalizedGraph(source, normalized) {
		const sources = /* @__PURE__ */ new WeakMap();
		const targets = /* @__PURE__ */ new WeakMap();
		const pending = [[source, normalized]];
		while (pending.length > 0) {
			const [currentSource, currentTarget] = pending.pop();
			if (typeof currentSource !== "object" || currentSource === null) {
				if (!Object.is(currentSource, currentTarget)) return false;
				continue;
			}
			const wrapperRaw = toRaw(currentSource);
			if (wrapperRaw !== void 0) {
				if (wrapperRaw !== currentTarget) return false;
				continue;
			}
			if (!isPlainObjectOrArray(currentSource)) {
				if (currentSource !== currentTarget) return false;
				continue;
			}
			if (typeof currentTarget !== "object" || currentTarget === null || !isPlainObjectOrArray(currentTarget)) return false;
			const knownTarget = sources.get(currentSource);
			if (knownTarget !== void 0) {
				if (knownTarget !== currentTarget) return false;
				continue;
			}
			const knownSource = targets.get(currentTarget);
			if (knownSource !== void 0 && knownSource !== currentSource) return false;
			sources.set(currentSource, currentTarget);
			targets.set(currentTarget, currentSource);
			if (Array.isArray(currentSource) !== Array.isArray(currentTarget) || Object.getPrototypeOf(currentSource) !== Object.getPrototypeOf(currentTarget)) return false;
			const sourceKeys = Reflect.ownKeys(currentSource);
			const targetKeys = Reflect.ownKeys(currentTarget);
			if (sourceKeys.length !== targetKeys.length) return false;
			for (const [index, key] of sourceKeys.entries()) {
				if (key !== targetKeys[index]) return false;
				const sourceDescriptor = Reflect.getOwnPropertyDescriptor(currentSource, key);
				const targetDescriptor = Reflect.getOwnPropertyDescriptor(currentTarget, key);
				if (sourceDescriptor === void 0 || targetDescriptor === void 0 || !("value" in sourceDescriptor) || !("value" in targetDescriptor) || sourceDescriptor.configurable !== targetDescriptor.configurable || sourceDescriptor.enumerable !== targetDescriptor.enumerable || sourceDescriptor.writable !== targetDescriptor.writable) return false;
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
	function cloneWithoutProxies(value) {
		const wrapperRaw = toRaw(value);
		if (wrapperRaw !== void 0) return wrapperRaw;
		if (!isObjectLike(value)) return value;
		const cachedRoot = normalizedProxyCarriers.get(value);
		if (cachedRoot !== void 0 && matchesNormalizedGraph(value, cachedRoot)) return cachedRoot;
		const clones = /* @__PURE__ */ new WeakMap();
		const created = [];
		const pending = [];
		const resolve = (current) => {
			const resolvedRaw = toRaw(current);
			if (resolvedRaw !== void 0) return resolvedRaw;
			if (!isPlainObjectOrArray(current)) return current;
			const local = clones.get(current);
			if (local !== void 0) return local;
			const result = Array.isArray(current) ? emptyArrayOfLength(current.length) : Object.create(Object.getPrototypeOf(current));
			clones.set(current, result);
			created.push([current, result]);
			pending.push(current);
			return result;
		};
		const root = resolve(value);
		while (pending.length > 0) {
			const source = pending.pop();
			const target = clones.get(source);
			for (const key of Reflect.ownKeys(source)) {
				if (Array.isArray(source) && key === "length") continue;
				const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
				if (descriptor === void 0) continue;
				if (!("value" in descriptor)) throw new TypeError("deepSignal() does not support accessor properties");
				descriptor.value = resolve(descriptor.value);
				Reflect.defineProperty(target, key, descriptor);
			}
		}
		for (const [source, target] of created) normalizedProxyCarriers.set(source, target);
		return root;
	}
	function prepareDeepValue(value) {
		const wrapperRaw = toRaw(value);
		if (wrapperRaw !== void 0) return wrapperRaw;
		return assertDeepDataGraph(value) ? cloneWithoutProxies(value) : value;
	}
	const unwrap = (value) => {
		return prepareDeepValue(value);
	};
	const OBJECT_PROTOTYPE_KEYS = new Set(Reflect.ownKeys(Object.prototype));
	const ARRAY_PROTOTYPE_KEYS = /* @__PURE__ */ new Set([...Reflect.ownKeys(Object.prototype), ...Reflect.ownKeys(Array.prototype)]);
	const isInheritedPrototypeMember = (target, key) => {
		if (Object.prototype.hasOwnProperty.call(target, key)) return false;
		const prototype = Object.getPrototypeOf(target);
		if (prototype === Object.prototype) return OBJECT_PROTOTYPE_KEYS.has(key);
		if (prototype === Array.prototype) return ARRAY_PROTOTYPE_KEYS.has(key);
		return false;
	};
	const getVersion = (versions, key) => {
		let version = versions.get(key);
		if (version === void 0) {
			version = adapter.createSignal(0);
			versions.set(key, version);
		}
		return version;
	};
	const track = (target, versions, indices, key) => {
		if (!shouldTrackDeepRead()) return;
		if (isInheritedPrototypeMember(target, key)) return;
		if (isArrayIndex(key)) indices.add(Number(key));
		const version = getVersion(versions, key);
		adapter.markWatched(version);
		version.value;
	};
	/**
	* Queues `key`'s version signals for removal once nothing depends on them.
	* Only called for a key that has just been removed *and* notified, which is
	* what makes the eventual removal safe: the notification forces every
	* subscriber to re-run, so one that still cares re-reads the key (re-arming
	* `markWatched`) and one that does not has already been unlinked.
	*/
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
	const sweepPrunedKeys = (metadata, target) => {
		const prunable = metadata.prunable;
		if (prunable === void 0 || prunable.size === 0) return;
		if (adapter.getBatchDepth() !== 0) return;
		for (const key of prunable) {
			if (Object.prototype.hasOwnProperty.call(target, key)) {
				prunable.delete(key);
				continue;
			}
			const property = metadata.properties.get(key);
			const existence = metadata.existence.get(key);
			if (property !== void 0 && adapter.hasSubscribers(property) || existence !== void 0 && adapter.hasSubscribers(existence)) continue;
			metadata.properties.delete(key);
			metadata.existence.delete(key);
			if (isArrayIndex(key)) {
				const index = Number(key);
				metadata.propertyIndices.delete(index);
				metadata.existenceIndices.delete(index);
			}
			prunable.delete(key);
		}
		if (prunable.size === 0) metadata.prunable = void 0;
	};
	const trackIteration = (metadata) => {
		if (!shouldTrackDeepRead()) return;
		metadata.iteration ??= adapter.createSignal(0);
		metadata.iteration.value;
	};
	const notifyTruncatedIndices = (metadata, currentLength, oldLength) => {
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
		for (const index of metadata.propertyIndices) if (index >= currentLength && index < oldLength) {
			const key = String(index);
			notify(metadata.properties, key);
			markPrunable(metadata, key);
		}
		for (const index of metadata.existenceIndices) if (index >= currentLength && index < oldLength) {
			const key = String(index);
			notify(metadata.existence, key);
			markPrunable(metadata, key);
		}
	};
	/**
	* Whether `wrap()` would hand back something other than `value` itself — a
	* deep proxy for a plain object/array, or a readonly view for a Map/Set. The
	* `get` trap uses this to reject a non-configurable, non-writable property
	* whose value cannot be substituted, before `wrap()` performs the swap.
	*/
	const isWrappedByValue = (value) => isPlainObjectOrArray(value) || value instanceof Map || value instanceof Set;
	const wrap = (value) => {
		const rawValue = toRaw(value) ?? value;
		if (rawValue instanceof Map) return readonlyMapView(rawValue);
		if (rawValue instanceof Set) return readonlySetView(rawValue);
		if (!isPlainObjectOrArray(rawValue)) return rawValue;
		assertExtensible(rawValue);
		const cached = rawToMetadata.get(rawValue);
		if (cached !== void 0) return cached.proxy;
		assertDataProperties(rawValue);
		const metadata = {
			properties: /* @__PURE__ */ new Map(),
			existence: /* @__PURE__ */ new Map(),
			propertyIndices: /* @__PURE__ */ new Set(),
			existenceIndices: /* @__PURE__ */ new Set(),
			arrayMethods: /* @__PURE__ */ new Map(),
			proxy: void 0
		};
		const proxy = new Proxy(rawValue, {
			get(target, key, receiver) {
				if (key === SIGNAL_BRAND && !Object.prototype.hasOwnProperty.call(target, key)) return;
				track(target, metadata.properties, metadata.propertyIndices, key);
				const result = Reflect.get(target, key, receiver);
				if (Array.isArray(target) && ARRAY_MUTATORS.has(key) && typeof result === "function") {
					const cachedMethod = metadata.arrayMethods.get(key);
					if (cachedMethod?.method === result) return cachedMethod.wrapper;
					const method = result;
					const wrapper = function(...args) {
						try {
							return adapter.batch(() => Reflect.apply(method, this, args));
						} finally {
							sweepPrunedKeys(metadata, target);
						}
					};
					metadata.arrayMethods.set(key, {
						method,
						wrapper
					});
					return wrapper;
				}
				if (isWrappedByValue(result)) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
					if (descriptor !== void 0 && "value" in descriptor && descriptor.configurable === false && descriptor.writable === false) throw new TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
				}
				return wrap(result);
			},
			set(target, key, nextValue) {
				if (key === "__proto__") throw new TypeError("deepSignal() does not support prototype mutation");
				if (key === SIGNAL_BRAND) throw new TypeError("deepSignal() does not support branding state as a signal");
				const oldValue = Reflect.get(target, key, target);
				const existed = Reflect.has(target, key);
				const owned = Object.prototype.hasOwnProperty.call(target, key);
				const oldLength = Array.isArray(target) ? target.length : void 0;
				const rawNextValue = unwrap(nextValue);
				if (!Reflect.set(target, key, rawNextValue, target)) return false;
				const currentValue = Reflect.get(target, key, target);
				const existsNow = Reflect.has(target, key);
				const ownedNow = Object.prototype.hasOwnProperty.call(target, key);
				adapter.batch(() => {
					if (!Object.is(oldValue, currentValue) || owned !== ownedNow) notify(metadata.properties, key);
					if (existed !== existsNow) notify(metadata.existence, key);
					if (owned !== ownedNow) notifyIteration(metadata);
					if (Array.isArray(target) && oldLength !== void 0) {
						const currentLength = target.length;
						if (key !== "length" && oldLength !== currentLength) notify(metadata.properties, "length");
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
				adapter.batch(() => {
					notify(metadata.properties, key);
					if (existed !== Reflect.has(target, key)) notify(metadata.existence, key);
					notifyIteration(metadata);
					markPrunable(metadata, key);
				});
				sweepPrunedKeys(metadata, target);
				return true;
			},
			getOwnPropertyDescriptor(target, key) {
				track(target, metadata.properties, metadata.propertyIndices, key);
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
				if (descriptor === void 0 || !("value" in descriptor)) return descriptor;
				if (descriptor.configurable === false && descriptor.writable === false) return descriptor;
				descriptor.value = wrap(descriptor.value);
				return descriptor;
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
			}
		});
		metadata.proxy = proxy;
		rawToMetadata.set(rawValue, metadata);
		proxyToRaw.set(proxy, rawValue);
		return proxy;
	};
	class DeepSignalImpl {
		#source;
		constructor(source) {
			this.#source = source;
			const protocol = getReadableInterop(this.#source);
			if (protocol !== void 0) attachReadableInterop(this, protocol);
		}
		get value() {
			return wrap(this.#source.value);
		}
		set value(nextValue) {
			const rawValue = unwrap(nextValue);
			assertRootValue(rawValue);
			this.#source.value = rawValue;
		}
		peek() {
			return this.#source.peek();
		}
	}
	/**
	* Reports the per-key reactive metadata currently retained for a deep proxy
	* (or for the raw object behind it). Exposed for this package's own tests
	* only — it is deliberately absent from every published entry point, and the
	* shape it returns is internal detail, not API.
	*/
	function inspectDeepSignalMetadata(value) {
		const metadata = rawToMetadata.get(toRaw(value) ?? value);
		if (metadata === void 0) return void 0;
		return {
			properties: [...metadata.properties.keys()],
			existence: [...metadata.existence.keys()],
			propertyIndices: [...metadata.propertyIndices],
			existenceIndices: [...metadata.existenceIndices]
		};
	}
	/**
	* Creates a signal that lazily tracks nested plain-object and array properties.
	* Mutations must go through `.value`; changes made through the original raw
	* object are intentionally not observable.
	*/
	function deepSignal(initialValue) {
		const rawInitialValue = prepareDeepValue(initialValue);
		assertRootValue(rawInitialValue);
		wrap(rawInitialValue);
		const root = adapter.createSignal(rawInitialValue);
		const result = new DeepSignalImpl(root);
		adapter.registerDeepSignal?.(result);
		return result;
	}
	return {
		deepSignal,
		inspectDeepSignalMetadata
	};
}
//#endregion
//#region src/core/deep-signal.ts
let productionDeepSignals;
function getProductionDeepSignals() {
	return productionDeepSignals ??= createDeepSignalFactory({
		createSignal(initial) {
			return coreRuntime.createDeepSignal(initial);
		},
		markWatched(source) {
			coreRuntime.markDeepSignalWatched(source);
		},
		hasSubscribers(source) {
			return coreRuntime.hasDeepSignalSubscribers(source);
		},
		batch,
		isSignal,
		hasActiveSubscriber: () => {
			const owner = executionContext.owner;
			return coreRuntime.hasActiveSubscriber() || owner !== void 0 && typeof owner !== "symbol" && (owner.kind === "graph" || owner.kind === "render");
		},
		getBatchDepth: () => coreRuntime.getBatchDepth(),
		isSpeculative: () => coreRuntime.isSpeculative(),
		markSpeculativeDeepRead: () => coreRuntime.markSpeculativeDeepRead(),
		registerDeepSignal(value) {
			registerSignal(value);
		}
	});
}
/**
* Creates a signal that lazily tracks nested plain-object and array properties.
* Mutations must go through `.value`; changes made through the original raw
* object are intentionally not observable.
*/
function deepSignal(initialValue) {
	return getProductionDeepSignals().deepSignal(initialValue);
}
//#endregion
//#region src/core/readable-subscription.ts
/** Subscribe through the private V1 boundary without creating an EffectNode. */
function subscribeReadableV1(readable, listener) {
	const protocol = getReadableInterop(readable);
	if (protocol === void 0) return void 0;
	const subscription = protocol.subscribe(() => notifyListener(listener));
	return () => subscription.unsubscribe();
}
//#endregion
//#region src/react/hooks.ts
const EMPTY_DEPENDENCIES = [];
function assertSignalSnapshot(value) {
	if (typeof value === "object" && value !== null || typeof value === "function") throw new TypeError("useDeepSignalValue selector must return a primitive snapshot; objects, Proxies, and functions are not supported");
}
/**
* Shared `useSyncExternalStore` wiring for effect-backed subscriptions only:
* the dynamic deep-selector store and structural-readable compatibility
* fallback. Package readables with ReadableInterop V1 use a direct watcher.
* On `subscribe`, starts an `effect()` that reruns `onEvaluate` on relevant
* writes and notifies React when it reports a change.
*
* `getSnapshot` is intentionally not this helper's concern — the caller
* wires its own, whether that means recomputing fresh each call
* (`useSignalValue`) or returning a cached result (the deep-selector store).
*
* An exception thrown by `onEvaluate` is swallowed here and treated as a
* change worth notifying about. That leaves the next render-time snapshot
* read to surface the error to an Error Boundary rather than letting the
* background effect's exception escape through the signal writer.
*/
function createEffectBackedStoreSubscription(onEvaluate) {
	return (notify) => {
		let isInitialRun = true;
		return effect(() => {
			let changed;
			try {
				changed = onEvaluate();
			} catch {
				changed = true;
			}
			if (isInitialRun) {
				isInitialRun = false;
				return;
			}
			if (changed) notify();
		});
	};
}
/**
* Holds a selector result outside the reactive graph. A selector error must
* not escape from the signal write that caused a reactive re-evaluation:
* React needs to observe it during its next render so an Error Boundary can
* handle it. The cached result also avoids rerunning the selector on every
* render.
*/
function createDeepSelectorStore(source, selector) {
	const evaluate = () => {
		try {
			const value = untrackedRender(() => selector(source.value));
			assertSignalSnapshot(value);
			return {
				kind: "value",
				value
			};
		} catch (error) {
			return {
				kind: "error",
				error
			};
		}
	};
	let result = evaluate();
	const hasChanged = (next) => {
		if (result.kind !== next.kind) return true;
		return result.kind === "value" && next.kind === "value" ? !Object.is(result.value, next.value) : result.kind === "error" && next.kind === "error" ? !Object.is(result.error, next.error) : false;
	};
	return {
		subscribe: createEffectBackedStoreSubscription(() => {
			const next = evaluate();
			if (!hasChanged(next)) return false;
			result = next;
			return true;
		}),
		getSnapshot() {
			if (result.kind === "error") throw result.error;
			return result.value;
		}
	};
}
/** Creates a signal whose identity is stable for the lifetime of this component. */
function useSignal(initialValue) {
	const signalRef = useRef(void 0);
	if (signalRef.current === void 0) signalRef.current = signal(initialValue);
	return signalRef.current;
}
/**
* Creates a deep signal whose identity is stable for the component lifetime.
* A factory is evaluated only while initializing a mounted component instance;
* it must remain pure because React Strict Mode may replay initial rendering.
*/
function useDeepSignal(initialValue) {
	const signalRef = useRef(void 0);
	if (signalRef.current === void 0) signalRef.current = deepSignal(typeof initialValue === "function" ? initialValue() : initialValue);
	return signalRef.current;
}
/**
* Selects a property-level primitive snapshot from a deep signal.
*
* Every non-signal value captured by `selector` must be listed in
* `dependencies`. Object and proxy results are intentionally rejected because
* mutable snapshots cannot satisfy `useSyncExternalStore` identity semantics.
*
* `dependencies` must keep a fixed length across this component's lifetime,
* matching `useMemo`'s own rule (its length feeds a `useMemo` deps array
* below via `[source, ...dependencies]`). A length change is caught and
* thrown as a clear error rather than left to degrade into React's silent
* "changed size between renders" dev warning, mirroring `useComputed`'s
* dependency-mode-switch guard.
*/
function useDeepSignalValue(source, selector, dependencies) {
	const initialDependencyLengthRef = useRef(void 0);
	initialDependencyLengthRef.current ??= dependencies.length;
	if (dependencies.length !== initialDependencyLengthRef.current) {
		const error = /* @__PURE__ */ new Error(`useDeepSignalValue: the \`dependencies\` array length changed between renders (from ${initialDependencyLengthRef.current} to ${dependencies.length}) for this call site. Keep \`dependencies\` a fixed length across the component's lifetime, matching useMemo's rules.`);
		error.name = "UseDeepSignalValueDependencyLengthChangeError";
		throw error;
	}
	const store = useMemo(() => createDeepSelectorStore(source, selector), [source, ...dependencies]);
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
/**
* Creates a computed signal with a stable identity.
*
* When `dependencies` is omitted, the getter must only read signals. Its initial
* closure is retained for the component lifetime, so props, state, and other
* non-signal values must not be captured in that mode.
*
* When the getter captures props, state, or any other non-signal value, list all
* of those values in `dependencies`. React memoization then creates a separate
* computed when they change, rather than replacing the getter of an existing
* computed during render. An abandoned render therefore cannot change the
* closure used by the previously committed computed. Choose one mode for a
* component's lifetime.
*/
function useComputed(getValue, dependencies) {
	const dependencyComputed = useMemo(() => dependencies === void 0 ? void 0 : computed(getValue), dependencies ?? EMPTY_DEPENDENCIES);
	const initialModeRef = useRef(void 0);
	const signalOnlyComputedRef = useRef(void 0);
	const mode = dependencies === void 0 ? "without a dependency array" : "with a dependency array";
	initialModeRef.current ??= mode;
	if (initialModeRef.current !== mode) {
		const error = /* @__PURE__ */ new Error(`useComputed: the dependency-array mode changed between renders (from ${initialModeRef.current} to ${mode}) for this call site. Keep passing deps consistently, matching useMemo's rules.`);
		error.name = "UseComputedModeChangeError";
		throw error;
	}
	if (dependencyComputed !== void 0) return dependencyComputed;
	if (signalOnlyComputedRef.current === void 0) signalOnlyComputedRef.current = computed(getValue);
	return signalOnlyComputedRef.current;
}
/**
* Runs a reactive effect after this component has committed, disposing it when
* the component unmounts (and during React Strict Mode's development replay).
*
* When `dependencies` is omitted, the callback must only capture signals. Its
* initial closure is retained for the component lifetime, so unrelated React
* renders do not restart the effect.
*
* When the callback captures props, state, or any other non-signal value, list
* all of those values in `dependencies`. The effect is then reconnected after
* those dependencies change. Choose one mode for a component's lifetime.
*/
function useSignalEffect(callback, dependencies) {
	useEffect(() => effect(callback), dependencies ?? EMPTY_DEPENDENCIES);
}
/**
* Reads a signal and subscribes the component to subsequent changes through
* ReadableInterop V1 when available.
*
* `useSyncExternalStore` owns the initial consistency check after subscribing.
* For V1 readables, its watcher tracks revisions without an EffectNode. A
* read that throws (a computed whose cached error `.value` rethrows) remains
* for the render-time `getSnapshot` to surface to an Error Boundary; only the
* structural-readable fallback needs an effect to contain background errors.
*/
function useSignalValue(source) {
	const subscribe = useCallback((notify) => {
		const unsubscribe = subscribeReadableV1(source, notify);
		if (unsubscribe !== void 0) return unsubscribe;
		return createEffectBackedStoreSubscription(() => {
			source.value;
			return true;
		})(notify);
	}, [source]);
	const getSnapshot = useCallback(() => untracked(() => source.value), [source]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
//#endregion
export { useSignalEffect as a, deepSignal as c, useSignal as i, useDeepSignal as n, useSignalValue as o, useDeepSignalValue as r, subscribeReadableV1 as s, useComputed as t };

//# sourceMappingURL=hooks-BO5dRw7P.js.map