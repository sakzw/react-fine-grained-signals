import { useMemo as e, useRef as t, useSyncExternalStore as n } from "react";
//#region benchmarks/phase9/node_modules/.pnpm/alien-signals@3.2.1/node_modules/alien-signals/esm/system.mjs
var r = {
	None: 0,
	Mutable: 1,
	Watching: 2,
	RecursedCheck: 4,
	Recursed: 8,
	Dirty: 16,
	Pending: 32
};
function i({ update: e, notify: t, unwatched: n }) {
	return {
		link: r,
		unlink: i,
		propagate: a,
		checkDirty: o,
		shallowPropagate: s
	};
	function r(e, t, n) {
		let r = t.depsTail;
		if (r !== void 0 && r.dep === e) return;
		let i = r === void 0 ? t.deps : r.nextDep;
		if (i !== void 0 && i.dep === e) {
			i.version = n, t.depsTail = i;
			return;
		}
		let a = e.subsTail;
		if (a !== void 0 && a.version === n && a.sub === t) return;
		let o = t.depsTail = e.subsTail = {
			version: n,
			dep: e,
			sub: t,
			prevDep: r,
			nextDep: i,
			prevSub: a,
			nextSub: void 0
		};
		i !== void 0 && (i.prevDep = o), r === void 0 ? t.deps = o : r.nextDep = o, a === void 0 ? e.subs = o : a.nextSub = o;
	}
	function i(e, t = e.sub) {
		let { dep: r, prevDep: i, nextDep: a, nextSub: o, prevSub: s } = e;
		return a === void 0 ? t.depsTail = i : a.prevDep = i, i === void 0 ? t.deps = a : i.nextDep = a, o === void 0 ? r.subsTail = s : o.prevSub = s, s === void 0 ? (r.subs = o) === void 0 && n(r) : s.nextSub = o, a;
	}
	function a(e, n) {
		let r = e.nextSub, i;
		top: do {
			let a = e.sub, o = a.flags;
			if (o & 60 ? o & 12 ? o & 4 ? !(o & 48) && c(e, a) ? (a.flags = o | 40, o &= 1) : o = 0 : a.flags = o & -9 | 32 : o = 0 : (a.flags = o | 32, n && (a.flags |= 8)), o & 2 && t(a), o & 1) {
				let t = a.subs;
				if (t !== void 0) {
					let n = (e = t).nextSub;
					n !== void 0 && (i = {
						value: r,
						prev: i
					}, r = n);
					continue;
				}
			}
			if ((e = r) !== void 0) {
				r = e.nextSub;
				continue;
			}
			for (; i !== void 0;) if (e = i.value, i = i.prev, e !== void 0) {
				r = e.nextSub;
				continue top;
			}
			break;
		} while (!0);
	}
	function o(t, n) {
		let r, i = 0, a = !1;
		top: do {
			let o = t.dep, c = o.flags;
			if (n.flags & 16) a = !0;
			else if ((c & 17) == 17) {
				let t = o.subs;
				e(o) && (t.nextSub !== void 0 && s(t), a = !0);
			} else if ((c & 33) == 33) {
				r = {
					value: t,
					prev: r
				}, t = o.deps, n = o, ++i;
				continue;
			}
			if (!a) {
				let e = t.nextDep;
				if (e !== void 0) {
					t = e;
					continue;
				}
			}
			for (; i--;) {
				if (t = r.value, r = r.prev, a) {
					let r = n.subs;
					if (e(n)) {
						r.nextSub !== void 0 && s(r), n = t.sub;
						continue;
					}
					a = !1;
				} else n.flags &= -33;
				n = t.sub;
				let i = t.nextDep;
				if (i !== void 0) {
					t = i;
					continue top;
				}
			}
			return a && !!n.flags;
		} while (!0);
	}
	function s(e) {
		do {
			let n = e.sub, r = n.flags;
			(r & 48) == 32 && (n.flags = r | 16, (r & 6) == 2 && t(n));
		} while ((e = e.nextSub) !== void 0);
	}
	function c(e, t) {
		let n = t.depsTail;
		for (; n !== void 0;) {
			if (n === e) return !0;
			n = n.prevDep;
		}
		return !1;
	}
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-objectis.mjs
var { None: a, Mutable: o, Watching: s, RecursedCheck: c, Recursed: l, Dirty: u, Pending: d } = r, f = 64, p, m = 0, h = 0, g = 0, _ = 0, v = 0, y = [], { link: b, unlink: x, propagate: S, checkDirty: C, shallowPropagate: w } = i({
	update(e) {
		return e.kind === "computed" ? A(e) : e.kind === "source" ? O(e) : (e.flags = o, !0);
	},
	notify(e) {
		let t = v, n = t;
		do
			if (y[t++] = e, e.flags &= ~s, e = e.subs?.sub, e === void 0 || !(e.flags & s)) break;
		while (!0);
		v = t;
		let r = n;
		for (; r < --t;) {
			let e = y[r];
			y[r++] = y[t], y[t] = e;
		}
	},
	unwatched(e) {
		e.kind === "computed" ? e.depsTail !== void 0 && (e.flags = o | u, F(e)) : e.kind === "effect" && ne(e);
	}
}), T = /* @__PURE__ */ new WeakMap();
function E(e, t, n = {}) {
	return {
		kind: e,
		flags: t,
		deps: void 0,
		depsTail: void 0,
		subs: void 0,
		subsTail: void 0,
		...n
	};
}
function D(e) {
	return e.flags & u && O(e) && e.subs !== void 0 && w(e.subs), p !== void 0 && b(e, p, m), e.currentValue;
}
function O(e) {
	return e.flags = o, !Object.is(e.currentValue, e.currentValue = e.pendingValue);
}
function k(e) {
	let t = e.flags;
	if (t & u || t & d && (C(e.deps, e) || (e.flags = t & ~d, !1))) A(e) && e.subs !== void 0 && w(e.subs);
	else if (!t) {
		e.flags = o | c;
		let t = p;
		p = e;
		try {
			e.value = e.getter();
		} finally {
			p = t, e.flags &= ~c;
		}
	}
	return p !== void 0 && b(e, p, m), e.value;
}
function A(e) {
	e.flags & f && P(e), e.depsTail = void 0, e.flags = o | c;
	let t = p;
	p = e;
	try {
		m += 1;
		let t = e.value;
		return e.value = e.getter(t), !Object.is(t, e.value);
	} finally {
		p = t, e.flags &= ~c, ee(e);
	}
}
function j(e, t) {
	Object.is(e.pendingValue, e.pendingValue = t) || (e.flags = o | u, e.subs !== void 0 && (S(e.subs, !!h), g || N()));
}
function M(e) {
	let t = e.flags;
	if (t & u || t & d && C(e.deps, e)) {
		if (t & f && P(e), e.cleanup !== void 0 && (te(e), !e.flags)) return;
		e.depsTail = void 0, e.flags = s | c;
		let n = p;
		p = e;
		try {
			m += 1, h += 1, e.cleanup = e.fn();
		} finally {
			--h, p = n, e.flags &= ~c, ee(e);
		}
	} else e.deps !== void 0 && (e.flags = s | t & f);
}
function N() {
	try {
		for (; _ < v;) {
			let e = y[_];
			y[_++] = void 0, M(e);
		}
	} finally {
		for (; _ < v;) {
			let e = y[_];
			y[_++] = void 0, e.flags |= s | l;
		}
		_ = 0, v = 0;
	}
}
function P(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		t.dep.kind === "effect" && x(t, e), t = n;
	}
}
function F(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		x(t, e), t = n;
	}
}
function ee(e) {
	let t = e.depsTail, n = t === void 0 ? e.deps : t.nextDep;
	for (; n !== void 0;) n = x(n, e);
}
function te(e) {
	let t = e.cleanup;
	e.cleanup = void 0;
	let n = p;
	p = void 0;
	try {
		t();
	} finally {
		p = n;
	}
}
function ne(e) {
	e.flags = a, F(e), e.cleanup !== void 0 && te(e);
}
function re(e) {
	let t = E("source", o, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			return D(t);
		},
		set value(e) {
			j(t, e);
		},
		peek() {
			return U(() => D(t));
		}
	};
}
function ie(e) {
	let t = E("source", o, {
		currentValue: e,
		pendingValue: e
	});
	function n(...e) {
		if (e.length) {
			if (!Object.is(this.pendingValue, this.pendingValue = e[0])) {
				this.flags = o | u;
				let e = this.subs;
				e !== void 0 && (S(e, !!h), g || N());
			}
		} else return this.flags & u && O(this) && this.subs !== void 0 && w(this.subs), p !== void 0 && b(this, p, m), this.currentValue;
	}
	let r = n.bind(t), i = { peek() {
		return U(() => r());
	} };
	return Object.defineProperty(i, "value", {
		get: r,
		set: r,
		enumerable: !0
	}), i;
}
function ae(e) {
	let t = E("source", o, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			if (t.flags & u && (t.flags = o, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
				let e = t.subs;
				e !== void 0 && w(e);
			}
			return p !== void 0 && b(t, p, m), t.currentValue;
		},
		set value(e) {
			if (!Object.is(t.pendingValue, t.pendingValue = e)) {
				t.flags = o | u;
				let e = t.subs;
				e !== void 0 && (S(e, !!h), g || N());
			}
		},
		peek() {
			return U(() => {
				if (t.flags & u && (t.flags = o, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
					let e = t.subs;
					e !== void 0 && w(e);
				}
				return p !== void 0 && b(t, p, m), t.currentValue;
			});
		}
	};
}
var oe = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		return D(this.#e);
	}
	set value(e) {
		j(this.#e, e);
	}
	peek() {
		return U(() => D(this.#e));
	}
}, se = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		let e = this.#e;
		if (e.flags & u && (e.flags = o, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
			let t = e.subs;
			t !== void 0 && w(t);
		}
		return p !== void 0 && b(e, p, m), e.currentValue;
	}
	set value(e) {
		let t = this.#e;
		if (!Object.is(t.pendingValue, t.pendingValue = e)) {
			t.flags = o | u;
			let e = t.subs;
			e !== void 0 && (S(e, !!h), g || N());
		}
	}
	peek() {
		return U(() => this.value);
	}
};
function I(e) {
	let t = E("source", o, {
		currentValue: e,
		pendingValue: e
	}), n = new oe(t);
	return T.set(n, t), n;
}
function ce(e) {
	let t = E("source", o, {
		currentValue: e,
		pendingValue: e
	}), n = new se(t);
	return T.set(n, t), n;
}
function L(e) {
	return T.get(e)?.subs !== void 0;
}
function R() {
	return p !== void 0;
}
function z() {
	return g;
}
function B() {}
function V(e) {
	return T.has(e);
}
function le(e) {
	let t = E("computed", a, {
		getter: e,
		value: void 0
	});
	return Object.freeze({
		get value() {
			return k(t);
		},
		peek() {
			return U(() => k(t));
		}
	});
}
function ue(e) {
	let t = E("effect", s | c, {
		fn: e,
		cleanup: void 0
	}), n = p;
	n !== void 0 && (b(t, n, 0), n.flags |= f);
	try {
		p = t, h += 1, t.cleanup = e();
	} finally {
		--h, p = n, t.flags &= ~c;
	}
	return () => ne(t);
}
function H(e) {
	g += 1;
	try {
		return e();
	} finally {
		--g, g || N();
	}
}
function U(e) {
	let t = p;
	p = void 0;
	try {
		return e();
	} finally {
		p = t;
	}
}
//#endregion
//#region src/core/interop.ts
var W = Symbol.for("react-fine-grained-signals.readable-interop.v1"), G = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), K;
function q() {
	if (K !== void 0) return K;
	let e = globalThis, t = e[G];
	if (t !== void 0) {
		if (t.version !== 1 || typeof t.speculativeDepth != "number") throw Error("Incompatible react-fine-grained-signals interop context");
		return K = t, t;
	}
	let n = {
		version: 1,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	};
	return Object.defineProperty(e, G, {
		value: n,
		enumerable: !1,
		configurable: !1,
		writable: !1
	}), K = n, n;
}
function de(e) {
	let t = e[W];
	if (t === void 0 || typeof t != "object" || !t) return;
	let n = t;
	return n.version === 1 && typeof n.getRevision == "function" && typeof n.subscribe == "function" && typeof n.runtimeToken == "object" && n.runtimeToken !== null ? n : void 0;
}
function fe(e, t) {
	Object.defineProperty(e, W, {
		value: t,
		enumerable: !1,
		configurable: !1,
		writable: !1
	});
}
function pe() {
	return q().speculativeDepth > 0;
}
function me() {
	let e = q();
	e.speculativeDeepReadEpoch = (e.speculativeDeepReadEpoch ?? 0) + 1;
}
function he() {
	return !1;
}
//#endregion
//#region src/core/signal-brand.ts
var ge = Symbol.for("react-fine-grained-signals.signal");
//#endregion
//#region src/core/deep-signal-engine.ts
function J(e) {
	return typeof e == "object" && !!e || typeof e == "function";
}
function _e(e) {
	if (!Object.isExtensible(e)) throw TypeError("deepSignal() cannot proxy a non-extensible object or array");
}
function Y(e) {
	for (let t of Reflect.ownKeys(e)) {
		let n = Reflect.getOwnPropertyDescriptor(e, t);
		if (n !== void 0 && !("value" in n)) throw TypeError("deepSignal() does not support accessor properties");
	}
}
function ve(e) {
	let t = [];
	return t.length = e, t;
}
function X(e) {
	if (typeof e != "string" || e === "") return !1;
	let t = Number(e);
	return Number.isInteger(t) && t >= 0 && t < 4294967295 && String(t) === e;
}
var Z = (e, t) => {
	let n = e.get(t);
	n !== void 0 && (n.value += 1);
}, Q = (e, t) => {
	!e.properties.has(t) && !e.existence.has(t) || (e.prunable ??= /* @__PURE__ */ new Set()).add(t);
}, $ = (e) => {
	e.iteration !== void 0 && (e.iteration.value += 1);
};
function ye(e) {
	let t = /* @__PURE__ */ new Set([
		"copyWithin",
		"fill",
		"pop",
		"push",
		"reverse",
		"shift",
		"sort",
		"splice",
		"unshift"
	]), n = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap(), i = /* @__PURE__ */ new WeakMap(), a = /* @__PURE__ */ new WeakMap(), o = /* @__PURE__ */ new WeakMap(), s = /* @__PURE__ */ new WeakMap();
	function c() {
		if (pe()) return me(), !1;
		let t = q();
		return e.hasActiveSubscriber() || he() || t.graphCollector !== void 0 || t.renderCollector !== void 0;
	}
	let l = (() => {
		let e = /* @__PURE__ */ new Set();
		for (let t of /* @__PURE__ */ "Object.Array.Function.Boolean.Number.String.Symbol.BigInt.Date.RegExp.Error.AggregateError.EvalError.RangeError.ReferenceError.SyntaxError.TypeError.URIError.Map.Set.WeakMap.WeakSet.WeakRef.FinalizationRegistry.Promise.ArrayBuffer.SharedArrayBuffer.DataView".split(".")) {
			let n = globalThis[t];
			if (typeof n != "function") continue;
			let r = n.prototype;
			(typeof r == "object" && r || typeof r == "function") && e.add(r);
		}
		return e;
	})(), u = (e) => J(e) && l.has(e);
	function d(t) {
		if (typeof t != "object" || !t || e.isSignal(t) || l.has(t)) return !1;
		if (Array.isArray(t)) return !0;
		let n = Object.getPrototypeOf(t);
		return n === Object.prototype || n === null;
	}
	function f(e) {
		if (!J(e)) return;
		let t = n.get(e);
		return t === void 0 ? o.get(e) : t;
	}
	function p(e, t, n, r, i, a) {
		let s = t.get(e);
		if (s !== void 0) return s;
		let c = Object.create(n), l = (e) => () => {
			throw TypeError(`deepSignal() ${r}#${e}() is not allowed through .value; replace the ${r} immutably`);
		};
		Object.defineProperties(c, i(e, c, l));
		for (let [t, n] of a(e, l)) Object.defineProperty(c, t, {
			enumerable: !1,
			configurable: !1,
			value: n
		});
		return t.set(e, c), o.set(c, e), c;
	}
	function m(e) {
		return p(e, i, Map.prototype, "Map", (e, t, n) => ({
			size: {
				enumerable: !1,
				configurable: !1,
				get: () => e.size
			},
			get: {
				enumerable: !1,
				configurable: !1,
				value: (t) => e.get(t)
			},
			has: {
				enumerable: !1,
				configurable: !1,
				value: (t) => e.has(t)
			},
			entries: {
				enumerable: !1,
				configurable: !1,
				value: () => Map.prototype.entries.call(e)
			},
			keys: {
				enumerable: !1,
				configurable: !1,
				value: () => Map.prototype.keys.call(e)
			},
			values: {
				enumerable: !1,
				configurable: !1,
				value: () => Map.prototype.values.call(e)
			},
			forEach: {
				enumerable: !1,
				configurable: !1,
				value: (n, r) => {
					Map.prototype.forEach.call(e, (e, i) => n.call(r, e, i, t));
				}
			},
			[Symbol.iterator]: {
				enumerable: !1,
				configurable: !1,
				value: () => Map.prototype.entries.call(e)
			},
			set: {
				enumerable: !1,
				configurable: !1,
				value: n("set")
			},
			delete: {
				enumerable: !1,
				configurable: !1,
				value: n("delete")
			},
			clear: {
				enumerable: !1,
				configurable: !1,
				value: n("clear")
			}
		}), (e, t) => {
			let n = [];
			for (let e of [
				"getOrInsert",
				"getOrInsertComputed",
				"emplace"
			]) typeof Map.prototype[e] == "function" && n.push([e, t(e)]);
			return n;
		});
	}
	function h(e) {
		return p(e, a, Set.prototype, "Set", (e, t, n) => ({
			size: {
				enumerable: !1,
				configurable: !1,
				get: () => e.size
			},
			has: {
				enumerable: !1,
				configurable: !1,
				value: (t) => e.has(t)
			},
			entries: {
				enumerable: !1,
				configurable: !1,
				value: () => Set.prototype.entries.call(e)
			},
			keys: {
				enumerable: !1,
				configurable: !1,
				value: () => Set.prototype.keys.call(e)
			},
			values: {
				enumerable: !1,
				configurable: !1,
				value: () => Set.prototype.values.call(e)
			},
			forEach: {
				enumerable: !1,
				configurable: !1,
				value: (n, r) => {
					Set.prototype.forEach.call(e, (e) => n.call(r, e, e, t));
				}
			},
			[Symbol.iterator]: {
				enumerable: !1,
				configurable: !1,
				value: () => Set.prototype.values.call(e)
			},
			add: {
				enumerable: !1,
				configurable: !1,
				value: n("add")
			},
			delete: {
				enumerable: !1,
				configurable: !1,
				value: n("delete")
			},
			clear: {
				enumerable: !1,
				configurable: !1,
				value: n("clear")
			}
		}), (e) => {
			let t = [], n = (t) => (n) => {
				let r = Set.prototype[t];
				if (typeof r != "function") throw TypeError(`Set#${t}() is unavailable in this JavaScript engine`);
				let i = J(n) ? o.get(n) ?? n : n;
				return Reflect.apply(r, e, [i]);
			};
			for (let e of [
				"union",
				"intersection",
				"difference",
				"symmetricDifference",
				"isSubsetOf",
				"isSupersetOf",
				"isDisjointFrom"
			]) typeof Set.prototype[e] == "function" && t.push([e, n(e)]);
			return t;
		});
	}
	function g(e) {
		if (!d(e)) throw TypeError("deepSignal() only accepts a plain object or array root");
	}
	function _(e) {
		if (!J(e)) return !1;
		let t = /* @__PURE__ */ new WeakMap(), r = [{
			value: e,
			insideOpaque: !1
		}], i = !1;
		for (; r.length > 0;) {
			let { value: e, insideOpaque: a } = r.pop();
			if (f(e) !== void 0) {
				if (a) throw TypeError(n.has(e) ? "deepSignal() cannot store a deep proxy inside an opaque value" : "deepSignal() cannot store a deep collection view inside an opaque value");
				i = !0;
				continue;
			}
			let o = e, s = t.get(o) ?? 0, c = a ? 2 : 1;
			if ((s & c) === 0) {
				if (t.set(o, s | c), !a && u(o)) throw TypeError("deepSignal() cannot store a built-in prototype object in deep state");
				if (o instanceof Map) {
					for (let [e, t] of o) J(e) && r.push({
						value: e,
						insideOpaque: !0
					}), J(t) && r.push({
						value: t,
						insideOpaque: !0
					});
					continue;
				}
				if (o instanceof Set) {
					for (let e of o) J(e) && r.push({
						value: e,
						insideOpaque: !0
					});
					continue;
				}
				if (!d(o)) {
					for (let e of Reflect.ownKeys(o)) {
						let t = Reflect.getOwnPropertyDescriptor(o, e);
						t !== void 0 && "value" in t && J(t.value) && r.push({
							value: t.value,
							insideOpaque: !0
						});
					}
					continue;
				}
				a || (_e(o), Y(o));
				for (let e of Reflect.ownKeys(o)) {
					let t = Reflect.getOwnPropertyDescriptor(o, e);
					if (t !== void 0 && "value" in t) {
						let e = t.value;
						J(e) && r.push({
							value: e,
							insideOpaque: a
						});
					}
				}
			}
		}
		return i;
	}
	function v(e, t) {
		let n = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap(), i = [[e, t]];
		for (; i.length > 0;) {
			let [e, t] = i.pop();
			if (typeof e != "object" || !e) {
				if (!Object.is(e, t)) return !1;
				continue;
			}
			let a = f(e);
			if (a !== void 0) {
				if (a !== t) return !1;
				continue;
			}
			if (!d(e)) {
				if (e !== t) return !1;
				continue;
			}
			if (typeof t != "object" || !t || !d(t)) return !1;
			let o = n.get(e);
			if (o !== void 0) {
				if (o !== t) return !1;
				continue;
			}
			let s = r.get(t);
			if (s !== void 0 && s !== e || (n.set(e, t), r.set(t, e), Array.isArray(e) !== Array.isArray(t) || Object.getPrototypeOf(e) !== Object.getPrototypeOf(t))) return !1;
			let c = Reflect.ownKeys(e), l = Reflect.ownKeys(t);
			if (c.length !== l.length) return !1;
			for (let [n, r] of c.entries()) {
				if (r !== l[n]) return !1;
				let a = Reflect.getOwnPropertyDescriptor(e, r), o = Reflect.getOwnPropertyDescriptor(t, r);
				if (a === void 0 || o === void 0 || !("value" in a) || !("value" in o) || a.configurable !== o.configurable || a.enumerable !== o.enumerable || a.writable !== o.writable) return !1;
				i.push([a.value, o.value]);
			}
		}
		return !0;
	}
	function y(e) {
		let t = f(e);
		if (t !== void 0) return t;
		if (!J(e)) return e;
		let n = s.get(e);
		if (n !== void 0 && v(e, n)) return n;
		let r = /* @__PURE__ */ new WeakMap(), i = [], a = [], o = (e) => {
			let t = f(e);
			if (t !== void 0) return t;
			if (!d(e)) return e;
			let n = r.get(e);
			if (n !== void 0) return n;
			let o = Array.isArray(e) ? ve(e.length) : Object.create(Object.getPrototypeOf(e));
			return r.set(e, o), i.push([e, o]), a.push(e), o;
		}, c = o(e);
		for (; a.length > 0;) {
			let e = a.pop(), t = r.get(e);
			for (let n of Reflect.ownKeys(e)) {
				if (Array.isArray(e) && n === "length") continue;
				let r = Reflect.getOwnPropertyDescriptor(e, n);
				if (r !== void 0) {
					if (!("value" in r)) throw TypeError("deepSignal() does not support accessor properties");
					r.value = o(r.value), Reflect.defineProperty(t, n, r);
				}
			}
		}
		for (let [e, t] of i) s.set(e, t);
		return c;
	}
	function b(e) {
		let t = f(e);
		return t === void 0 ? _(e) ? y(e) : e : t;
	}
	let x = (e) => b(e), S = new Set(Reflect.ownKeys(Object.prototype)), C = /* @__PURE__ */ new Set([...Reflect.ownKeys(Object.prototype), ...Reflect.ownKeys(Array.prototype)]), w = (e, t) => {
		if (Object.prototype.hasOwnProperty.call(e, t)) return !1;
		let n = Object.getPrototypeOf(e);
		return n === Object.prototype ? S.has(t) : n === Array.prototype && C.has(t);
	}, T = (t, n) => {
		let r = t.get(n);
		return r === void 0 && (r = e.createSignal(0), t.set(n, r)), r;
	}, E = (t, n, r, i) => {
		if (!c() || w(t, i)) return;
		X(i) && r.add(Number(i));
		let a = T(n, i);
		e.markWatched(a), a.value;
	}, D = (t, n) => {
		let r = t.prunable;
		if (r !== void 0 && r.size !== 0 && e.getBatchDepth() === 0) {
			for (let i of r) {
				if (Object.prototype.hasOwnProperty.call(n, i)) {
					r.delete(i);
					continue;
				}
				let a = t.properties.get(i), o = t.existence.get(i);
				if (!(a !== void 0 && e.hasSubscribers(a) || o !== void 0 && e.hasSubscribers(o))) {
					if (t.properties.delete(i), t.existence.delete(i), X(i)) {
						let e = Number(i);
						t.propertyIndices.delete(e), t.existenceIndices.delete(e);
					}
					r.delete(i);
				}
			}
			r.size === 0 && (t.prunable = void 0);
		}
	}, O = (t) => {
		c() && (t.iteration ??= e.createSignal(0), t.iteration.value);
	}, k = (e, t, n) => {
		let r = n - t, i = e.propertyIndices.size + e.existenceIndices.size;
		if (i !== 0) {
			if (r <= i) {
				for (let r = t; r < n; r++) {
					let t = String(r);
					Z(e.properties, t), Z(e.existence, t), Q(e, t);
				}
				return;
			}
			for (let r of e.propertyIndices) if (r >= t && r < n) {
				let t = String(r);
				Z(e.properties, t), Q(e, t);
			}
			for (let r of e.existenceIndices) if (r >= t && r < n) {
				let t = String(r);
				Z(e.existence, t), Q(e, t);
			}
		}
	}, A = (e) => d(e) || e instanceof Map || e instanceof Set, j = (i) => {
		let a = f(i) ?? i;
		if (a instanceof Map) return m(a);
		if (a instanceof Set) return h(a);
		if (!d(a)) return a;
		_e(a);
		let o = r.get(a);
		if (o !== void 0) return o.proxy;
		Y(a);
		let s = {
			properties: /* @__PURE__ */ new Map(),
			existence: /* @__PURE__ */ new Map(),
			propertyIndices: /* @__PURE__ */ new Set(),
			existenceIndices: /* @__PURE__ */ new Set(),
			arrayMethods: /* @__PURE__ */ new Map(),
			proxy: void 0
		}, c = new Proxy(a, {
			get(n, r, i) {
				if (r === ge && !Object.prototype.hasOwnProperty.call(n, r)) return;
				E(n, s.properties, s.propertyIndices, r);
				let a = Reflect.get(n, r, i);
				if (Array.isArray(n) && t.has(r) && typeof a == "function") {
					let t = s.arrayMethods.get(r);
					if (t?.method === a) return t.wrapper;
					let i = a, o = function(...t) {
						try {
							return e.batch(() => Reflect.apply(i, this, t));
						} finally {
							D(s, n);
						}
					};
					return s.arrayMethods.set(r, {
						method: i,
						wrapper: o
					}), o;
				}
				if (A(a)) {
					let e = Reflect.getOwnPropertyDescriptor(n, r);
					if (e !== void 0 && "value" in e && e.configurable === !1 && e.writable === !1) throw TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
				}
				return j(a);
			},
			set(t, n, r) {
				if (n === "__proto__") throw TypeError("deepSignal() does not support prototype mutation");
				if (n === ge) throw TypeError("deepSignal() does not support branding state as a signal");
				let i = Reflect.get(t, n, t), a = Reflect.has(t, n), o = Object.prototype.hasOwnProperty.call(t, n), c = Array.isArray(t) ? t.length : void 0, l = x(r);
				if (!Reflect.set(t, n, l, t)) return !1;
				let u = Reflect.get(t, n, t), d = Reflect.has(t, n), f = Object.prototype.hasOwnProperty.call(t, n);
				return e.batch(() => {
					if ((!Object.is(i, u) || o !== f) && Z(s.properties, n), a !== d && Z(s.existence, n), o !== f && $(s), Array.isArray(t) && c !== void 0) {
						let e = t.length;
						n !== "length" && c !== e && Z(s.properties, "length"), n === "length" && e < c && (k(s, e, c), $(s));
					}
				}), D(s, t), !0;
			},
			deleteProperty(t, n) {
				let r = Reflect.has(t, n), i = Object.prototype.hasOwnProperty.call(t, n), a = Reflect.deleteProperty(t, n);
				return !a || !i ? a : (e.batch(() => {
					Z(s.properties, n), r !== Reflect.has(t, n) && Z(s.existence, n), $(s), Q(s, n);
				}), D(s, t), !0);
			},
			getOwnPropertyDescriptor(e, t) {
				E(e, s.properties, s.propertyIndices, t);
				let n = Reflect.getOwnPropertyDescriptor(e, t);
				return n === void 0 || !("value" in n) || n.configurable === !1 && n.writable === !1 || (n.value = j(n.value)), n;
			},
			has(e, t) {
				return E(e, s.existence, s.existenceIndices, t), Reflect.has(e, t);
			},
			ownKeys(e) {
				return O(s), Reflect.ownKeys(e);
			},
			defineProperty() {
				throw TypeError("deepSignal() does not support property descriptors");
			},
			preventExtensions() {
				throw TypeError("deepSignal() state must remain extensible");
			},
			setPrototypeOf() {
				throw TypeError("deepSignal() does not support prototype mutation");
			}
		});
		return s.proxy = c, r.set(a, s), n.set(c, a), c;
	};
	class M {
		#e;
		constructor(e) {
			this.#e = e;
			let t = de(this.#e);
			t !== void 0 && fe(this, t);
		}
		get value() {
			return j(this.#e.value);
		}
		set value(e) {
			let t = x(e);
			g(t), this.#e.value = t;
		}
		peek() {
			return this.#e.peek();
		}
	}
	function N(e) {
		let t = r.get(f(e) ?? e);
		if (t !== void 0) return {
			properties: [...t.properties.keys()],
			existence: [...t.existence.keys()],
			propertyIndices: [...t.propertyIndices],
			existenceIndices: [...t.existenceIndices]
		};
	}
	function P(t) {
		let n = b(t);
		g(n), j(n);
		let r = e.createSignal(n), i = new M(r);
		return e.registerDeepSignal?.(i), i;
	}
	return {
		deepSignal: P,
		inspectDeepSignalMetadata: N
	};
}
var be = ye({
	createSignal: I,
	markWatched: B,
	hasSubscribers: L,
	batch: H,
	isSignal: V,
	hasActiveSubscriber: R,
	getBatchDepth: z,
	registerDeepSignal(e) {
		Object.defineProperty(e, Symbol.for("react-fine-grained-signals.signal"), {
			value: 1,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
}).deepSignal;
//#endregion
//#region benchmarks/phase9/m15/deep-selector-react-hook.mjs
function xe(t) {
	return function(r) {
		let i = e(() => (e) => {
			let n = !0;
			return t.effect(() => {
				r.value, n ? n = !1 : e();
			});
		}, [r]), a = e(() => () => r.value, [r]);
		return n(i, a, a);
	};
}
function Se(r) {
	return function(i, a, o = []) {
		let s = t(o.length);
		if (o.length !== s.current) throw Error("selector dependencies length changed");
		let c = e(() => {
			let e = () => {
				try {
					let e = a(i.value);
					if (typeof e == "object" && e || typeof e == "function") throw TypeError("selector must return a primitive snapshot");
					return {
						kind: "value",
						value: e
					};
				} catch (e) {
					return {
						kind: "error",
						error: e
					};
				}
			}, t = r.untracked(e), n = (e) => t.kind !== e.kind || t.kind === "value" && e.kind === "value" && !Object.is(t.value, e.value) || t.kind === "error" && e.kind === "error" && !Object.is(t.error, e.error);
			return {
				getSnapshot() {
					if (t.kind === "error") throw t.error;
					return t.value;
				},
				subscribe(i) {
					let a = !0;
					return r.effect(() => {
						let r = e(), o = n(r);
						t = r, a ? a = !1 : o && i();
					});
				}
			};
		}, [i, ...o]);
		return n(c.subscribe, c.getSnapshot, c.getSnapshot);
	};
}
//#endregion
export { H as batch, le as computed, Se as createDeepSelectorHook, xe as createSignalValueHook, be as deepSignal, ue as effect, z as getBatchDepth, R as hasActiveSubscriber, L as hasSubscribers, V as isSignalRuntimeReadable, B as markDeepSignalWatched, re as signal, ie as signalBoundAccessor, I as signalClassHelper, ce as signalClassInline, ae as signalInlineAccessor, U as untracked };
