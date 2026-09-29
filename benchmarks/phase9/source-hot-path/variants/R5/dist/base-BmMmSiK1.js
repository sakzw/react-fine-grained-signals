import { t as coreRuntime } from "./core-runtime-Dqo8e5cK.js";
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
	return coreRuntime.signal(initialValue);
}
/** Creates a lazily evaluated reactive value. */
function computed(getter) {
	return coreRuntime.computed(getter);
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
export { registerSignal as a, SIGNAL_BRAND as c, isSignal as i, computed as n, signal as o, effect as r, untracked as s, batch as t };

//# sourceMappingURL=base-BmMmSiK1.js.map