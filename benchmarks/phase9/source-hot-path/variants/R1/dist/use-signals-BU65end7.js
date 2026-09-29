import { t as coreRuntime } from "./core-runtime-Dqo8e5cK.js";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
//#region src/react/react-adapter.mts
function createAlienDerivedReactAdapter(_core, render) {
	function isInteropProtocol(dependency) {
		return Reflect.get(dependency, "version") === 1 && typeof Reflect.get(dependency, "getRevision") === "function" && typeof Reflect.get(dependency, "subscribe") === "function";
	}
	function dependencyVersion(dependency) {
		return isInteropProtocol(dependency) ? dependency.getRevision() : render.getRenderVersion(dependency);
	}
	function subscribeDependency(dependency, notify) {
		if (isInteropProtocol(dependency)) return dependency.subscribe(() => notify()).unsubscribe;
		const subscribeRender = Reflect.get(dependency, "subscribeRender");
		if (typeof subscribeRender === "function") return subscribeRender.call(dependency, notify);
		return render.subscribeReadables([dependency], notify);
	}
	function snapshot(readable, cache) {
		const captured = render.captureRenderSnapshot(readable);
		const current = cache.current;
		if (current !== void 0 && current.dependencies.size === captured.dependencies.size && [...captured.dependencies].every(([dependency, revision]) => current.dependencies.get(dependency) === revision && dependencyVersion(dependency) === revision)) return current.value;
		cache.current = captured;
		return captured.value;
	}
	class RenderStore {
		#mode;
		#subscriptions = /* @__PURE__ */ new Map();
		#combinedDependencies = /* @__PURE__ */ new Set();
		#listeners = /* @__PURE__ */ new Set();
		#version = 0;
		#epoch = 0;
		constructor(mode) {
			this.#mode = mode;
		}
		getSnapshot = () => this.#version;
		subscribe = (listener) => {
			this.#listeners.add(listener);
			return () => this.#listeners.delete(listener);
		};
		begin(scopePolicy) {
			const attempt = render.createRenderAttempt();
			attempt.restoreScope = render.pushRenderScope(attempt, scopePolicy);
			this.#epoch += 1;
			queueMicrotask(() => this.finish(attempt));
			return attempt;
		}
		finish(attempt) {
			attempt?.restoreScope?.();
			attempt.restoreScope = void 0;
		}
		commit(attempt) {
			this.finish(attempt);
			let changedDuringRender = !render.promoteRenderAttempt(attempt);
			const desired = attempt.dependencies;
			if (this.#mode === "combined") {
				const local = new Set([...desired.keys()].filter((dependency) => !isInteropProtocol(dependency)));
				if (!(local.size === this.#combinedDependencies.size && [...local].every((dependency) => this.#combinedDependencies.has(dependency)))) {
					this.#subscriptions.get(this)?.();
					this.#subscriptions.delete(this);
					this.#combinedDependencies = local;
					if (local.size > 0) this.#subscriptions.set(this, render.subscribeReadables([...local], this.#notify));
				}
				for (const [dependency, unsubscribe] of this.#subscriptions) if (dependency !== this && (!isInteropProtocol(dependency) || !desired.has(dependency))) {
					unsubscribe();
					this.#subscriptions.delete(dependency);
				}
				for (const dependency of desired.keys()) if (isInteropProtocol(dependency) && !this.#subscriptions.has(dependency)) this.#subscriptions.set(dependency, subscribeDependency(dependency, this.#notify));
			} else {
				for (const [dependency, unsubscribe] of this.#subscriptions) if (!desired.has(dependency)) {
					unsubscribe();
					this.#subscriptions.delete(dependency);
				}
				for (const dependency of desired.keys()) if (!this.#subscriptions.has(dependency)) this.#subscriptions.set(dependency, subscribeDependency(dependency, this.#notify));
			}
			if (!render.settleRenderAttempt(attempt)) changedDuringRender = true;
			if (changedDuringRender) this.#notify();
		}
		#notify = () => {
			this.#version = this.#version + 1 | 0;
			for (const listener of this.#listeners) listener();
		};
		dispose() {
			for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
			this.#subscriptions.clear();
			this.#combinedDependencies.clear();
		}
		scheduleDispose() {
			const epoch = ++this.#epoch;
			queueMicrotask(() => {
				if (this.#epoch === epoch) this.dispose();
			});
		}
		activate() {
			this.#epoch += 1;
		}
	}
	function createReactAdapter(runtimeOrOptions = {}, maybeOptions = {}) {
		const mode = maybeOptions.mode ?? runtimeOrOptions.mode ?? "combined";
		if (mode !== "combined" && mode !== "per-readable") throw new Error(`Unknown render subscription mode: ${mode}`);
		function useSignalValue(readable) {
			const subscribe = useMemo(() => (notify) => subscribeDependency(readable, notify), [readable]);
			const cache = useMemo(() => ({
				readable,
				current: void 0
			}), [readable]);
			const getSnapshot = useMemo(() => () => snapshot(readable, cache), [readable, cache]);
			return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}
		function useTrackingStore(scopePolicy) {
			const store = useMemo(() => new RenderStore(mode), []);
			useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const attempt = store.begin(scopePolicy);
			useLayoutEffect(() => {
				store.commit(attempt);
			}, [store, attempt]);
			useEffect(() => {
				store.activate();
				return () => store.scheduleDispose();
			}, [store]);
			return {
				store,
				attempt
			};
		}
		function useSignalTracking() {
			useTrackingStore("bare");
		}
		function useManagedSignals() {
			const { store, attempt } = useTrackingStore("managed");
			return {
				finish: () => store.finish(attempt),
				getSnapshot: store.getSnapshot
			};
		}
		return {
			useSignalValue,
			useSignalTracking,
			useManagedSignals
		};
	}
	function managed(scope, callback) {
		try {
			return callback();
		} finally {
			scope.finish();
		}
	}
	return {
		createReactAdapter,
		managed
	};
}
//#endregion
//#region src/react/use-signals.ts
const reactAdapter = createAlienDerivedReactAdapter(coreRuntime, coreRuntime.renderAdapter).createReactAdapter();
/** Best-effort render tracking for untransformed components. */
function useSignalTracking() {
	reactAdapter.useSignalTracking();
}
/** Exact render scope used by the transform-managed boundary. */
function useManagedSignals() {
	return reactAdapter.useManagedSignals();
}
//#endregion
export { useSignalTracking as n, useManagedSignals as t };

//# sourceMappingURL=use-signals-BU65end7.js.map