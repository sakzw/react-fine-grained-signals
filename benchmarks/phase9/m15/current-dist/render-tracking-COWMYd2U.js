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
/** Push a render boundary and restore only a still-active parent boundary. */
function pushInteropRenderScope(scope, collector) {
	const context = getSharedInteropContext();
	const previousScope = context.renderScope;
	const previousCollector = context.renderCollector;
	context.renderScope = scope;
	context.renderCollector = collector;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (context.renderScope !== scope) return;
		const restoreScope = previousScope?.isActive() ? previousScope : void 0;
		context.renderScope = restoreScope;
		context.renderCollector = restoreScope === void 0 ? void 0 : previousCollector;
	};
}
function withoutInteropRenderCollector(callback) {
	return withInteropRenderCollector(void 0, callback);
}
function withInteropSpeculativeMode(callback) {
	const context = getSharedInteropContext();
	context.speculativeDepth += 1;
	try {
		return callback();
	} finally {
		context.speculativeDepth -= 1;
	}
}
/** Run durable graph work without inheriting an outer speculative callback. */
function withoutInteropSpeculativeMode(callback) {
	const context = getSharedInteropContext();
	const previousDepth = context.speculativeDepth;
	context.speculativeDepth = 0;
	try {
		return callback();
	} finally {
		context.speculativeDepth = previousDepth;
	}
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
const foreignRenderDependencies = /* @__PURE__ */ new WeakMap();
var ForeignRenderDependency = class {
	protocol;
	constructor(protocol) {
		this.protocol = protocol;
	}
	getRenderVersion() {
		return this.protocol.getRevision();
	}
	subscribeRender(listener) {
		const subscription = this.protocol.subscribe(() => listener());
		return () => subscription.unsubscribe();
	}
};
/** Reuse one render adapter for each foreign readable protocol. */
function getForeignRenderDependency(protocol) {
	let dependency = foreignRenderDependencies.get(protocol);
	if (dependency === void 0) {
		dependency = new ForeignRenderDependency(protocol);
		foreignRenderDependencies.set(protocol, dependency);
	}
	return dependency;
}
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
/** Runs a callback without adding its reads to the active React render. */
function untrackedRender(callback) {
	const previous = setActiveRenderCollector();
	try {
		return withoutInteropRenderCollector(callback);
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
export { setActiveRenderCollector as a, getReadableInterop as c, markInteropSpeculativeDeepRead as d, pushInteropRenderScope as f, notifyListener as i, getSharedInteropContext as l, withoutInteropSpeculativeMode as m, getForeignRenderDependency as n, untrackedRender as o, withInteropSpeculativeMode as p, hasActiveRenderCollector as r, attachReadableInterop as s, activeRenderCollector as t, isInteropSpeculative as u };

//# sourceMappingURL=render-tracking-COWMYd2U.js.map