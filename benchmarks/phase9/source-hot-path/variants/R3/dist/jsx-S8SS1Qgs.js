import { r as notifyListener } from "./core-runtime-Dqo8e5cK.js";
import { i as isSignal, r as effect, s as untracked } from "./base-BmMmSiK1.js";
import { o as useSignalValue, s as subscribeReadableV1 } from "./hooks-BO5dRw7P.js";
import { Fragment, createElement, useLayoutEffect, useRef } from "react";
//#region src/runtime/jsx.ts
/** The small set of DOM properties that support direct signal bindings. */
const REACTIVE_PROP_NAMES = /* @__PURE__ */ new Set([
	"title",
	"id",
	"className",
	"hidden",
	"disabled",
	"style",
	"value",
	"checked"
]);
function isControlledTwoWayProp(tagName, name) {
	if (name === "value") return tagName === "input" || tagName === "textarea" || tagName === "select";
	if (name === "checked") return tagName === "input";
	return false;
}
function resolveBindingKind(tagName, name) {
	if (name === "style") return "style";
	if (isControlledTwoWayProp(tagName, name)) {
		if (name === "value") return tagName === "select" ? "select-value" : "text-value";
		return "checked";
	}
	return "prop";
}
function isTwoWayBindingKind(kind) {
	return kind === "select-value" || kind === "text-value" || kind === "checked";
}
const UNCONTROLLED_PROP_NAMES = {
	value: "defaultValue",
	checked: "defaultChecked"
};
const UNITLESS_CSS_PROPERTIES = /* @__PURE__ */ new Set([
	"animationIterationCount",
	"aspectRatio",
	"borderImageOutset",
	"borderImageSlice",
	"borderImageWidth",
	"boxFlex",
	"boxFlexGroup",
	"boxOrdinalGroup",
	"columnCount",
	"columns",
	"flex",
	"flexGrow",
	"flexPositive",
	"flexShrink",
	"flexNegative",
	"flexOrder",
	"gridArea",
	"gridColumn",
	"gridColumnEnd",
	"gridColumnSpan",
	"gridColumnStart",
	"gridRow",
	"gridRowEnd",
	"gridRowSpan",
	"gridRowStart",
	"fontWeight",
	"lineClamp",
	"lineHeight",
	"opacity",
	"order",
	"orphans",
	"scale",
	"tabSize",
	"WebkitLineClamp",
	"widows",
	"zIndex",
	"zoom"
]);
const SVG_ELEMENTS = [
	"svg",
	"animate",
	"animateMotion",
	"animateTransform",
	"circle",
	"clipPath",
	"defs",
	"desc",
	"ellipse",
	"feBlend",
	"feColorMatrix",
	"feComponentTransfer",
	"feComposite",
	"feConvolveMatrix",
	"feDiffuseLighting",
	"feDisplacementMap",
	"feDistantLight",
	"feDropShadow",
	"feFlood",
	"feFuncA",
	"feFuncB",
	"feFuncG",
	"feFuncR",
	"feGaussianBlur",
	"feImage",
	"feMerge",
	"feMergeNode",
	"feMorphology",
	"feOffset",
	"fePointLight",
	"feSpecularLighting",
	"feSpotLight",
	"feTile",
	"feTurbulence",
	"filter",
	"foreignObject",
	"g",
	"image",
	"line",
	"linearGradient",
	"marker",
	"mask",
	"metadata",
	"mpath",
	"path",
	"pattern",
	"polygon",
	"polyline",
	"radialGradient",
	"rect",
	"set",
	"stop",
	"switch",
	"symbol",
	"text",
	"textPath",
	"tspan",
	"use",
	"view"
];
const MATHML_ELEMENTS = [
	"annotation",
	"annotation-xml",
	"maction",
	"math",
	"merror",
	"mfrac",
	"mi",
	"mmultiscripts",
	"mn",
	"mo",
	"mover",
	"mpadded",
	"mphantom",
	"mprescripts",
	"mroot",
	"mrow",
	"ms",
	"mspace",
	"msqrt",
	"mstyle",
	"msub",
	"msubsup",
	"msup",
	"mtable",
	"mtd",
	"mtext",
	"mtr",
	"munder",
	"munderover",
	"semantics"
];
const NON_HTML_HOST_ELEMENTS = /* @__PURE__ */ new Set([...SVG_ELEMENTS, ...MATHML_ELEMENTS]);
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
/**
* A leaf that lets React own reconciliation while its signal dependency stays
* local to the leaf.  A signal resolving to another signal/array is normalized
* again so nested reactive children also work.
*/
function SignalValue({ source }) {
	return normalizeChild(useSignalValue(source));
}
function normalizeChild(value) {
	if (isSignal(value)) return createElement(SignalValue, { source: value });
	if (Array.isArray(value)) return value.map(normalizeChild);
	return value;
}
function isReactiveHostProp(name, value) {
	if (!isSignal(value)) return false;
	return REACTIVE_PROP_NAMES.has(name) || name.startsWith("data-") || name.startsWith("aria-");
}
function readInitialValue(source) {
	return source.peek();
}
/**
* Reads a signal on behalf of one of this module's direct DOM bindings (see
* the module doc: these write straight to the DOM from a subscription mounted
* alongside the element's ref, bypassing React's render, so the owning
* component never re-renders). A `computed()` whose getter throws caches and
* rethrows that error on every read (see `computed()` in src/core/base.ts) —
* if `source` is such a computed and it starts failing after the binding is
* already mounted, an unguarded read here could throw from the subscription's
* update callback while processing the write. The direct V1 watcher contains
* computed dirty-check errors, but this binding read is a separate operation;
* catching it here also keeps the structural-readable effect fallback local.
*
* Catching here keeps a failure local to this one binding: the DOM write for
* this cycle is skipped (the DOM is left at its last successful value) and
* the failure is reported with `console.error(message, { cause: error })` —
* assert against `mock.calls[i][1].cause` in tests, the same shape used by
* `computed()`'s own error report (src/core/base.ts) and by
* `render-tracking.ts`. Reporting is intentional here too: a direct binding
* has no Error Boundary or other surface to fall back on, and silence would
* mean a binding that mysteriously stops updating with zero trace.
*
* Reported at most once per contiguous run of failures ("episode"): `episode`
* latches after the first report and is cleared the moment a read next
* succeeds, so a later, distinct failure episode logs again. This keeps a
* `computed()` that fails on every keystroke from spamming one `console.error`
* per keystroke.
*/
function readBoundSignal(read, episode) {
	try {
		const value = read();
		episode.hasReported = false;
		return {
			ok: true,
			value
		};
	} catch (error) {
		if (!episode.hasReported) {
			episode.hasReported = true;
			console.error("react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value.", { cause: error });
		}
		return { ok: false };
	}
}
/**
* Reads via `readBoundSignal` and, on success, hands the value to `apply`; a
* failed read is already reported by `readBoundSignal`, so this just skips
* the write. Shared by every read-and-apply call site below, including the
* one that isn't itself a subscription callback — the MutationObserver-triggered
* re-apply in `bindSelectValue`, which reads outside the reactive graph via
* `.peek()`.
*/
function applyBoundSignal(read, apply, episode) {
	const result = readBoundSignal(read, episode);
	if (result.ok) apply(result.value);
}
/**
* The common case built on `applyBoundSignal`: subscribe to a readable and
* re-run `apply` whenever it changes. V1 readables use a direct protocol
* subscription; structural readables retain the effect bridge. Centralizes
* the pattern that used to be hand-rolled at each binding site — declare an
* `episode`, then `effect(() => { const read = readBoundSignal(...); if
* (!read.ok) return; <apply the value> })` — so the read-and-skip contract
* can't drift between sites. An `episode` may be passed in to share a
* failure latch with a sibling read site (see `bindSelectValue`); otherwise
* each binding gets its own.
*/
function createBindingSubscription(source, apply, episode = { hasReported: false }) {
	const update = () => applyBoundSignal(() => source.value, apply, episode);
	const unsubscribe = subscribeReadableV1(source, update);
	if (unsubscribe !== void 0) {
		untracked(() => notifyListener(update));
		return unsubscribe;
	}
	return effect(update);
}
function setAttribute(node, name, value) {
	if (value == null) node.removeAttribute(name);
	else node.setAttribute(name, String(value));
}
function setDomProp(node, name, value) {
	if (node.namespaceURI !== HTML_NAMESPACE) {
		setAttribute(node, name === "className" ? "class" : name, value);
		return;
	}
	switch (name) {
		case "title":
			node.title = value == null ? "" : String(value);
			return;
		case "id":
			node.id = value == null ? "" : String(value);
			return;
		case "className":
			node.className = value == null ? "" : String(value);
			return;
		case "hidden":
			if (value === "until-found") setAttribute(node, "hidden", value);
			else node.hidden = Boolean(value);
			return;
		case "disabled":
			if ("disabled" in node) node.disabled = Boolean(value);
			else if (value == null || value === false) node.removeAttribute(name);
			else setAttribute(node, name, value);
			return;
		default: setAttribute(node, name, value);
	}
}
/**
* Writes `value`/`checked` on a controlled-two-way element, skipping the DOM
* write when it already holds the value being written. A binding update
* follows signal writes, including keystrokes written by `onChange`, so without
* this guard every keystroke would re-set a property the DOM already has,
* moving the caret and disrupting IME composition for no reason.
*/
function setControlledProp(node, name, value) {
	if (name === "value") {
		const select = node;
		if (select.tagName === "SELECT" && select.multiple) {
			setMultiSelectValue(select, value);
			return;
		}
		const next = value == null ? "" : String(value);
		const input = node;
		if (input.value !== next) input.value = next;
		return;
	}
	const next = Boolean(value);
	const input = node;
	if (input.checked !== next) input.checked = next;
}
/**
* `<select multiple>` does not support assigning `.value` directly — the DOM
* setter only ever selects a single option, silently corrupting the
* selection instead of erroring. Its documented API for a multi-value select
* is per-`<option>` `.selected`, so an array-valued signal (React's own
* typing for a multi-select) is applied that way instead.
*/
function setMultiSelectValue(select, value) {
	const values = new Set(Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)]);
	for (const option of select.options) {
		const selected = values.has(option.value);
		if (option.selected !== selected) option.selected = selected;
	}
}
/**
* A `<select>` whose matching `<option>` does not exist yet (for example when
* the options themselves are rendered from a signal or other state, mounted
* after this one) silently ends up with nothing selected: the DOM neither
* errors nor retroactively applies `.value`/`.selected` once a matching
* `<option>` is later added. The value subscription below only updates when
* the bound signal itself changes, so it cannot see that the option list changed
* out from under it. A MutationObserver on the select's subtree re-applies
* the signal's current value whenever its `<option>` list changes, closing
* that gap without requiring the signal to change too.
*/
function bindSelectValue(select, source) {
	const episode = { hasReported: false };
	const apply = (value) => setControlledProp(select, "value", value);
	const unsubscribe = createBindingSubscription(source, apply, episode);
	const observer = new MutationObserver(() => {
		applyBoundSignal(() => source.peek(), apply, episode);
	});
	observer.observe(select, {
		childList: true,
		subtree: true
	});
	return () => {
		unsubscribe();
		observer.disconnect();
	};
}
/**
* Forcing a `value` write while an IME composition is in progress can abort
* the composition outright, independent of whether the string being written
* happens to match what was typed — the write-skip guard in
* `setControlledProp` only protects the same-value echo case, not this one.
* `compositionstart`/`compositionend` listeners on the node itself track
* composition state directly, regardless of whether the component declares
* its own composition handlers, and a write requested while composing is
* deferred until composition ends instead of applied immediately.
*/
function bindTextValue(node, source) {
	let composing = false;
	let hasPending = false;
	let pending;
	const episode = { hasReported: false };
	const onCompositionStart = () => {
		composing = true;
	};
	const onCompositionEnd = () => {
		composing = false;
		if (hasPending) {
			hasPending = false;
			setControlledProp(node, "value", pending);
		}
	};
	node.addEventListener("compositionstart", onCompositionStart);
	node.addEventListener("compositionend", onCompositionEnd);
	const unsubscribe = createBindingSubscription(source, (next) => {
		if (composing) {
			hasPending = true;
			pending = next;
			return;
		}
		setControlledProp(node, "value", next);
	}, episode);
	return () => {
		unsubscribe();
		node.removeEventListener("compositionstart", onCompositionStart);
		node.removeEventListener("compositionend", onCompositionEnd);
	};
}
function clearStyleProperty(style, key) {
	if (key.startsWith("--")) style.removeProperty(key);
	else style[key] = "";
}
function setStyleProperty(style, key, value) {
	if (value == null) {
		clearStyleProperty(style, key);
		return;
	}
	if (key.startsWith("--")) {
		style.setProperty(key, String(value));
		return;
	}
	style[key] = typeof value === "number" && !UNITLESS_CSS_PROPERTIES.has(key) ? `${value}px` : String(value);
}
/**
* Applies a whole style object to an element, clearing keys that were present
* in a previous call but are absent from this one. Only the coarse
* `style={signal}` form is bound this way — an object whose individual entries
* are themselves signals is out of scope (see docs/direct-binding-value-checked-style.md).
*/
function applyStyle(node, value, previousKeys) {
	const nextStyle = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	const nextKeys = Object.keys(nextStyle);
	const nextKeySet = new Set(nextKeys);
	for (const key of previousKeys) if (!nextKeySet.has(key)) clearStyleProperty(node.style, key);
	for (const key of nextKeys) setStyleProperty(node.style, key, nextStyle[key]);
	return nextKeys;
}
function applyRef(ref, node) {
	if (typeof ref === "function") return ref(node);
	if (ref != null) ref.current = node;
}
/** A binding's identity for the re-render diff: same name, source, and kind. */
function isSameBinding(a, b) {
	return b !== void 0 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
/**
* Subscribes a single binding to `node` and returns its teardown. Split out of
* the ref callback so `createReactiveHostBinder` can rebuild one binding on
* its own, without disturbing the siblings that did not change.
*
* `initialStyleKeys` seeds a `"style"` binding's own `previousKeys` — passed
* by `syncBindings` when this binding is replacing a disposed style binding,
* so the fresh one starts already knowing which CSS properties are actually
* on the node, instead of starting from an empty set and never clearing them.
* Ignored for every other kind.
*/
function subscribeBinding(node, name, source, kind, initialStyleKeys) {
	switch (kind) {
		case "style": {
			let previousKeys = initialStyleKeys ?? [];
			return {
				dispose: createBindingSubscription(source, (value) => {
					previousKeys = applyStyle(node, value, previousKeys);
				}),
				getStyleKeys: () => previousKeys
			};
		}
		case "select-value": return {
			dispose: bindSelectValue(node, source),
			getStyleKeys: void 0
		};
		case "text-value": return {
			dispose: bindTextValue(node, source),
			getStyleKeys: void 0
		};
		case "checked": return {
			dispose: createBindingSubscription(source, (value) => setControlledProp(node, name, value)),
			getStyleKeys: void 0
		};
		case "prop": return {
			dispose: createBindingSubscription(source, (value) => setDomProp(node, name, value)),
			getStyleKeys: void 0
		};
	}
}
function mountBinding(node, binding, initialStyleKeys) {
	const { dispose, getStyleKeys } = subscribeBinding(node, binding[0], binding[1], binding[2], initialStyleKeys);
	return {
		binding,
		dispose,
		getStyleKeys
	};
}
/**
* Owns everything one mounted `ReactiveHost` attaches to its DOM node: the
* user's own ref, plus one live subscription per binding.
*
* The ref callback is created once per binder, and a binder is created once
* per mounted `ReactiveHost`, so React only ever sees a single ref identity
* for the lifetime of that element. That is load-bearing: React responds to a
* *changed* callback-ref identity by detaching the old ref and attaching the
* new one on the very same, unchanged DOM node. While the ref closure was
* rebuilt on every render — which it was, since `transformProps` hands
* `ReactiveHost` a freshly allocated `bindings` array each time — every
* unrelated re-render of the owning component (any state, context, or parent
* update anywhere above this element) silently disconnected and recreated
* `bindSelectValue`'s `MutationObserver`, removed and re-added
* `bindTextValue`'s composition listeners *along with the closure-local
* `composing`/`pending` state they guard* — resetting `composing` to `false`
* mid-composition and letting the next write stomp in-flight IME input —
* recreated every binding subscription, and called the user's own ref with
* `null` and then the identical node again.
*
* Pinning the identity moves that reconciliation here: `sync` runs from
* `ReactiveHost`'s layout effect after every commit and diffs the render's
* bindings against the mounted ones by `(name, source, kind)`, tearing down
* and rebuilding only the entries that actually changed. What is left in the
* ref callback is exactly the part React's attach/detach protocol has to
* drive: which node is current, and full teardown when there no longer is one.
*
* The split is safe because of how React orders a commit. A host element's ref
* is attached during the layout phase *before* the layout effects of the
* component that rendered it, so `sync` always finds the node already
* attached; and a ref is only ever (re)attached on a fiber React re-rendered,
* which is also the only way `ReactiveHost`'s dependency-less layout effect
* can fail to re-run — so no attach can slip past a `sync`.
*/
function createReactiveHostBinder() {
	let node = null;
	let mounted = [];
	let attachedUserRef;
	let userCleanup;
	let activeCleanup;
	const attachUserRef = (target, userRef) => {
		attachedUserRef = userRef;
		userCleanup = applyRef(userRef, target);
	};
	const detachUserRef = () => {
		const cleanup = userCleanup;
		const detached = attachedUserRef;
		userCleanup = void 0;
		attachedUserRef = void 0;
		if (typeof cleanup === "function") cleanup();
		else applyRef(detached, null);
	};
	const disposeActive = () => {
		const cleanup = activeCleanup;
		activeCleanup = void 0;
		cleanup?.();
	};
	const ref = (target) => {
		disposeActive();
		if (target == null) return;
		node = target;
		let isDisposed = false;
		const cleanup = () => {
			if (isDisposed) return;
			isDisposed = true;
			if (activeCleanup === cleanup) activeCleanup = void 0;
			for (const binding of mounted) binding.dispose();
			mounted = [];
			detachUserRef();
			node = null;
		};
		activeCleanup = cleanup;
		return cleanup;
	};
	const syncBindings = (target, bindings) => {
		if (mounted.length === bindings.length && mounted.every((entry, index) => isSameBinding(entry.binding, bindings[index]))) return;
		const reusable = /* @__PURE__ */ new Map();
		for (const entry of mounted) reusable.set(entry.binding[0], entry);
		const reused = bindings.map((binding) => {
			const candidate = reusable.get(binding[0]);
			if (candidate === void 0 || !isSameBinding(candidate.binding, binding)) return void 0;
			reusable.delete(binding[0]);
			return candidate;
		});
		const staleStyleKeys = /* @__PURE__ */ new Map();
		for (const stale of reusable.values()) if (stale.getStyleKeys !== void 0) staleStyleKeys.set(stale.binding[0], stale.getStyleKeys());
		for (const stale of reusable.values()) stale.dispose();
		mounted = bindings.map((binding, index) => reused[index] ?? mountBinding(target, binding, staleStyleKeys.get(binding[0])));
	};
	return {
		ref,
		sync(bindings, userRef) {
			const target = node;
			if (target == null) return;
			if (userRef !== attachedUserRef) {
				detachUserRef();
				attachUserRef(target, userRef);
			}
			syncBindings(target, bindings);
		}
	};
}
/**
* Hands `ReactiveHost` its one stable ref callback and drives the binder's
* post-commit reconciliation.
*
* The layout effect deliberately declares no dependency array and returns no
* cleanup: it must run after every commit (that is what makes it impossible
* for a ref attach to happen without a following `sync`), and its teardown
* belongs to the ref callback, which React already invokes on unmount, on
* node replacement, and on StrictMode's ref replay. Giving it a cleanup here
* would tear the whole element down again on every re-render — precisely the
* churn this exists to remove.
*/
function useReactiveHostBinder(bindings, userRef) {
	const binderRef = useRef(void 0);
	if (binderRef.current === void 0) binderRef.current = createReactiveHostBinder();
	const binder = binderRef.current;
	useLayoutEffect(() => {
		binder.sync(bindings, userRef);
	});
	return binder.ref;
}
/**
* A host element with DOM-only signal subscriptions attached via its ref.
*
* The subscriptions themselves are owned by a per-instance binder
* (`useReactiveHostBinder`) rather than rebuilt inline here, so this
* component's ref prop keeps one identity for the element's whole lifetime
* and an unrelated re-render costs nothing — see `createReactiveHostBinder`.
*
* `children` arrives as ReactiveHost's own top-level prop (see
* `createJsxWrapper` below) rather than folded into `props`/`hostProps`,
* purely so the *outer* `factory(ReactiveHost, { ..., children }, key)` call
* that constructs this element — the very same real `jsx`/`jsxs`/`jsxDEV`
* that would have validated the original host element's children had this
* wrapper not intercepted it — runs React's dev-mode key validation on it.
* That validation is a flag React stamps onto each child element itself
* (`element._store.validated`), not onto the array or onto whichever
* component currently holds it, so it survives being read back out of props
* here and re-embedded via `createElement` below. Skip this indirection —
* i.e. leave `children` folded into `hostProps` before any real jsx/jsxs call
* ever sees it — and a signal-bound host element with 2+ static, unkeyed JSX
* children spuriously trips React's "missing key" warning: `createElement`'s
* children-as-prop path never validates children (only its children-as-rest-
* args path does), and neither did the `factory(ReactiveHost, ...)` call
* itself, since `children` wasn't its own prop at that call site.
*/
function ReactiveHost({ elementType, props, bindings, children }) {
	const { ref: userRef, ...hostProps } = props;
	const ref = useReactiveHostBinder(bindings, userRef);
	return createElement(elementType, {
		...hostProps,
		children,
		ref
	});
}
/**
* Scans a native host element's props for anything reactive (see
* `isReactiveHostProp`). Kept separate from building the transformed props
* copy in `transformHostProps` so that function can decide whether a copy is
* needed at all before ever allocating one.
*/
function findHostBindings(props, tagName) {
	const bindings = [];
	for (const [name, value] of Object.entries(props)) if (isReactiveHostProp(name, value)) bindings.push([
		name,
		value,
		resolveBindingKind(tagName, name)
	]);
	return bindings;
}
/**
* Transforms a native host element's (`<div>`, `<svg>`, ...) props: replaces
* any directly-bound prop with its initial, non-reactive value (`bindings`
* carries the reactive ones for `ReactiveHost` to mount later — see
* `createJsxWrapper`) and normalizes a signal/array `children` the same way
* `Fragment` does.
*
* The overwhelmingly common host element has neither. Scanning first and only
* allocating a copy when something is actually found means a plain
* `<div className="card">…</div>` costs one prop walk and zero extra
* allocations — the original props object is returned as-is (see the
* `bindings.length === 0 && !childrenNeedNormalization` branch below), and
* `createJsxWrapper` passes it straight to `factory` unchanged.
*/
function transformHostProps(type, input) {
	const inputProps = input ?? {};
	const bindings = !NON_HTML_HOST_ELEMENTS.has(type) ? findHostBindings(inputProps, type) : [];
	const rawChildren = inputProps.children;
	const childrenNeedNormalization = "children" in inputProps && (isSignal(rawChildren) || Array.isArray(rawChildren));
	if (bindings.length === 0 && !childrenNeedNormalization) return {
		props: inputProps,
		bindings
	};
	const props = { ...inputProps };
	if (childrenNeedNormalization) props.children = normalizeChild(rawChildren);
	for (const [name, value, kind] of bindings) {
		const uncontrolledName = isTwoWayBindingKind(kind) ? UNCONTROLLED_PROP_NAMES[name] : void 0;
		if (uncontrolledName !== void 0) {
			delete props[name];
			props[uncontrolledName] = readInitialValue(value);
		} else props[name] = readInitialValue(value);
	}
	return {
		props,
		bindings
	};
}
/**
* `Fragment`'s only prop worth transforming is `children`, and only when it
* is itself a signal or array — `normalizeChild` is the identity for
* anything else (see its definition) — so a plain `<>...</>` with ordinary
* children is passed straight through, uncopied, the same way a custom
* component is below.
*/
function transformFragmentProps(input) {
	const props = input;
	if (props == null || !("children" in props) || !isSignal(props.children) && !Array.isArray(props.children)) return input;
	return {
		...props,
		children: normalizeChild(props.children)
	};
}
/** Creates a JSX wrapper while letting each module supply React's JSX factory. */
function createJsxWrapper(factory) {
	return (type, input, key) => {
		if (typeof type === "string") {
			const { props, bindings } = transformHostProps(type, input);
			if (bindings.length > 0) {
				const { children, ...hostProps } = props;
				return factory(ReactiveHost, {
					elementType: type,
					props: hostProps,
					bindings,
					children
				}, key);
			}
			return factory(type, props, key);
		}
		if (type === Fragment) return factory(type, transformFragmentProps(input), key);
		return factory(type, input, key);
	};
}
//#endregion
export { createJsxWrapper as t };

//# sourceMappingURL=jsx-S8SS1Qgs.js.map