import { a as setActiveRenderCollector, f as pushInteropRenderScope, i as notifyListener, l as getSharedInteropContext, n as getForeignRenderDependency } from "./render-tracking-COWMYd2U.js";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
//#region src/react/use-signals.ts
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const resolvedPromise = Promise.resolve();
/** Coalesces only the bare hook's best-effort trailing cleanup microtask. */
let finalCleanupScheduled = false;
/**
* A still-open scope is left alone only when both it and the incoming `next`
* scope are managed. A managed scope's owner is contractually responsible
* for closing it itself, so overlapping managed scopes are tolerated as a
* transient nesting rather than treated
* as one of them having been abandoned. Anything else overlapping a
* still-open scope — `next` is unmanaged, or the still-open scope itself is
* unmanaged — is not a rule-following nesting, so the leftover scope is
* force-closed before `next` starts.
*/
function shouldCloseCurrentScope(next, current) {
	return next === "bare" || !current.managed;
}
/** Close only a bare top scope; managed scopes own a synchronous `finish()`. */
function cleanupTrailingBareScope() {
	finalCleanupScheduled = false;
	const scope = getSharedInteropContext().renderScope;
	if (scope !== void 0 && !scope.managed) scope.finish();
}
function ensureFinalCleanup() {
	if (finalCleanupScheduled) return;
	finalCleanupScheduled = true;
	resolvedPromise.then(cleanupTrailingBareScope);
}
var RenderStore = class {
	#reactListeners = /* @__PURE__ */ new Set();
	#dependencySubscriptions = /* @__PURE__ */ new Map();
	#pendingDependencies;
	#finishCollection;
	#disposeGeneration = 0;
	#version = 0;
	subscribe = (listener) => {
		this.#disposeGeneration += 1;
		this.#reactListeners.add(listener);
		return () => {
			this.#reactListeners.delete(listener);
			if (this.#reactListeners.size !== 0) return;
			const generation = ++this.#disposeGeneration;
			resolvedPromise.then(() => {
				if (generation === this.#disposeGeneration && this.#reactListeners.size === 0) {
					this.#disposeDependencies();
					this.#pendingDependencies = void 0;
				}
			});
		};
	};
	getSnapshot = () => this.#version;
	add(dependencyOrProtocol, observedVersion) {
		const dependency = "getRevision" in dependencyOrProtocol ? getForeignRenderDependency(dependencyOrProtocol) : dependencyOrProtocol;
		const pending = this.#pendingDependencies;
		if (pending !== void 0 && !pending.has(dependency)) pending.set(dependency, observedVersion);
	}
	start(policy) {
		if (this.#finishCollection !== void 0) this.finish();
		const sharedContext = getSharedInteropContext();
		while (sharedContext.renderScope !== void 0 && shouldCloseCurrentScope(policy, sharedContext.renderScope)) sharedContext.renderScope.finish();
		this.#pendingDependencies = /* @__PURE__ */ new Map();
		const previousCollector = setActiveRenderCollector(this);
		let scopeActive = true;
		const restoreSharedScope = pushInteropRenderScope({
			token: {},
			managed: policy === "managed",
			isActive: () => scopeActive,
			finish: () => this.finish()
		}, this);
		this.#finishCollection = () => {
			scopeActive = false;
			restoreSharedScope();
			setActiveRenderCollector(previousCollector);
		};
	}
	isScopeActive() {
		return this.#finishCollection !== void 0;
	}
	finish() {
		const finishCollection = this.#finishCollection;
		this.#finishCollection = void 0;
		finishCollection?.();
	}
	commit() {
		const dependencies = this.#pendingDependencies;
		this.#pendingDependencies = void 0;
		if (dependencies === void 0) return;
		for (const [dependency, unsubscribe] of this.#dependencySubscriptions) if (!dependencies.has(dependency)) {
			unsubscribe();
			this.#dependencySubscriptions.delete(dependency);
		}
		let changedDuringRender = false;
		for (const [dependency, renderVersion] of dependencies) {
			if (!this.#dependencySubscriptions.has(dependency)) this.#dependencySubscriptions.set(dependency, dependency.subscribeRender(this.#notifyReact));
			if (dependency.getRenderVersion() !== renderVersion) changedDuringRender = true;
		}
		if (changedDuringRender) this.#notifyReact();
	}
	#notifyReact = () => {
		this.#version = this.#version + 1 | 0;
		for (const listener of [...this.#reactListeners]) notifyListener(listener);
	};
	#disposeDependencies() {
		for (const unsubscribe of this.#dependencySubscriptions.values()) unsubscribe();
		this.#dependencySubscriptions.clear();
	}
};
/**
* Makes the component reactive to signals whose `.value` is read during render.
* Call this as the component's first hook and before those reads.
*/
function useSignalTrackingImplementation(policy) {
	if (policy === "bare") ensureFinalCleanup();
	const storeRef = useRef(void 0);
	if (storeRef.current === void 0) storeRef.current = new RenderStore();
	const store = storeRef.current;
	useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	store.start(policy);
	useIsomorphicLayoutEffect(() => {
		if (policy === "bare") cleanupTrailingBareScope();
		else if (store.isScopeActive()) store.finish();
		store.commit();
	});
	return store;
}
/**
* Makes the component reactive to signals whose `.value` is read during render.
* Call this as the component's first hook and before those reads.
*
* The boundary is best-effort: tracking stays open until the next
* `useSignalTracking()` call, the commit-phase layout effect, or a microtask — not the
* point the component returns. Every component that reads a signal during
* render must call this itself; a read from a sibling or descendant that does
* not can be attributed to another component's still-open boundary, and then
* silently stops updating the component that read it. Use the bundler
* plugin's default `transform: "managed"` for an exact boundary. See
* docs/design/use-signals-boundary-design.md.
*/
function useSignalTracking() {
	useSignalTrackingImplementation("bare");
}
/** Starts a managed render scope that must be closed synchronously with `finish()`. */
function useManagedSignals() {
	return useSignalTrackingImplementation("managed");
}
//#endregion
export { useSignalTracking as n, useManagedSignals as t };

//# sourceMappingURL=use-signals-BZEsQWNr.js.map