import { a as setActiveRenderCollector, i as notifyListener, l as getSharedInteropContext, m as withoutInteropSpeculativeMode, p as withInteropSpeculativeMode, r as hasActiveRenderCollector, s as attachReadableInterop, t as activeRenderCollector, u as isInteropSpeculative } from "./render-tracking-COWMYd2U.js";
import * as alienSignalsSystem from "alien-signals/system";
//#region src/core/reactive-runtime.ts
/** Private reactive graph behind the package's consolidated public readables. */
const { createReactiveSystem } = alienSignalsSystem;
const ReactiveFlags = alienSignalsSystem.ReactiveFlags;
const Mutable = ReactiveFlags.Mutable;
const Watching = ReactiveFlags.Watching;
const RecursedCheck = ReactiveFlags.RecursedCheck;
const Dirty = ReactiveFlags.Dirty;
const Pending = ReactiveFlags.Pending;
function withoutComponentRenderCollection(callback, sharedInterop) {
	if (!hasActiveRenderCollector() && sharedInterop.renderCollector === void 0) return callback();
	const previousLocal = setActiveRenderCollector();
	const previousShared = sharedInterop.renderCollector;
	sharedInterop.renderCollector = void 0;
	try {
		return callback();
	} finally {
		sharedInterop.renderCollector = previousShared;
		setActiveRenderCollector(previousLocal);
	}
}
function createReactiveRuntime() {
	const runtimeToken = {};
	const sharedInterop = getSharedInteropContext();
	let activeSub;
	let activeInteropSubscriber;
	let cycle = 0;
	let runDepth = 0;
	let batchDepth = 0;
	let notifyIndex = 0;
	let queuedLength = 0;
	const queue = [];
	let activeRenderReads;
	let speculativeReads;
	let activeSpeculativeComputed;
	const renderingComputeds = /* @__PURE__ */ new Set();
	const externalNodes = /* @__PURE__ */ new WeakMap();
	const deepSignalNodes = /* @__PURE__ */ new WeakSet();
	const deepWatchedNodes = /* @__PURE__ */ new WeakSet();
	class RuntimeReadableInterop {
		version = 1;
		runtimeToken;
		#node;
		constructor(node) {
			this.#node = node;
			this.runtimeToken = runtimeToken;
			Object.freeze(this);
		}
		getRevision() {
			return this.#node.revision;
		}
		subscribe(listener) {
			return subscribeProtocol(this.#node, listener);
		}
	}
	const graphCollector = {
		runtimeToken,
		add(protocol, observedRevision) {
			if (protocol.runtimeToken === runtimeToken) return;
			if (speculativeReads !== void 0) {
				speculativeReads.set(protocol, observedRevision);
				return;
			}
			const subscriber = activeInteropSubscriber;
			if (subscriber === void 0 || subscriber.runtimeToken !== runtimeToken) return;
			if ("fn" in subscriber && !subscriber.active) return;
			const external = externalNodeFor(protocol, observedRevision);
			link(asReactiveNode(external), asReactiveNode(subscriber), cycle);
			if ("getter" in subscriber) subscriber.foreignDependent = true;
			refreshDependencyLiveness(external);
		}
	};
	const bumpRenderRevision = (node) => {
		node.revision += 1;
	};
	const getRenderVersion = (node) => node.revision;
	const renderNodeMethods = {
		getRenderVersion() {
			return getRenderVersion(this);
		},
		subscribeRender(listener) {
			return subscribeRenderNode(this, listener);
		}
	};
	const withoutAllRenderCollection = (callback) => {
		const previousRenderReads = activeRenderReads;
		const previousSpeculativeReads = speculativeReads;
		activeRenderReads = void 0;
		speculativeReads = void 0;
		try {
			return withoutComponentRenderCollection(callback, sharedInterop);
		} finally {
			activeRenderReads = previousRenderReads;
			speculativeReads = previousSpeculativeReads;
		}
	};
	const { link, unlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem({
		update(node) {
			if ("externalProtocol" in node) {
				const external = node;
				const changed = external.currentEpoch !== external.pendingEpoch;
				external.currentEpoch = external.pendingEpoch;
				external.flags = Mutable;
				return changed;
			}
			if ("getter" in node) return updateComputed(node);
			if ("currentValue" in node) {
				const source = node;
				const changed = !Object.is(source.currentValue, source.pendingValue);
				source.currentValue = source.pendingValue;
				source.flags = Mutable;
				return changed;
			}
			node.flags = Mutable;
			return true;
		},
		notify(node) {
			let effect = node;
			let writeIndex = queuedLength;
			let firstWrite = writeIndex;
			for (;;) {
				effect.scheduled = true;
				queue[writeIndex++] = effect;
				effect.flags &= ~Watching;
				const next = effect.subs?.sub;
				if (next === void 0 || !(next.flags & Watching)) break;
				effect = next;
			}
			queuedLength = writeIndex;
			while (firstWrite < --writeIndex) {
				const left = queue[firstWrite];
				queue[firstWrite++] = queue[writeIndex];
				queue[writeIndex] = left;
			}
		},
		unwatched(node) {
			if ("externalProtocol" in node) {
				deactivateExternal(node);
				return;
			}
			if (!("getter" in node)) return;
			const computed = node;
			setComputedLive(computed, false);
			if (computed.depsTail === void 0) return;
			computed.flags = Mutable | Dirty;
			let dependency = computed.depsTail;
			while (dependency !== void 0) {
				const previous = dependency.prevDep;
				unlinkDependency(dependency, computed);
				dependency = previous;
			}
		}
	});
	const asReactiveNode = (node) => node;
	function hasLiveConsumer(node) {
		let subscriberLink = node.subs;
		while (subscriberLink !== void 0) {
			const subscriber = subscriberLink.sub;
			if ("fn" in subscriber && subscriber.active) return true;
			if ("listener" in subscriber && subscriber.active) return true;
			if ("getter" in subscriber && subscriber.live) return true;
			subscriberLink = subscriberLink.nextSub;
		}
		return false;
	}
	function refreshDependencyLiveness(node) {
		if ("externalProtocol" in node) setExternalLive(node, hasLiveConsumer(node));
		else if ("getter" in node && node.foreignDependent) setComputedLive(node, hasLiveConsumer(node));
	}
	function setComputedLive(node, live) {
		if (node.live === live) return;
		node.live = live;
		let dependencyLink = node.deps;
		while (dependencyLink !== void 0) {
			refreshDependencyLiveness(dependencyLink.dep);
			dependencyLink = dependencyLink.nextDep;
		}
	}
	function synchronizeComputedLiveness(node) {
		setComputedLive(node, node.foreignDependent && hasLiveConsumer(node));
	}
	function deactivateExternal(node) {
		const subscription = node.subscription;
		node.subscription = void 0;
		subscription?.unsubscribe();
	}
	function receiveExternalRevision(node, revision) {
		node.lastForeignRevision = revision;
		node.pendingEpoch += 1;
		node.flags |= Dirty;
		if (node.subs !== void 0) {
			propagate(node.subs, runDepth > 0);
			if (batchDepth === 0 && runDepth === 0) flush();
		}
	}
	function activateExternal(node, observedRevision) {
		node.lastForeignRevision = observedRevision;
		if (node.subscription !== void 0) return;
		const subscription = node.externalProtocol.subscribe((revision) => {
			receiveExternalRevision(node, revision);
		});
		node.subscription = subscription;
		if (subscription.revision !== observedRevision) {
			node.lastForeignRevision = subscription.revision;
			node.pendingEpoch += 1;
			node.flags |= Dirty;
			if (node.subs !== void 0) {
				propagate(node.subs, runDepth > 0);
				if (batchDepth === 0 && runDepth === 0) flush();
			}
		}
	}
	function setExternalLive(node, live) {
		if (live) activateExternal(node, node.lastForeignRevision);
		else deactivateExternal(node);
	}
	function externalNodeFor(protocol, observedRevision) {
		let node = externalNodes.get(protocol);
		if (node === void 0) {
			node = {
				kind: "external",
				runtimeToken,
				externalProtocol: protocol,
				subscription: void 0,
				currentEpoch: 0,
				pendingEpoch: 0,
				lastForeignRevision: observedRevision,
				deps: void 0,
				depsTail: void 0,
				subs: void 0,
				subsTail: void 0,
				flags: Mutable
			};
			externalNodes.set(protocol, node);
		} else node.lastForeignRevision = observedRevision;
		return node;
	}
	function withTrackedGraph(subscriber, callback) {
		const previousSubscriber = activeInteropSubscriber;
		const previousCollector = sharedInterop.graphCollector;
		activeInteropSubscriber = subscriber;
		sharedInterop.graphCollector = graphCollector;
		try {
			return callback();
		} finally {
			activeInteropSubscriber = previousSubscriber;
			sharedInterop.graphCollector = previousCollector;
		}
	}
	function withoutGraphCollection(callback) {
		const previousCollector = sharedInterop.graphCollector;
		sharedInterop.graphCollector = void 0;
		try {
			return callback();
		} finally {
			sharedInterop.graphCollector = previousCollector;
		}
	}
	function publishForeignGraphRead(protocol, revision) {
		const collector = sharedInterop.graphCollector;
		if (collector !== void 0 && collector.runtimeToken !== protocol.runtimeToken) collector.add(protocol, revision);
	}
	function publishForeignRenderRead(protocol, revision) {
		sharedInterop.renderCollector?.add(protocol, revision);
	}
	function collectComponentRenderDependency(node, revision) {
		const localCollector = activeRenderCollector;
		const sharedCollector = sharedInterop.renderCollector;
		if (sharedCollector !== void 0 && sharedCollector !== localCollector) publishForeignRenderRead(node.interop, revision);
		else localCollector?.add(node, revision);
	}
	function unsubscribeGraphWatcher(watcher) {
		watcher.active = false;
		watcher.scheduled = false;
		watcher.flags = 0;
		let dependency = watcher.depsTail;
		while (dependency !== void 0) {
			const previous = dependency.prevDep;
			unlinkDependency(dependency, watcher);
			dependency = previous;
		}
	}
	function createGraphWatcher(node, listener) {
		const watcher = {
			kind: "renderWatcher",
			runtimeToken,
			listener,
			scheduled: false,
			active: true,
			deps: void 0,
			depsTail: void 0,
			subs: void 0,
			subsTail: void 0,
			flags: Watching | RecursedCheck
		};
		const previousSub = activeSub;
		activeSub = watcher;
		try {
			cycle += 1;
			try {
				withoutInteropSpeculativeMode(() => {
					if ("getter" in node) {
						promoteSpeculativeCache(node);
						readComputedCore(node);
					} else readSignalCore(node);
				});
			} catch {}
		} finally {
			activeSub = previousSub;
			watcher.flags &= ~RecursedCheck;
			purgeDeps(watcher);
			if (watcher.deps !== void 0) watcher.flags |= Watching;
		}
		return watcher;
	}
	function subscribeProtocol(node, listener) {
		const listeners = node.protocolListeners ??= /* @__PURE__ */ new Set();
		const wasEmpty = listeners.size === 0;
		listeners.add(listener);
		if (wasEmpty) node.protocolWatcher = createGraphWatcher(node, () => {
			const activeListeners = node.protocolListeners;
			if (activeListeners === void 0) return;
			for (const callback of Array.from(activeListeners)) try {
				callback(node.revision);
			} catch {}
		});
		return {
			revision: node.revision,
			unsubscribe() {
				const current = node.protocolListeners;
				if (current === void 0 || !current.delete(listener) || current.size !== 0) return;
				node.protocolListeners = void 0;
				const watcher = node.protocolWatcher;
				node.protocolWatcher = void 0;
				if (watcher !== void 0) unsubscribeGraphWatcher(watcher);
			}
		};
	}
	function track(node) {
		const subscriber = activeSub;
		if (subscriber === void 0 || subscriber === node) return;
		if ("fn" in subscriber) {
			if (!subscriber.active) return;
		}
		link(asReactiveNode(node), asReactiveNode(subscriber), cycle);
		if ("externalProtocol" in node) {
			refreshDependencyLiveness(node);
			if ("getter" in subscriber) subscriber.foreignDependent = true;
		} else if ("getter" in node && node.foreignDependent && "getter" in subscriber) subscriber.foreignDependent = true;
		if ("getter" in node && node.foreignDependent) refreshDependencyLiveness(node);
	}
	function purgeDeps(subscriber) {
		let depLink = subscriber.depsTail !== void 0 ? subscriber.depsTail.nextDep : subscriber.deps;
		while (depLink !== void 0) depLink = unlinkDependency(depLink, subscriber);
	}
	function unlinkDependency(depLink, subscriber) {
		const dependency = depLink.dep;
		const next = unlink(depLink, asReactiveNode(subscriber));
		refreshDependencyLiveness(dependency);
		return next;
	}
	function updateComputed(node) {
		if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
		const hadResult = node.initialized;
		const oldHadError = node.hasError;
		const oldValue = node.value;
		node.error;
		node.depsTail = void 0;
		node.flags = Mutable | RecursedCheck;
		node.foreignDependent = false;
		const previousSub = activeSub;
		activeSub = node;
		try {
			cycle += 1;
			try {
				node.value = withoutInteropSpeculativeMode(() => withTrackedGraph(node, () => withoutComponentRenderCollection(node.getter, sharedInterop)));
				node.error = void 0;
				node.hasError = false;
			} catch (error) {
				node.value = void 0;
				node.error = error;
				node.hasError = true;
			}
			node.initialized = true;
			const changed = !hadResult || node.hasError || oldHadError || !Object.is(oldValue, node.value);
			settleComputedRevision(node, node.hasError, node.value, node.error, hadResult && (node.hasError || oldHadError));
			return changed;
		} finally {
			activeSub = previousSub;
			node.flags &= ~RecursedCheck;
			purgeDeps(node);
			synchronizeComputedLiveness(node);
		}
	}
	function settleComputedRevision(node, hasError, value, error, repeatedErrorIsChange = false) {
		if (node.observedInitialized) {
			if (repeatedErrorIsChange || node.observedHasError !== hasError || !hasError && !Object.is(node.observedValue, value)) bumpRenderRevision(node);
		}
		node.observedInitialized = true;
		node.observedHasError = hasError;
		node.observedValue = value;
	}
	function readSignalCore(node) {
		if (node.flags & Dirty) {
			const changed = !Object.is(node.currentValue, node.pendingValue);
			node.currentValue = node.pendingValue;
			node.flags = Mutable;
			if (changed && node.subs !== void 0) shallowPropagate(node.subs);
		}
		track(node);
		return node.currentValue;
	}
	function readComputedCore(node) {
		if (node.flags & RecursedCheck) throw new Error("Computed cycle detected");
		if (node.foreignDependent && !node.live) node.flags |= Dirty;
		const flags = node.flags;
		if (flags & Dirty || flags & Pending && node.deps !== void 0 && checkDirty(node.deps, asReactiveNode(node))) {
			if (updateComputed(node) && node.subs !== void 0) shallowPropagate(node.subs);
		} else if (!node.initialized) updateComputed(node);
		track(node);
		if (node.hasError) throw node.error;
		return node.value;
	}
	function speculativeDependenciesAreCurrent(node, knownPromotable = false) {
		if (!knownPromotable && !node.speculativeCachePromotable) return false;
		const deps = node.speculativeDeps;
		if (node.speculativeResult === void 0 || deps === void 0) return false;
		for (const [dependency, revision] of deps) {
			if ("getRevision" in dependency) {
				const protocol = dependency;
				let subscription;
				try {
					subscription = protocol.subscribe(() => void 0);
				} catch {
					return false;
				}
				const currentRevision = subscription.revision;
				subscription.unsubscribe();
				if (currentRevision !== revision) return false;
				continue;
			}
			if ("getter" in dependency) {
				if (!computedIsCurrent(dependency)) return false;
			}
			if (getRenderVersion(dependency) !== revision) return false;
		}
		return true;
	}
	function computedIsCurrent(node) {
		if (node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live)) return true;
		if (speculativeDependenciesAreCurrent(node)) return true;
		try {
			readComputedForRender(node);
		} catch {}
		return speculativeDependenciesAreCurrent(node) || node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live);
	}
	function evaluateSpeculatively(node) {
		if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
		renderingComputeds.add(node);
		const previousSub = activeSub;
		const previousReads = speculativeReads;
		const previousSpeculativeComputed = activeSpeculativeComputed;
		activeSub = void 0;
		const deps = /* @__PURE__ */ new Map();
		speculativeReads = deps;
		activeSpeculativeComputed = node;
		const speculativeDeepReadEpoch = sharedInterop.speculativeDeepReadEpoch ?? 0;
		let result;
		try {
			result = withInteropSpeculativeMode(() => withTrackedGraph(node, () => withoutComponentRenderCollection(() => {
				try {
					return {
						hasError: false,
						value: node.getter(),
						error: void 0
					};
				} catch (error) {
					return {
						hasError: true,
						value: void 0,
						error
					};
				}
			}, sharedInterop)));
		} finally {
			speculativeReads = previousReads;
			activeSpeculativeComputed = previousSpeculativeComputed;
			activeSub = previousSub;
			renderingComputeds.delete(node);
		}
		node.speculativeResult = result;
		node.speculativeDeps = deps;
		node.speculativeCachePromotable = (sharedInterop.speculativeDeepReadEpoch ?? 0) === speculativeDeepReadEpoch;
		settleComputedRevision(node, result.hasError, result.value, result.error, result.hasError);
		return result;
	}
	function readComputedForRender(node) {
		if (renderingComputeds.has(node)) throw new Error("Computed cycle detected");
		const cleanGraph = node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live);
		let result;
		if (speculativeReads !== void 0 && node !== activeSpeculativeComputed) result = withoutInteropSpeculativeMode(() => {
			try {
				readComputedCore(node);
				return {
					hasError: node.hasError,
					value: node.value,
					error: node.error
				};
			} catch (error) {
				return {
					hasError: true,
					value: void 0,
					error
				};
			}
		});
		else if (cleanGraph) result = {
			hasError: node.hasError,
			value: node.value,
			error: node.error
		};
		else if (speculativeDependenciesAreCurrent(node)) result = node.speculativeResult;
		else result = evaluateSpeculatively(node);
		if (activeRenderReads !== void 0 && !activeRenderReads.has(node)) activeRenderReads.set(node, getRenderVersion(node));
		if (speculativeReads !== void 0 && node !== activeSpeculativeComputed && !speculativeReads.has(node)) speculativeReads.set(node, getRenderVersion(node));
		if (result.hasError) throw result.error;
		return result.value;
	}
	function promoteSpeculativeCache(node) {
		if (node.initialized && !(node.flags & (Dirty | Pending)) && !(node.foreignDependent && !node.live)) return true;
		if (!node.speculativeCachePromotable) return false;
		if (!speculativeDependenciesAreCurrent(node, true)) return false;
		const result = node.speculativeResult;
		const deps = node.speculativeDeps;
		for (const dependency of deps.keys()) if (!("getRevision" in dependency) && "getter" in dependency) promoteSpeculativeCache(dependency);
		node.value = result.value;
		node.error = result.error;
		node.hasError = result.hasError;
		node.initialized = true;
		node.foreignDependent = false;
		node.depsTail = void 0;
		node.flags = Mutable | RecursedCheck;
		const previousSub = activeSub;
		activeSub = node;
		cycle += 1;
		try {
			for (const [dependency, revision] of deps) if ("getRevision" in dependency) {
				const external = externalNodeFor(dependency, revision);
				link(asReactiveNode(external), asReactiveNode(node), cycle);
				node.foreignDependent = true;
				refreshDependencyLiveness(external);
			} else {
				link(asReactiveNode(dependency), asReactiveNode(node), cycle);
				if ("getter" in dependency && dependency.foreignDependent) node.foreignDependent = true;
				if ("getter" in dependency && dependency.foreignDependent) refreshDependencyLiveness(dependency);
			}
		} finally {
			activeSub = previousSub;
			node.flags &= ~RecursedCheck;
		}
		purgeDeps(node);
		synchronizeComputedLiveness(node);
		return true;
	}
	function readComputed(node) {
		if (activeRenderReads !== void 0 || hasActiveRenderCollector()) return readComputedForRender(node);
		if (speculativeReads !== void 0) return readComputedForRender(node);
		if (!node.initialized || node.flags & (Dirty | Pending)) promoteSpeculativeCache(node);
		return readComputedCore(node);
	}
	function runCleanup(effect) {
		const cleanup = effect.cleanup;
		effect.cleanup = void 0;
		if (cleanup === void 0) return;
		const previousSub = activeSub;
		activeSub = void 0;
		try {
			withoutInteropSpeculativeMode(() => withoutGraphCollection(() => withoutAllRenderCollection(cleanup)));
		} catch (error) {
			safelyReport(error);
		} finally {
			activeSub = previousSub;
		}
	}
	function run(effect) {
		if (!effect.active || effect.running) return;
		const flags = effect.flags;
		if (!(flags & Dirty) && (!(flags & Pending) || effect.deps === void 0 || !checkDirty(effect.deps, asReactiveNode(effect)))) {
			if (effect.deps !== void 0) effect.flags = Watching;
			return;
		}
		if (effect.cleanup !== void 0) {
			runCleanup(effect);
			if (!effect.active) return;
		}
		effect.depsTail = void 0;
		effect.flags = Watching | RecursedCheck;
		effect.scheduled = false;
		effect.running = true;
		const previousSub = activeSub;
		activeSub = effect;
		try {
			cycle += 1;
			runDepth += 1;
			try {
				const cleanup = withoutInteropSpeculativeMode(() => withTrackedGraph(effect, () => withoutAllRenderCollection(effect.fn)));
				if (effect.active) effect.cleanup = typeof cleanup === "function" ? cleanup : void 0;
				else if (typeof cleanup === "function") runCleanupValue(cleanup);
			} catch (error) {
				safelyReport(error);
			}
		} finally {
			runDepth -= 1;
			activeSub = previousSub;
			effect.running = false;
			effect.flags &= ~RecursedCheck;
			purgeDeps(effect);
			if (effect.active && !effect.scheduled) effect.flags |= Watching;
		}
	}
	function runRenderWatcher(watcher) {
		if (!watcher.active || !watcher.scheduled) return;
		watcher.scheduled = false;
		const flags = watcher.flags;
		if (!(flags & Dirty) && (!(flags & Pending) || watcher.deps === void 0 || !checkDirty(watcher.deps, asReactiveNode(watcher)))) {
			if (watcher.deps !== void 0) watcher.flags = Watching;
			return;
		}
		watcher.flags = Watching;
		if (watcher.listener !== void 0) withoutAllRenderCollection(watcher.listener);
		if (watcher.scheduled) watcher.flags &= ~Watching;
	}
	function subscribeRenderNode(node, listener) {
		const listeners = node.renderListeners ??= /* @__PURE__ */ new Set();
		const wasEmpty = listeners.size === 0;
		listeners.add(listener);
		if (wasEmpty) node.renderWatcher = createGraphWatcher(node, () => {
			const activeListeners = node.renderListeners;
			if (activeListeners === void 0) return;
			for (const renderListener of [...activeListeners]) notifyListener(renderListener);
		});
		return () => {
			const current = node.renderListeners;
			if (current === void 0 || !current.delete(listener)) return;
			if (current.size !== 0) return;
			node.renderListeners = void 0;
			const watcher = node.renderWatcher;
			node.renderWatcher = void 0;
			if (watcher !== void 0) unsubscribeGraphWatcher(watcher);
		};
	}
	function flush() {
		flushQueue();
	}
	function flushQueue() {
		try {
			while (notifyIndex < queuedLength) {
				const effect = queue[notifyIndex];
				queue[notifyIndex++] = void 0;
				if (effect !== void 0) {
					if ("fn" in effect) run(effect);
					else runRenderWatcher(effect);
				}
			}
		} finally {
			while (notifyIndex < queuedLength) {
				const effect = queue[notifyIndex];
				queue[notifyIndex++] = void 0;
				if (effect !== void 0) effect.flags |= Watching | Dirty;
			}
			notifyIndex = 0;
			queuedLength = 0;
		}
	}
	function safelyReport(error) {
		try {
			reportFailure(error);
		} catch {}
	}
	function untracked(fn) {
		const previousSub = activeSub;
		activeSub = void 0;
		try {
			return withoutGraphCollection(() => withoutAllRenderCollection(fn));
		} finally {
			activeSub = previousSub;
		}
	}
	function runCleanupValue(cleanup) {
		const previousSub = activeSub;
		activeSub = void 0;
		try {
			withoutInteropSpeculativeMode(() => withoutGraphCollection(() => withoutAllRenderCollection(cleanup)));
		} catch (error) {
			safelyReport(error);
		} finally {
			activeSub = previousSub;
		}
	}
	function readSignalValue(node) {
		if (activeSub !== void 0 && !isInteropSpeculative()) return readSignalCore(node);
		if (speculativeReads !== void 0) {
			if (!speculativeReads.has(node)) speculativeReads.set(node, getRenderVersion(node));
			return node.flags & Dirty ? node.pendingValue : node.currentValue;
		}
		if (isInteropSpeculative()) {
			publishForeignGraphRead(node.interop, node.revision);
			return node.flags & Dirty ? node.pendingValue : node.currentValue;
		}
		if (activeRenderReads !== void 0) {
			const reads = activeRenderReads;
			if (!reads.has(node)) reads.set(node, getRenderVersion(node));
			const value = node.flags & Dirty ? node.pendingValue : node.currentValue;
			collectComponentRenderDependency(node, reads.get(node));
			return value;
		}
		if (activeRenderCollector !== void 0 || sharedInterop.renderCollector !== void 0) {
			collectComponentRenderDependency(node, getRenderVersion(node));
			return node.flags & Dirty ? node.pendingValue : node.currentValue;
		}
		publishForeignGraphRead(node.interop, node.revision);
		return readSignalCore(node);
	}
	function writeSignalValue(node, next) {
		if (deepSignalNodes.has(node)) deepWatchedNodes.delete(node);
		if (Object.is(node.pendingValue, next)) return;
		node.pendingValue = next;
		bumpRenderRevision(node);
		node.flags = Mutable | Dirty;
		if (node.subs !== void 0) {
			propagate(node.subs, runDepth > 0);
			if (batchDepth === 0 && runDepth === 0) flush();
		}
	}
	function readComputedValue(node) {
		if (activeSub !== void 0 && !isInteropSpeculative()) return readComputedCore(node);
		const localRender = activeRenderReads !== void 0 || speculativeReads !== void 0 || activeRenderCollector !== void 0 || sharedInterop.renderCollector !== void 0 || isInteropSpeculative();
		let value;
		try {
			value = localRender ? readComputedForRender(node) : readComputed(node);
			return value;
		} finally {
			if (localRender) {
				if (activeRenderReads !== void 0 && !activeRenderReads.has(node)) activeRenderReads.set(node, getRenderVersion(node));
				collectComponentRenderDependency(node, activeRenderReads?.get(node) ?? getRenderVersion(node));
			}
			publishForeignGraphRead(node.interop, node.revision);
		}
	}
	class RuntimeSignalReadable {
		#node;
		constructor(node) {
			this.#node = node;
			node.interop = new RuntimeReadableInterop(node);
			attachReadableInterop(this, node.interop);
		}
		get value() {
			return readSignalValue(this.#node);
		}
		set value(next) {
			writeSignalValue(this.#node, next);
		}
		peek() {
			return this.#node.pendingValue;
		}
		static nodeOf(readable) {
			const candidate = readable;
			return #node in candidate ? candidate.#node : void 0;
		}
	}
	class RuntimeComputedReadable {
		#node;
		constructor(node) {
			this.#node = node;
			node.interop = new RuntimeReadableInterop(node);
			attachReadableInterop(this, node.interop);
		}
		get value() {
			return readComputedValue(this.#node);
		}
		peek() {
			return untracked(() => withoutInteropSpeculativeMode(() => readComputedCore(this.#node)));
		}
		static nodeOf(readable) {
			const candidate = readable;
			return #node in candidate ? candidate.#node : void 0;
		}
	}
	function nodeForReadable(readable) {
		if (readable === null || typeof readable !== "object" && typeof readable !== "function") return;
		return RuntimeSignalReadable.nodeOf(readable) ?? RuntimeComputedReadable.nodeOf(readable);
	}
	const runtime = {
		signal(initialValue) {
			const node = Object.assign({
				kind: "source",
				runtimeToken,
				interop: void 0,
				currentValue: initialValue,
				pendingValue: initialValue,
				revision: 0,
				renderListeners: void 0,
				renderWatcher: void 0,
				protocolListeners: void 0,
				protocolWatcher: void 0,
				deps: void 0,
				depsTail: void 0,
				subs: void 0,
				subsTail: void 0,
				flags: Mutable
			}, renderNodeMethods);
			return new RuntimeSignalReadable(node);
		},
		computed(getter) {
			const node = Object.assign({
				kind: "computed",
				runtimeToken,
				interop: void 0,
				getter,
				initialized: false,
				hasError: false,
				value: void 0,
				error: void 0,
				revision: 0,
				observedInitialized: false,
				observedHasError: false,
				observedValue: void 0,
				speculativeResult: void 0,
				speculativeDeps: void 0,
				speculativeCachePromotable: false,
				foreignDependent: false,
				live: false,
				renderListeners: void 0,
				renderWatcher: void 0,
				protocolListeners: void 0,
				protocolWatcher: void 0,
				deps: void 0,
				depsTail: void 0,
				subs: void 0,
				subsTail: void 0,
				flags: 0
			}, renderNodeMethods);
			return new RuntimeComputedReadable(node);
		},
		effect(fn) {
			const effect = {
				kind: "reaction",
				runtimeToken,
				fn,
				cleanup: void 0,
				active: true,
				running: false,
				scheduled: false,
				deps: void 0,
				depsTail: void 0,
				subs: void 0,
				subsTail: void 0,
				flags: Watching | RecursedCheck
			};
			effect.flags &= ~RecursedCheck;
			runInitial(effect);
			return () => {
				if (!effect.active) return;
				effect.active = false;
				effect.flags = 0;
				let dep = effect.depsTail;
				while (dep !== void 0) dep = unlinkDependency(dep, effect) ?? void 0;
				runCleanup(effect);
			};
		},
		batch(fn) {
			batchDepth += 1;
			try {
				return fn();
			} finally {
				batchDepth -= 1;
				if (batchDepth === 0 && runDepth === 0) flush();
			}
		},
		untracked(fn) {
			return untracked(fn);
		},
		hasSubscribers(readable) {
			const node = nodeForReadable(readable);
			return node !== void 0 && hasLiveConsumer(node);
		},
		hasActiveSubscriber() {
			return activeSub !== void 0;
		},
		getBatchDepth() {
			return batchDepth;
		},
		createDeepSignal(initialValue) {
			const readable = runtime.signal(initialValue);
			const node = RuntimeSignalReadable.nodeOf(readable);
			if (node === void 0 || node.kind !== "source") throw new TypeError("failed to create deep signal source");
			deepSignalNodes.add(node);
			return readable;
		},
		markDeepSignalWatched(readable) {
			const node = nodeForReadable(readable);
			if (node !== void 0 && node.kind === "source" && deepSignalNodes.has(node)) deepWatchedNodes.add(node);
		},
		hasDeepSignalSubscribers(readable) {
			const node = nodeForReadable(readable);
			if (node === void 0 || node.kind !== "source" || !deepSignalNodes.has(node)) return false;
			return deepWatchedNodes.has(node) || hasLiveConsumer(node);
		}
	};
	return runtime;
	function runInitial(effect) {
		effect.depsTail = void 0;
		const previousSub = activeSub;
		activeSub = effect;
		effect.running = true;
		runDepth += 1;
		try {
			try {
				const cleanup = withoutInteropSpeculativeMode(() => withTrackedGraph(effect, () => withoutAllRenderCollection(effect.fn)));
				effect.cleanup = typeof cleanup === "function" ? cleanup : void 0;
			} catch (error) {
				safelyReport(error);
			}
		} finally {
			runDepth -= 1;
			activeSub = previousSub;
			effect.running = false;
			purgeDeps(effect);
			if (effect.active && !effect.scheduled) effect.flags |= Watching;
		}
		if (runDepth === 0 && batchDepth === 0) flush();
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
//#endregion
//#region src/core/core-runtime.ts
/** The single graph used by this package's public signal APIs. */
const coreRuntime = createReactiveRuntime();
//#endregion
//#region src/core/signal-brand.ts
/** Package-wide identity marker shared by public signal wrappers and deep proxies. */
const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
//#endregion
//#region src/core/base.ts
const signalInstances = /* @__PURE__ */ new WeakSet();
const SIGNAL_BRAND_VERSION = 1;
const SIGNAL_BRAND_MIN_VERSION = 1;
/** Marks an internal signal implementation for the public identity guard. */
function registerSignal(value) {
	signalInstances.add(value);
	Object.defineProperty(value, SIGNAL_BRAND, {
		value: SIGNAL_BRAND_VERSION,
		enumerable: false,
		writable: false,
		configurable: false
	});
	return value;
}
/** Returns whether a value came from this package's signal APIs, any copy. */
function isSignal(value) {
	if (typeof value !== "object" || value === null) return false;
	if (signalInstances.has(value)) return true;
	const brand = value[SIGNAL_BRAND];
	if (typeof brand !== "number" || brand < SIGNAL_BRAND_MIN_VERSION) return false;
	return typeof value.peek === "function";
}
/** Creates a writable reactive value. */
function signal(initialValue) {
	return registerSignal(coreRuntime.signal(initialValue));
}
/** Creates a lazily evaluated reactive value. */
function computed(getter) {
	return registerSignal(coreRuntime.computed(getter));
}
/** Runs a reactive side effect and returns a disposer. */
function effect(fn) {
	return coreRuntime.effect(fn);
}
/** Groups writes, deferring effect notifications until the callback completes. */
function batch(fn) {
	return coreRuntime.batch(fn);
}
/** Runs a callback without collecting reactive dependencies. */
function untracked(fn) {
	return coreRuntime.untracked(fn);
}
//#endregion
export { registerSignal as a, SIGNAL_BRAND as c, isSignal as i, coreRuntime as l, computed as n, signal as o, effect as r, untracked as s, batch as t };

//# sourceMappingURL=base-ZLzD296G.js.map