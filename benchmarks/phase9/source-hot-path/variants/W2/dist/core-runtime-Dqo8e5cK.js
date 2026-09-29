import { createReactiveSystem } from "alien-signals/system";
//#region src/core/execution-owner.ts
const UNTRACKED_OWNER = Symbol.for("react-fine-grained-signals.untracked-owner.v2");
function isGraphExecutionOwner(owner) {
	return typeof owner === "object" && owner !== null && owner.kind === "graph";
}
function isRenderExecutionOwner(owner) {
	return typeof owner === "object" && owner !== null && owner.kind === "render";
}
const CONTEXT_KEY = Symbol.for("react-fine-grained-signals.shared-execution-owner.v2");
const globalObject = globalThis;
const existing = globalObject[CONTEXT_KEY];
if (existing !== void 0 && existing.version !== 2) throw new Error("Incompatible RFSG shared execution owner");
const executionContext = existing ?? {
	version: 2,
	owner: void 0,
	frames: []
};
executionContext.frames ??= [];
if (existing === void 0) Object.defineProperty(globalObject, CONTEXT_KEY, {
	value: executionContext,
	enumerable: false,
	configurable: false,
	writable: false
});
/** Temporarily changes lexical ownership inside one synchronous call. */
function withSynchronousExecutionOwner(owner, callback) {
	const previous = executionContext.owner;
	executionContext.owner = owner;
	try {
		return callback();
	} finally {
		executionContext.owner = previous;
	}
}
function pushExecutionOwner(owner) {
	const frame = {
		owner,
		active: true
	};
	executionContext.frames.push(frame);
	executionContext.owner = owner;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		frame.active = false;
		while (executionContext.frames.at(-1)?.active === false) executionContext.frames.pop();
		executionContext.owner = executionContext.frames.at(-1)?.owner;
	};
}
//#endregion
//#region src/core/interop-context.mts
const READABLE_INTEROP_V1$1 = Symbol.for("react-fine-grained-signals.readable-interop.v1");
//#endregion
//#region src/core/foreign-readable-v1.mts
function isReadableProtocol(value) {
	return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1 && typeof Reflect.get(value, "getRevision") === "function" && typeof Reflect.get(value, "subscribe") === "function";
}
function observeRevision(node) {
	return node.renderRevision ??= 0;
}
function createForeignReadableAdapter({ runtimeToken, makeNode, mutableFlag, dirtyFlag, getActiveSubscriber, link, propagate, flush, isRunning, isBatching, effect }) {
	const readableNodes = /* @__PURE__ */ new WeakMap();
	const foreignNodes = /* @__PURE__ */ new WeakMap();
	const localReadable = Symbol("localReadable");
	function getLocalReadableRevision() {
		const readable = this[localReadable];
		const node = readableNodes.get(readable);
		try {
			withSynchronousExecutionOwner(UNTRACKED_OWNER, () => readable.value);
		} catch {}
		return observeRevision(node);
	}
	function subscribeLocalReadable(listener) {
		const readable = this[localReadable];
		const node = readableNodes.get(readable);
		const revision = observeRevision(node);
		let initial = true;
		return {
			unsubscribe: effect(() => {
				try {
					readable.value;
				} catch {}
				if (initial) initial = false;
				else listener(observeRevision(node));
			}),
			revision
		};
	}
	function ensureForeignNode(protocol, observedRevision) {
		let node = foreignNodes.get(protocol);
		if (node === void 0) {
			node = makeNode("external", mutableFlag, {
				protocol,
				revision: observedRevision,
				pendingRevision: observedRevision,
				unsubscribe: void 0
			});
			foreignNodes.set(protocol, node);
		}
		node.pendingRevision = observedRevision;
		const subscriber = getActiveSubscriber();
		if (subscriber?.kind === "computed") subscriber.foreignDependent = true;
		if (subscriber !== void 0) link(node, subscriber);
		if (subscriber?.kind === "effect") activateForeignNode(node);
		return node;
	}
	function activateForeignNode(node) {
		if (node.unsubscribe === void 0) {
			const subscription = node.protocol.subscribe((revision) => {
				if (revision === node.revision || revision === node.pendingRevision) return;
				node.pendingRevision = revision;
				node.flags = mutableFlag | dirtyFlag;
				if (node.subs !== void 0) {
					propagate(node.subs, isRunning());
					if (!isBatching()) flush();
				}
			});
			node.unsubscribe = subscription.unsubscribe;
			if (subscription.revision !== node.revision) {
				node.pendingRevision = subscription.revision;
				node.flags = mutableFlag | dirtyFlag;
				if (node.subs !== void 0) {
					propagate(node.subs, isRunning());
					if (!isBatching()) flush();
				}
			}
		}
	}
	const graphOwner = {
		version: 2,
		kind: "graph",
		runtimeToken,
		add(protocol, revision) {
			ensureForeignNode(protocol, revision);
		}
	};
	function withGraphOwner(callback) {
		const owner = executionContext.owner;
		if (isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken) return callback();
		return withSynchronousExecutionOwner(graphOwner, callback);
	}
	function publishForeignReadable(readable, node, owner) {
		if (owner === UNTRACKED_OWNER || (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken === runtimeToken) return;
		const protocol = node.readableProtocol;
		if (protocol !== void 0) {
			if (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) owner.add(protocol, observeRevision(node));
		}
	}
	function attachProtocol(readable, node) {
		readableNodes.set(readable, node);
		const protocol = {
			version: 1,
			runtimeToken,
			[localReadable]: readable,
			getRevision: getLocalReadableRevision,
			subscribe: subscribeLocalReadable
		};
		node.readableProtocol = protocol;
		Object.defineProperty(readable, READABLE_INTEROP_V1$1, {
			value: protocol,
			enumerable: false,
			writable: false,
			configurable: false
		});
	}
	function getReadableRevision(readable) {
		const node = readableNodes.get(readable);
		if (node !== void 0) return observeRevision(node);
		const protocolValue = Reflect.get(readable, READABLE_INTEROP_V1$1);
		if (isReadableProtocol(protocolValue)) return protocolValue.getRevision();
		throw new TypeError("Unknown candidate readable");
	}
	return {
		attachProtocol,
		ensureForeignNode,
		activateForeignNode,
		getNodeForReadable: (value) => readableNodes.get(value),
		getReadableRevision,
		observeRevision,
		publishForeignReadable,
		graphOwner,
		withGraphOwner
	};
}
//#endregion
//#region src/core/interop.ts
const READABLE_INTEROP_V1 = Symbol.for("react-fine-grained-signals.readable-interop.v1");
const SHARED_CONTEXT_V1 = Symbol.for("react-fine-grained-signals.shared-interop-context.v1");
let cachedContext;
/** Resolve the tiny same-global context shared by duplicate module copies. */
function getSharedInteropContext() {
	if (cachedContext !== void 0) return cachedContext;
	const globalObject = globalThis;
	const existing = globalObject[SHARED_CONTEXT_V1];
	if (existing !== void 0) {
		if (existing.version !== 1 || typeof existing.speculativeDepth !== "number") throw new Error("Incompatible react-fine-grained-signals interop context");
		cachedContext = existing;
		return existing;
	}
	const context = {
		version: 1,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	};
	Object.defineProperty(globalObject, SHARED_CONTEXT_V1, {
		value: context,
		enumerable: false,
		configurable: false,
		writable: false
	});
	cachedContext = context;
	return context;
}
function getReadableInterop(readable) {
	const protocol = readable[READABLE_INTEROP_V1];
	if (protocol === void 0 || typeof protocol !== "object" || protocol === null) return;
	const candidate = protocol;
	return candidate.version === 1 && typeof candidate.getRevision === "function" && typeof candidate.subscribe === "function" && typeof candidate.runtimeToken === "object" && candidate.runtimeToken !== null ? candidate : void 0;
}
function attachReadableInterop(readable, protocol) {
	Object.defineProperty(readable, READABLE_INTEROP_V1, {
		value: protocol,
		enumerable: false,
		configurable: false,
		writable: false
	});
}
function withInteropRenderCollector(collector, callback) {
	const context = getSharedInteropContext();
	const previous = context.renderCollector;
	context.renderCollector = collector;
	try {
		return callback();
	} finally {
		context.renderCollector = previous;
	}
}
function withoutInteropRenderCollector(callback) {
	return withInteropRenderCollector(void 0, callback);
}
function isInteropSpeculative() {
	return getSharedInteropContext().speculativeDepth > 0;
}
/** Marks speculative deep reads whose per-key dependencies were not collected. */
function markInteropSpeculativeDeepRead() {
	const context = getSharedInteropContext();
	context.speculativeDeepReadEpoch = (context.speculativeDeepReadEpoch ?? 0) + 1;
}
//#endregion
//#region src/core/render-tracking.ts
let activeRenderCollector;
/** Returns whether a React render is currently collecting signal reads. */
function hasActiveRenderCollector() {
	return activeRenderCollector !== void 0;
}
/** Replaces the current render collector and returns the previous collector. */
function setActiveRenderCollector(collector) {
	const previous = activeRenderCollector;
	activeRenderCollector = collector;
	return previous;
}
/** Records a dependency and reports whether render collection was active. */
function trackRenderDependency(dependency, observedVersion) {
	if (activeRenderCollector === void 0) return false;
	activeRenderCollector.add(dependency, observedVersion ?? dependency.getRenderVersion());
	return true;
}
/** Runs a callback without adding its reads to the active React render. */
function untrackedRender(callback) {
	const previous = setActiveRenderCollector();
	try {
		const owner = executionContext.owner;
		const run = () => withoutInteropRenderCollector(callback);
		if (owner !== void 0 && typeof owner !== "symbol" && owner.kind === "graph") return run();
		return withSynchronousExecutionOwner(UNTRACKED_OWNER, run);
	} finally {
		setActiveRenderCollector(previous);
	}
}
/**
* Invokes one subscription listener, keeping its failure from cancelling the
* listeners queued behind it. Without this, a single throwing subscriber
* aborts the rest of the notify cycle, so unrelated components silently miss
* the update that was being delivered. Reported the same way as the other
* background-callback failures in this codebase (`readBoundSignal` in
* src/runtime/jsx.ts): `console.error(message, { cause })`.
*/
function notifyListener(listener) {
	try {
		listener();
	} catch (error) {
		console.error("react-fine-grained-signals: a render-subscription listener threw; continuing with the remaining listeners.", { cause: error });
	}
}
//#endregion
//#region src/core/alien-derived-runtime-core.mts
const None = 0;
const Mutable = 1;
const Watching = 2;
const RecursedCheck = 4;
const Dirty = 16;
const Pending = 32;
function createAlienDerivedRuntime() {
	const NO_OWNER_ARGUMENT = Symbol("no graph callback argument");
	const runtimeToken = {};
	let renderAdapter;
	let activeRenderAttempt;
	let activeSub;
	let cycle = 0;
	let runDepth = 0;
	let batchDepth = 0;
	let flushIndex = 0;
	let queuedLength = 0;
	const queue = [];
	const { link: alienLink, unlink: alienUnlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem({
		update(rawNode) {
			const node = rawNode;
			if (node.kind === "external") {
				node.pendingRevision = node.protocol.getRevision();
				const changed = node.revision !== node.pendingRevision;
				node.revision = node.pendingRevision;
				node.flags = Mutable;
				return changed;
			}
			if (node.kind === "computed") return updateComputed(node);
			if (node.kind === "source") return updateSource(node);
			node.flags = Mutable;
			return true;
		},
		notify(rawEffect) {
			let current = rawEffect;
			let insertIndex = queuedLength;
			const firstInsertedIndex = insertIndex;
			do {
				const effect = current;
				queue[insertIndex++] = effect;
				effect.flags &= -3;
				current = effect.subs?.sub;
				if (current === void 0 || !(current.flags & Watching)) break;
			} while (true);
			queuedLength = insertIndex;
			let leftIndex = firstInsertedIndex;
			while (leftIndex < --insertIndex) {
				const left = queue[leftIndex];
				queue[leftIndex++] = queue[insertIndex];
				queue[insertIndex] = left;
			}
		},
		unwatched(rawNode) {
			const node = rawNode;
			if (node.kind === "external") {
				node.unsubscribe?.();
				node.unsubscribe = void 0;
			} else if (node.kind === "computed") {
				if (node.depsTail !== void 0) {
					node.flags = 17;
					disposeDeps(node);
				}
			} else if (node.kind === "effect") disposeEffect(node);
		}
	});
	function linkNode(dependency, subscriber, version) {
		alienLink(dependency, subscriber, version);
	}
	function unlinkNode(linkage, subscriber) {
		return alienUnlink(linkage, subscriber);
	}
	function makeNode(kind, flags, fields = {}) {
		return {
			kind,
			flags,
			deps: void 0,
			depsTail: void 0,
			subs: void 0,
			subsTail: void 0,
			renderRevision: 0,
			...fields
		};
	}
	const foreignAdapter = createForeignReadableAdapter({
		runtimeToken,
		makeNode,
		mutableFlag: Mutable,
		dirtyFlag: Dirty,
		getActiveSubscriber: () => activeSub,
		link: (node, subscriber) => linkNode(node, subscriber, cycle),
		propagate,
		flush: () => flush(),
		isRunning: () => !!runDepth,
		isBatching: () => !!batchDepth,
		effect: (callback) => effect(callback)
	});
	const renderDependencies = /* @__PURE__ */ new WeakMap();
	const deepSignalNodes = /* @__PURE__ */ new WeakSet();
	const deepWatchedNodes = /* @__PURE__ */ new WeakSet();
	function getRenderDependency(readable, node) {
		if (!renderDependencies.has(readable)) {
			node.getRenderVersion = () => foreignAdapter.observeRevision(node);
			node.subscribeRender = (listener) => {
				let initial = true;
				let version = foreignAdapter.observeRevision(node);
				return effect(() => {
					try {
						readable.value;
					} catch {}
					const nextVersion = foreignAdapter.observeRevision(node);
					if (initial) initial = false;
					else if (nextVersion !== version) listener();
					version = nextVersion;
				});
			};
			renderDependencies.set(readable, node);
		}
		return renderDependencies.get(readable);
	}
	function readSource(source) {
		if (source.flags & Dirty && updateSource(source)) {
			if (source.subs !== void 0) shallowPropagate(source.subs);
		}
		if (activeSub !== void 0) linkNode(source, activeSub, cycle);
		return source.currentValue;
	}
	const attachProtocol = foreignAdapter.attachProtocol;
	const ensureForeignNode = foreignAdapter.ensureForeignNode;
	const graphOwner = foreignAdapter.graphOwner;
	function withGraphOwner(callback, argument = NO_OWNER_ARGUMENT, thisArg = void 0) {
		const owner = executionContext.owner;
		const previousAttempt = activeRenderAttempt;
		const alreadyOwned = isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken;
		if (previousAttempt === void 0 && alreadyOwned) return argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument);
		activeRenderAttempt = void 0;
		if (!alreadyOwned) executionContext.owner = graphOwner;
		try {
			return argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument);
		} finally {
			if (!alreadyOwned) executionContext.owner = owner;
			activeRenderAttempt = previousAttempt;
		}
	}
	function configureRenderAdapter(adapter) {
		renderAdapter = adapter;
	}
	function withRenderAttempt(attempt, callback) {
		const restore = pushRenderAttempt(attempt);
		try {
			return callback();
		} finally {
			restore();
		}
	}
	function pushRenderAttempt(attempt) {
		const previous = activeRenderAttempt;
		activeRenderAttempt = attempt;
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (activeRenderAttempt === attempt) activeRenderAttempt = previous;
		};
	}
	function getActiveRenderAttempt() {
		return activeRenderAttempt;
	}
	const getNodeForReadable = foreignAdapter.getNodeForReadable;
	const getReadableRevision = foreignAdapter.getReadableRevision;
	function isComputedClean(node) {
		return node.initialized === true && !(node.flags & 48);
	}
	function promoteComputed(readable, node, entry) {
		if (node.initialized) return true;
		const computed = node;
		const hadForeignDependencies = computed.foreignDependent;
		const dependencies = [];
		for (const [dependency, revision] of entry.dependencies) {
			if (getReadableRevision(dependency) !== revision) return false;
			const dependencyNode = foreignAdapter.getNodeForReadable(dependency);
			if (dependencyNode !== void 0) dependencies.push(dependencyNode);
			else {
				const protocolValue = Reflect.get(dependency, Symbol.for("react-fine-grained-signals.readable-interop.v1"));
				const protocol = typeof protocolValue === "object" && protocolValue !== null && Reflect.get(protocolValue, "version") === 1 && typeof Reflect.get(protocolValue, "getRevision") === "function" && typeof Reflect.get(protocolValue, "subscribe") === "function" ? protocolValue : void 0;
				if (protocol === void 0) return false;
				dependencies.push(ensureForeignNode(protocol, revision));
			}
		}
		disposeDeps(computed);
		computed.depsTail = void 0;
		const previousSub = activeSub;
		activeSub = computed;
		cycle += 1;
		try {
			for (const dependency of dependencies) linkNode(dependency, computed, cycle);
		} finally {
			activeSub = previousSub;
		}
		recomputeForeignDependencies(computed);
		if (hadForeignDependencies !== computed.foreignDependent) updateForeignDependencyAncestors(computed);
		computed.value = entry.value;
		computed.error = entry.error;
		computed.hasError = entry.hasError;
		computed.initialized = true;
		computed.flags = Mutable;
		return true;
	}
	function hasSubscribers(readable) {
		return foreignAdapter.getNodeForReadable(readable)?.subs !== void 0;
	}
	function hasActiveSubscriber() {
		return activeSub !== void 0;
	}
	function getBatchDepth() {
		return batchDepth;
	}
	function updateSource(source) {
		source.flags = Mutable;
		return !Object.is(source.currentValue, source.currentValue = source.pendingValue);
	}
	function readComputed(computed) {
		if (computed.foreignDependent && computed.subs === void 0) refreshColdForeignDependencies(computed, /* @__PURE__ */ new Set());
		if (activeSub === computed && computed.flags & RecursedCheck) throw new Error("Computed cycle detected");
		const flags = computed.flags;
		if (flags & Dirty || flags & Pending && (computed.deps !== void 0 && checkDirty(computed.deps, computed) || (computed.flags = flags & -33, false))) {
			if (updateComputed(computed) && computed.subs !== void 0) shallowPropagate(computed.subs);
		} else if (!flags) updateComputed(computed);
		if (activeSub !== void 0) {
			linkNode(computed, activeSub, cycle);
			if (activeSub.kind === "computed" && computed.foreignDependent) activeSub.foreignDependent = true;
			if (activeSub.kind === "effect" && computed.foreignDependent) activateForeignDependencies(computed, /* @__PURE__ */ new Set());
		}
		if (computed.hasError) throw computed.error;
		return computed.value;
	}
	function refreshColdForeignDependencies(node, visited) {
		if (visited.has(node)) return false;
		visited.add(node);
		let changed = false;
		let dependency = node.deps;
		while (dependency !== void 0) {
			const dep = dependency.dep;
			if (dep.kind === "external") {
				const revision = dep.protocol.getRevision();
				if (revision !== dep.revision) {
					dep.pendingRevision = revision;
					dep.flags = 17;
					changed = true;
				}
			} else if (dep.kind === "computed" && dep.foreignDependent) {
				if (refreshColdForeignDependencies(dep, visited)) changed = true;
			}
			dependency = dependency.nextDep;
		}
		if (changed) node.flags |= Dirty;
		return changed;
	}
	function activateForeignDependencies(node, visited) {
		if (visited.has(node)) return;
		visited.add(node);
		let dependency = node.deps;
		while (dependency !== void 0) {
			const dep = dependency.dep;
			if (dep.kind === "external") foreignAdapter.activateForeignNode(dep);
			else if (dep.kind === "computed") activateForeignDependencies(dep, visited);
			dependency = dependency.nextDep;
		}
	}
	function updateComputed(computed) {
		computed.depsTail = void 0;
		computed.flags = 5;
		const previous = activeSub;
		activeSub = computed;
		let changed = !computed.initialized;
		const hadError = computed.hasError;
		const hadForeignDependencies = computed.foreignDependent;
		const previousValue = computed.value;
		computed.foreignDependent = false;
		try {
			cycle += 1;
			try {
				computed.value = withGraphOwner(computed.getter, previousValue, computed);
				computed.error = void 0;
				computed.hasError = false;
			} catch (error) {
				computed.value = void 0;
				computed.error = error;
				computed.hasError = true;
			}
			computed.initialized = true;
			changed = changed || hadError || computed.hasError || !Object.is(previousValue, computed.value);
			if (changed && computed.renderRevision !== void 0) computed.renderRevision = computed.renderRevision + 1 | 0;
			return changed;
		} finally {
			activeSub = previous;
			computed.flags &= -5;
			purgeDeps(computed);
			recomputeForeignDependencies(computed);
			if (hadForeignDependencies !== computed.foreignDependent) updateForeignDependencyAncestors(computed);
		}
	}
	function recomputeForeignDependencies(computed) {
		let dependency = computed.deps;
		let foreignDependent = false;
		while (dependency !== void 0) {
			const dep = dependency.dep;
			if (dep.kind === "external" || dep.kind === "computed" && dep.foreignDependent) {
				foreignDependent = true;
				break;
			}
			dependency = dependency.nextDep;
		}
		computed.foreignDependent = foreignDependent;
	}
	function updateForeignDependencyAncestors(computed) {
		let link = computed.subs;
		while (link !== void 0) {
			const subscriber = link.sub;
			if (subscriber.kind === "computed") {
				const computedSubscriber = subscriber;
				const wasForeignDependent = computedSubscriber.foreignDependent;
				recomputeForeignDependencies(computedSubscriber);
				if (wasForeignDependent !== computedSubscriber.foreignDependent) updateForeignDependencyAncestors(computedSubscriber);
			}
			link = link.nextSub;
		}
	}
	function runEffect(effect) {
		const flags = effect.flags;
		if (flags & Dirty || flags & Pending && effect.deps !== void 0 && checkDirty(effect.deps, effect)) {
			if (effect.cleanup !== void 0) {
				try {
					runCleanup(effect);
				} catch (error) {
					reportFailure(error);
				}
				if (!effect.flags) return;
			}
			effect.depsTail = void 0;
			effect.flags = 6;
			const previous = activeSub;
			activeSub = effect;
			try {
				cycle += 1;
				runDepth += 1;
				const cleanup = withGraphOwner(effect.fn);
				effect.cleanup = typeof cleanup === "function" ? cleanup : void 0;
				if (!effect.flags && effect.cleanup !== void 0) runCleanup(effect);
			} finally {
				runDepth -= 1;
				activeSub = previous;
				effect.flags &= -5;
				purgeDeps(effect);
			}
		} else if (effect.deps !== void 0) effect.flags = Watching;
	}
	function flush() {
		try {
			while (flushIndex < queuedLength) {
				const effect = queue[flushIndex];
				queue[flushIndex++] = void 0;
				try {
					runEffect(effect);
				} catch (error) {
					reportFailure(error);
				}
			}
		} finally {
			while (flushIndex < queuedLength) {
				const effect = queue[flushIndex];
				queue[flushIndex++] = void 0;
				effect.flags |= 10;
			}
			flushIndex = 0;
			queuedLength = 0;
		}
	}
	function reportFailure(error) {
		try {
			console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: error });
		} catch {}
		try {
			const report = globalThis.reportError;
			if (typeof report === "function") report.call(globalThis, error);
		} catch {}
	}
	function disposeDeps(sub) {
		let depLink = sub.depsTail;
		while (depLink !== void 0) {
			const previous = depLink.prevDep;
			unlinkNode(depLink, sub);
			depLink = previous;
		}
	}
	function purgeDeps(sub) {
		const tail = sub.depsTail;
		let depLink = tail === void 0 ? sub.deps : tail.nextDep;
		while (depLink !== void 0) depLink = unlinkNode(depLink, sub);
	}
	function runCleanup(effect) {
		const cleanup = effect.cleanup;
		effect.cleanup = void 0;
		const previous = activeSub;
		activeSub = void 0;
		try {
			return withSynchronousExecutionOwner(UNTRACKED_OWNER, cleanup);
		} finally {
			activeSub = previous;
		}
	}
	function disposeEffect(effect) {
		effect.flags = None;
		disposeDeps(effect);
		if (effect.cleanup !== void 0) try {
			runCleanup(effect);
		} catch (error) {
			reportFailure(error);
		}
	}
	function effect(fn) {
		const node = makeNode("effect", 6, {
			fn,
			cleanup: void 0
		});
		const previous = activeSub;
		try {
			activeSub = node;
			runDepth += 1;
			try {
				const cleanup = withGraphOwner(fn);
				node.cleanup = typeof cleanup === "function" ? cleanup : void 0;
			} catch (error) {
				node.cleanup = void 0;
				reportFailure(error);
			} finally {
				runDepth -= 1;
				activeSub = previous;
				node.flags &= -5;
				purgeDeps(node);
			}
		} catch (error) {
			reportFailure(error);
		}
		if (!runDepth && !batchDepth) {
			if (node.flags & 48) runEffect(node);
			if (queuedLength) flush();
		}
		return () => disposeEffect(node);
	}
	function batch(fn) {
		batchDepth += 1;
		try {
			return fn();
		} finally {
			batchDepth -= 1;
			if (!batchDepth) flush();
		}
	}
	function untracked(fn) {
		const previous = activeSub;
		const previousAttempt = activeRenderAttempt;
		activeSub = void 0;
		activeRenderAttempt = void 0;
		try {
			return withSynchronousExecutionOwner(UNTRACKED_OWNER, fn);
		} finally {
			activeRenderAttempt = previousAttempt;
			activeSub = previous;
		}
	}
	const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
	const BRAND_VERSION = 1;
	const MIN_BRAND_VERSION = 1;
	const brandDescriptor = () => ({
		value: BRAND_VERSION,
		enumerable: false,
		writable: false,
		configurable: false
	});
	function registerHelperBrand(value) {
		Object.defineProperty(value, SIGNAL_BRAND, brandDescriptor());
	}
	function inlineWrite(node, value) {
		if (deepSignalNodes.has(node)) deepWatchedNodes.delete(node);
		if (!Object.is(node.pendingValue, node.pendingValue = value)) {
			node.flags = 17;
			const subscribers = node.subs;
			if (subscribers !== void 0) {
				propagate(subscribers, !!runDepth);
				if (!batchDepth) flush();
			}
		}
	}
	class HelperBrandSignal {
		#node;
		constructor(node, branded = true) {
			this.#node = node;
			if (branded) registerHelperBrand(this);
			attachProtocol(this, node);
		}
		get value() {
			const node = this.#node;
			const currentOwner = executionContext.owner;
			if (currentOwner === void 0) {
				const value = readSource(node);
				if (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));
				return value;
			}
			const attempt = activeRenderAttempt;
			if (attempt !== void 0 && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== void 0) {
				foreignAdapter.observeRevision(node);
				return renderAdapter.readSource(this, node, attempt);
			}
			const value = readSource(node);
			if ((isGraphExecutionOwner(currentOwner) || isRenderExecutionOwner(currentOwner)) && currentOwner.runtimeToken !== runtimeToken) foreignAdapter.publishForeignReadable(this, node, currentOwner);
			return value;
		}
		set value(value) {
			inlineWrite(this.#node, value);
		}
		peek() {
			return this.#node.pendingValue;
		}
	}
	function createBrandedSignal(makeReadable, initialValue) {
		return new makeReadable(makeNode("source", Mutable, {
			currentValue: initialValue,
			pendingValue: initialValue
		}));
	}
	const signalClassBrandHelper = (initialValue) => createBrandedSignal(HelperBrandSignal, initialValue);
	class HelperBrandComputed {
		#node;
		constructor(node, branded = true) {
			this.#node = node;
			if (branded) registerHelperBrand(this);
			attachProtocol(this, node);
		}
		get value() {
			const node = this.#node;
			const attempt = activeRenderAttempt;
			const currentOwner = executionContext.owner;
			if (attempt !== void 0 && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== void 0) {
				foreignAdapter.observeRevision(node);
				return renderAdapter.readComputed(this, node, attempt);
			}
			const owner = currentOwner;
			try {
				return readComputed(node);
			} finally {
				if (owner === void 0) {
					if (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));
				} else if ((isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken !== runtimeToken) foreignAdapter.publishForeignReadable(this, node, owner);
			}
		}
		peek() {
			return untracked(() => readComputed(this.#node));
		}
	}
	function createBrandedComputed(makeReadable, getter) {
		return new makeReadable(makeNode("computed", None, {
			getter,
			value: void 0,
			error: void 0,
			hasError: false,
			initialized: false
		}));
	}
	const computedClassBrandHelper = (getter) => createBrandedComputed(HelperBrandComputed, getter);
	function hasBrandAndPeek(value) {
		if (typeof value !== "object" || value === null) return false;
		const version = Reflect.get(value, SIGNAL_BRAND);
		return typeof version === "number" && version >= MIN_BRAND_VERSION && typeof Reflect.get(value, "peek") === "function";
	}
	const isSignalBrandHelper = hasBrandAndPeek;
	function createDeepSignal(initialValue) {
		const node = makeNode("source", Mutable, {
			currentValue: initialValue,
			pendingValue: initialValue
		});
		const readable = new HelperBrandSignal(node, false);
		deepSignalNodes.add(node);
		return readable;
	}
	function markDeepSignalWatched(readable) {
		const node = foreignAdapter.getNodeForReadable(readable);
		if (node !== void 0) deepWatchedNodes.add(node);
	}
	function hasDeepSignalSubscribers(readable) {
		const node = foreignAdapter.getNodeForReadable(readable);
		return node !== void 0 && (deepWatchedNodes.has(node) || deepSignalNodes.has(node) && hasSubscribers(readable));
	}
	function getRenderVersion(readable) {
		return foreignAdapter.getReadableRevision(readable);
	}
	function subscribeReadables(readables, notify) {
		let initial = true;
		return effect(() => {
			for (const readable of readables) try {
				readable.value;
			} catch {}
			if (initial) initial = false;
			else notify();
		});
	}
	return {
		runtimeToken,
		graphOwner,
		configureRenderAdapter,
		withRenderAttempt,
		pushRenderAttempt,
		getActiveRenderAttempt,
		getNodeForReadable,
		getReadableRevision,
		isComputedClean,
		promoteComputed,
		hasSubscribers,
		hasActiveSubscriber,
		getBatchDepth,
		signal: signalClassBrandHelper,
		computed: computedClassBrandHelper,
		effect,
		batch,
		untracked,
		SIGNAL_BRAND,
		isSignal: isSignalBrandHelper,
		createDeepSignal,
		markDeepSignalWatched,
		hasDeepSignalSubscribers,
		getRenderVersion,
		subscribeReadables
	};
}
//#endregion
//#region src/core/render-runtime.mts
function createAlienDerivedRenderAdapter(core) {
	let activeSpeculativeComputed;
	const readablesByNode = /* @__PURE__ */ new WeakMap();
	const collectorFrames = [];
	let baseRenderCollector;
	function addDependency(attempt, dependency, revision) {
		const node = core.getNodeForReadable(dependency);
		if (node !== void 0) readablesByNode.set(node, dependency);
		if (activeSpeculativeComputed !== void 0) activeSpeculativeComputed.dependencies.set(dependency, revision);
		else attempt.add(dependency, revision);
	}
	function readSource(readable, node, attempt) {
		addDependency(attempt, readable, node.renderRevision);
		return node.pendingValue;
	}
	function readComputed(readable, node, attempt) {
		if (activeSpeculativeComputed !== void 0) {
			const restoreAttempt = core.pushRenderAttempt(void 0);
			try {
				return readable.value;
			} finally {
				addDependency(attempt, readable, node.renderRevision);
				restoreAttempt();
			}
		}
		addDependency(attempt, readable, node.renderRevision);
		const cache = attempt.computedCache;
		let entry = cache.get(node);
		if (entry !== void 0) {
			if (entry.hasError) throw entry.error;
			return entry.value;
		}
		if (core.isComputedClean(node)) {
			if (node.hasError) throw node.error;
			return node.value;
		}
		entry = {
			dependencies: /* @__PURE__ */ new Map(),
			value: void 0,
			error: void 0,
			hasError: false,
			canPromote: false
		};
		cache.set(node, entry);
		const previous = activeSpeculativeComputed;
		activeSpeculativeComputed = entry;
		const deepReadEpoch = attempt.speculativeDeepReadEpoch;
		try {
			entry.value = node.getter(node.value);
		} catch (error) {
			entry.error = error;
			entry.hasError = true;
		} finally {
			activeSpeculativeComputed = previous;
			entry.canPromote = deepReadEpoch === attempt.speculativeDeepReadEpoch;
		}
		if (entry.hasError) throw entry.error;
		return entry.value;
	}
	core.configureRenderAdapter({
		readSource,
		readComputed
	});
	function createRenderAttempt() {
		return {
			dependencies: /* @__PURE__ */ new Map(),
			computedCache: /* @__PURE__ */ new Map(),
			speculativeDeepReadEpoch: 0,
			add(dependency, revision) {
				if (!this.dependencies.has(dependency)) this.dependencies.set(dependency, revision);
			},
			markSpeculativeDeepRead() {
				this.speculativeDeepReadEpoch += 1;
			}
		};
	}
	function createRenderOwner(attempt, scopePolicy = "managed") {
		return {
			version: 2,
			kind: "render",
			scopePolicy,
			runtimeToken: core.runtimeToken,
			add(protocol, revision) {
				addDependency(attempt, protocol, revision);
			},
			isSpeculative() {
				return activeSpeculativeComputed !== void 0;
			},
			markSpeculativeDeepRead() {
				attempt.markSpeculativeDeepRead();
			}
		};
	}
	function pushRenderScope(attempt, scopePolicy = "managed") {
		const parent = executionContext.owner;
		if (isRenderExecutionOwner(parent) && !(parent.scopePolicy === "managed" && scopePolicy === "managed")) parent.closeScope?.();
		const restoreAttempt = core.pushRenderAttempt(attempt);
		const owner = createRenderOwner(attempt, scopePolicy);
		const restoreOwner = pushExecutionOwner(owner);
		const collector = { add(dependency, revision) {
			addDependency(attempt, dependency, revision);
		} };
		if (collectorFrames.length === 0) baseRenderCollector = activeRenderCollector;
		const frame = {
			collector,
			active: true
		};
		collectorFrames.push(frame);
		setActiveRenderCollector(collector);
		let active = true;
		const restoreScope = () => {
			if (!active) return;
			active = false;
			frame.active = false;
			while (collectorFrames.at(-1)?.active === false) collectorFrames.pop();
			setActiveRenderCollector(collectorFrames.at(-1)?.collector ?? baseRenderCollector);
			if (collectorFrames.length === 0) baseRenderCollector = void 0;
			restoreAttempt();
			restoreOwner();
		};
		owner.closeScope = restoreScope;
		return restoreScope;
	}
	function withRenderScope(attempt, callback, scopePolicy = "managed") {
		const restore = pushRenderScope(attempt, scopePolicy);
		try {
			return callback();
		} finally {
			restore();
		}
	}
	function promoteRenderAttempt(attempt) {
		for (const [node, entry] of attempt.computedCache) {
			if (!entry.canPromote) continue;
			const readable = readablesByNode.get(node);
			if (readable === void 0 || !core.promoteComputed(readable, node, entry)) return false;
		}
		return true;
	}
	function settleRenderAttempt(attempt) {
		let stable = true;
		for (const [dependency, revision] of attempt.dependencies) {
			const currentRevision = getRenderVersion(dependency);
			if (currentRevision === revision) continue;
			const node = core.getNodeForReadable(dependency);
			const entry = node === void 0 ? void 0 : attempt.computedCache.get(node);
			if (node === void 0 || entry === void 0 || node.initialized !== true || entry.hasError !== node.hasError || !entry.hasError && !Object.is(entry.value, node.value)) {
				stable = false;
				continue;
			}
			attempt.dependencies.set(dependency, currentRevision);
		}
		return stable;
	}
	function getRenderVersion(readable) {
		if (Reflect.get(readable, "version") === 1 && typeof Reflect.get(readable, "getRevision") === "function" && typeof Reflect.get(readable, "subscribe") === "function") return Reflect.get(readable, "getRevision").call(readable);
		if (core.getNodeForReadable(readable) !== void 0 || Reflect.get(readable, Symbol.for("react-fine-grained-signals.readable-interop.v1")) !== void 0) return core.getReadableRevision(readable);
		const getVersion = Reflect.get(readable, "getRenderVersion");
		if (typeof getVersion === "function") return getVersion.call(readable);
		throw new TypeError("Unknown render dependency");
	}
	function hasActiveRenderOwner() {
		return isRenderExecutionOwner(executionContext.owner);
	}
	function isSpeculative() {
		const owner = executionContext.owner;
		if (isGraphExecutionOwner(owner) || owner === UNTRACKED_OWNER) return false;
		return isRenderExecutionOwner(owner) && (owner.isSpeculative?.() === true || activeSpeculativeComputed !== void 0);
	}
	function markSpeculativeDeepRead() {
		const attempt = core.getActiveRenderAttempt();
		if (attempt !== void 0) attempt.markSpeculativeDeepRead();
		else if (isRenderExecutionOwner(executionContext.owner)) executionContext.owner.markSpeculativeDeepRead?.();
	}
	function subscribeReadables(readables, notify) {
		let initial = true;
		return core.effect(() => {
			for (const readable of readables) try {
				readable.value;
			} catch {}
			if (initial) initial = false;
			else notify();
		});
	}
	function captureRenderSnapshot(readable) {
		const attempt = createRenderAttempt();
		let value;
		withRenderScope(attempt, () => {
			value = readable.value;
		});
		return {
			value,
			dependencies: attempt.dependencies,
			attempt
		};
	}
	function getExecutionOwner() {
		return executionContext.owner;
	}
	return {
		createRenderAttempt,
		createRenderOwner,
		pushRenderScope,
		withRenderScope,
		promoteRenderAttempt,
		settleRenderAttempt,
		getRenderVersion,
		hasActiveRenderOwner,
		isSpeculative,
		markSpeculativeDeepRead,
		subscribeReadables,
		captureRenderSnapshot,
		getExecutionOwner
	};
}
//#endregion
//#region src/core/reactive-runtime.ts
/** Builds one Alien-derived graph and its separate owner/render adapters. */
function createReactiveRuntime() {
	const graph = createAlienDerivedRuntime();
	const render = createAlienDerivedRenderAdapter(graph);
	return {
		runtimeToken: graph.runtimeToken,
		graphOwner: graph.graphOwner,
		getNodeForReadable: graph.getNodeForReadable,
		renderAdapter: render,
		signal: graph.signal,
		computed: graph.computed,
		effect: graph.effect,
		batch: graph.batch,
		untracked: graph.untracked,
		hasSubscribers: graph.hasSubscribers,
		hasActiveSubscriber: graph.hasActiveSubscriber,
		getBatchDepth: graph.getBatchDepth,
		createDeepSignal: graph.createDeepSignal,
		markDeepSignalWatched: graph.markDeepSignalWatched,
		hasDeepSignalSubscribers: graph.hasDeepSignalSubscribers,
		isSpeculative: render.isSpeculative,
		markSpeculativeDeepRead: render.markSpeculativeDeepRead
	};
}
//#endregion
//#region src/core/core-runtime.ts
/** The single graph used by this package's public signal APIs. */
const coreRuntime = createReactiveRuntime();
//#endregion
export { attachReadableInterop as a, isInteropSpeculative as c, untrackedRender as i, markInteropSpeculativeDeepRead as l, hasActiveRenderCollector as n, getReadableInterop as o, notifyListener as r, getSharedInteropContext as s, coreRuntime as t, executionContext as u };

//# sourceMappingURL=core-runtime-Dqo8e5cK.js.map