import { i as isSignal } from "./base-ZLzD296G.js";
import { t as useManagedSignals } from "./use-signals-BZEsQWNr.js";
import { Children, Fragment, isValidElement } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/utils.tsx
/**
* A small reactive conditional-rendering boundary.
*
* Unlike Solid's compiler-aware control flow, this is a normal React component:
* only this component rerenders when a signal read from `when` changes.
*/
function Show({ when, fallback = null, children }) {
	const store = useManagedSignals();
	try {
		const value = readSignalInput(when);
		if (!value) return fallback;
		return typeof children === "function" ? children(value) : children;
	} finally {
		store.finish();
	}
}
/**
* Declares a `Switch` branch. `Match` only has meaning as a child of `Switch`.
*/
function Match(_props) {
	return null;
}
/**
* A small reactive multi-branch boundary inspired by Solid's `Switch`/`Match`.
*/
function Switch({ fallback = null, children }) {
	const store = useManagedSignals();
	try {
		for (const match of collectMatches(children)) {
			const value = readSignalInput(match.props.when);
			if (!value) continue;
			const branch = match.props.children;
			return typeof branch === "function" ? branch(value) : branch;
		}
		return fallback;
	} finally {
		store.finish();
	}
}
function For({ each, fallback = null, by, children }) {
	const store = useManagedSignals();
	try {
		const collection = readSignalInput(each);
		if (collection === null || collection === void 0) return fallback;
		const items = Array.isArray(collection) ? collection : Array.from(collection);
		if (items.length === 0) return fallback;
		return items.map((item, index) => /* @__PURE__ */ jsx(Fragment, { children: children(item, index) }, by(item, index)));
	} finally {
		store.finish();
	}
}
/**
* A position-keyed React list boundary inspired by Solid's `Index`.
*
* The accessor should be read during render. For identity-keyed lists, use
* `For` instead and provide `by`.
*/
function Index({ each, fallback = null, children }) {
	const store = useManagedSignals();
	try {
		const items = readSignalInput(each);
		if (items === null || items === void 0 || items.length === 0) return fallback;
		const readAt = (index) => (readSignalInput(each) ?? items)[index];
		return items.map((_item, index) => /* @__PURE__ */ jsx(Fragment, { children: children(() => readAt(index), index) }, index));
	} finally {
		store.finish();
	}
}
function readSignalInput(value) {
	return isSignal(value) ? value.value : value;
}
function collectMatches(children) {
	const matches = [];
	Children.forEach(children, (child) => {
		if (!isValidElement(child)) return;
		if (child.type === Fragment) {
			const fragment = child;
			matches.push(...collectMatches(fragment.props.children));
		} else if (child.type === Match) matches.push(child);
	});
	return matches;
}
//#endregion
export { For, Index, Match, Show, Switch };

//# sourceMappingURL=utils.js.map