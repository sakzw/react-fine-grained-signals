import { useEffect as e, useLayoutEffect as t, useMemo as n, useRef as r, useSyncExternalStore as i } from "react";
//#region benchmarks/phase9/node_modules/.pnpm/alien-signals@3.2.1/node_modules/alien-signals/esm/system.mjs
var a = {
	None: 0,
	Mutable: 1,
	Watching: 2,
	RecursedCheck: 4,
	Recursed: 8,
	Dirty: 16,
	Pending: 32
};
function o({ update: e, notify: t, unwatched: n }) {
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
//#region benchmarks/phase9/m15/render-context.mjs
var s, c;
function l() {
	return {
		dependencies: /* @__PURE__ */ new Map(),
		add(e, t) {
			this.dependencies.has(e) || this.dependencies.set(e, t);
		}
	};
}
function u(e) {
	let t = c;
	return c = e, s = e, t;
}
function d(e) {
	let t = s, n = c;
	return s = e, c = e, () => {
		s = t, c = n;
	};
}
function f() {
	return s;
}
function ee() {
	return c;
}
function p(e, t) {
	c?.add(e, t);
}
function te(e, t) {
	let n = c;
	c = e;
	try {
		return t();
	} finally {
		c = n;
	}
}
function ne(e) {
	let t = c;
	c = void 0;
	try {
		return e();
	} finally {
		c = t;
	}
}
function m(e) {
	let t = s, n = c;
	s = void 0, c = void 0;
	try {
		return e();
	} finally {
		s = t, c = n;
	}
}
function re(e, t) {
	let n = s, r = c;
	s = e, c = e;
	try {
		return t();
	} finally {
		s = n, c = r;
	}
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-interop-context.mjs
var ie = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), h = Symbol.for("react-fine-grained-signals.readable-interop.v1");
function g() {
	let e = globalThis, t = e[ie];
	if (t === void 0 && (t = {
		version: 1,
		graphCollector: void 0,
		renderCollector: void 0,
		renderScope: void 0,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	}, Object.defineProperty(e, ie, {
		value: t,
		enumerable: !1,
		configurable: !1,
		writable: !1
	})), t.version !== 1) throw Error("Incompatible shared interop context");
	return t;
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-render.mjs
var { None: _, Mutable: v, Watching: y, RecursedCheck: b, Recursed: x, Dirty: S, Pending: C } = a, w = 64, T = {}, E = g(), D, O = 0, k = 0, A = 0, j = 0, M = 0, N = [], ae = /* @__PURE__ */ new WeakMap(), oe = /* @__PURE__ */ new WeakMap(), se = /* @__PURE__ */ new WeakMap(), ce = /* @__PURE__ */ new WeakSet(), { link: P, unlink: le, propagate: F, checkDirty: ue, shallowPropagate: I } = o({
	update(e) {
		if (e.kind === "external") {
			let t = e.revision !== e.pendingRevision;
			return e.revision = e.pendingRevision, e.flags = v, t;
		}
		return e.kind === "computed" ? _e(e) : e.kind === "source" ? ge(e) : (e.flags = v, !0);
	},
	notify(e) {
		let t = M, n = t;
		do
			if (N[t++] = e, e.flags &= ~y, e = e.subs?.sub, e === void 0 || !(e.flags & y)) break;
		while (!0);
		M = t;
		let r = n;
		for (; r < --t;) {
			let e = N[r];
			N[r++] = N[t], N[t] = e;
		}
	},
	unwatched(e) {
		if (e.kind === "external") {
			e.subscription?.unsubscribe(), e.subscription = void 0;
			return;
		}
		e.kind === "computed" ? e.depsTail !== void 0 && (e.flags = v | S, xe(e)) : e.kind === "effect" && we(e);
	}
}), de = {
	runtimeToken: T,
	add(e, t) {
		if (e.runtimeToken === T || D === void 0) return;
		let n = oe.get(e);
		if (n === void 0 && (n = z("external", v, {
			protocol: e,
			revision: t,
			pendingRevision: t,
			subscription: void 0
		}), oe.set(e, n)), n.pendingRevision = t, P(n, D, O), n.subscription === void 0) try {
			let t = e.subscribe((e) => {
				e !== n.revision && e !== n.pendingRevision && (n.pendingRevision = e, n.flags = v | S, n.subs !== void 0 && (F(n.subs, !!k), A || H()));
			});
			n.subscription = t, t.revision !== n.revision && (n.pendingRevision = t.revision, n.flags = v | S, n.subs !== void 0 && (F(n.subs, !!k), A || H()));
		} catch (e) {
			U(e);
		}
	}
};
function L(e) {
	let t = E.graphCollector;
	if (t === void 0 || t.runtimeToken === T) return;
	let n = se.get(e);
	n !== void 0 && t.add(n, e.renderRevision);
}
function R(e, t) {
	let n = E.renderCollector;
	if (n === void 0 || n.runtimeToken === T) return;
	let r = ae.get(e);
	r !== void 0 && n.add(r, t.renderRevision);
}
function fe(e, t) {
	let n = D, r = E.graphCollector;
	D = e, E.graphCollector = de;
	try {
		return t();
	} finally {
		D = n, E.graphCollector = r;
	}
}
function pe(e, t) {
	let n = E.renderCollector, r = E.speculativeDepth;
	E.renderCollector = void 0, E.speculativeDepth = 0;
	try {
		return m(() => fe(e, t));
	} finally {
		E.speculativeDepth = r, E.renderCollector = n;
	}
}
function z(e, t, n = {}) {
	return {
		kind: e,
		flags: t,
		deps: void 0,
		depsTail: void 0,
		subs: void 0,
		subsTail: void 0,
		renderRevision: 0,
		...n
	};
}
var me = class {
	#e;
	#t;
	constructor(e, t) {
		this.#e = e, this.#t = t, this.runtimeToken = T, Object.freeze(this);
	}
	get version() {
		return 1;
	}
	getRevision() {
		return this.#t.renderRevision;
	}
	subscribe(e) {
		let t = !0;
		return {
			unsubscribe: Ne(() => {
				try {
					this.#e.value;
				} catch {}
				t ? t = !1 : e(this.#t.renderRevision);
			}),
			revision: this.#t.renderRevision
		};
	}
};
function he(e, t) {
	let n = new me(e, t);
	ae.set(e, n), se.set(t, n), Object.defineProperty(e, h, {
		value: n,
		enumerable: !1,
		writable: !1,
		configurable: !1
	});
}
function B(e) {
	return e.flags & S && ge(e) && e.subs !== void 0 && I(e.subs), D !== void 0 && P(e, D, O), L(e), e.currentValue;
}
function ge(e) {
	return e.flags = v, !Object.is(e.currentValue, e.currentValue = e.pendingValue);
}
function V(e) {
	let t = e.flags;
	if (t & S || t & C && (ue(e.deps, e) || (e.flags = t & ~C, !1)) ? _e(e) && e.subs !== void 0 && I(e.subs) : t || _e(e), D !== void 0 && P(e, D, O), L(e), e.hasError) throw e.error;
	return e.value;
}
function _e(e) {
	e.flags & w && be(e), e.depsTail = void 0, e.flags = v | b;
	let t = D;
	D = e;
	let n = !e.initialized, r = e.hasError, i = e.value;
	try {
		O += 1;
		try {
			e.value = fe(e, () => e.getter(i)), e.error = void 0, e.hasError = !1;
		} catch (t) {
			e.value = void 0, e.error = t, e.hasError = !0;
		}
		return e.initialized = !0, n = n || r || e.hasError || !Object.is(i, e.value), n && (e.renderRevision = e.renderRevision + 1 | 0), n;
	} finally {
		D = t, e.flags &= ~b, Se(e);
	}
}
function ve(e, t) {
	Object.is(e.pendingValue, e.pendingValue = t) || (e.renderRevision = e.renderRevision + 1 | 0, e.flags = v | S, e.subs !== void 0 && (F(e.subs, !!k), A || H()));
}
function ye(e) {
	let t = e.flags;
	if (t & S || t & C && ue(e.deps, e)) {
		if (t & w && be(e), e.cleanup !== void 0) {
			try {
				Ce(e);
			} catch (n) {
				throw e.flags = y | t & w, n;
			}
			if (!e.flags) return;
		}
		e.depsTail = void 0, e.flags = y | b;
		let n = D;
		D = e;
		try {
			O += 1, k += 1;
			let t = pe(e, e.fn);
			e.cleanup = typeof t == "function" ? t : void 0;
		} finally {
			--k, D = n, e.flags &= ~b, Se(e);
		}
	} else e.deps !== void 0 && (e.flags = y | t & w);
}
function H() {
	try {
		for (; j < M;) {
			let e = N[j];
			N[j++] = void 0;
			try {
				ye(e);
			} catch (e) {
				U(e);
			}
		}
	} finally {
		for (; j < M;) {
			let e = N[j];
			N[j++] = void 0, e.flags |= y | x;
		}
		j = 0, M = 0;
	}
}
function U(e) {
	try {
		console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: e });
	} catch {}
	try {
		let t = globalThis.reportError;
		typeof t == "function" && t.call(globalThis, e);
	} catch {}
}
function be(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		t.dep.kind === "effect" && le(t, e), t = n;
	}
}
function xe(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		le(t, e), t = n;
	}
}
function Se(e) {
	let t = e.depsTail, n = t === void 0 ? e.deps : t.nextDep;
	for (; n !== void 0;) n = le(n, e);
}
function Ce(e) {
	let t = e.cleanup;
	e.cleanup = void 0;
	let n = D, r = E.renderCollector, i = E.speculativeDepth;
	D = void 0, E.renderCollector = void 0, E.speculativeDepth = 0;
	try {
		m(t);
	} finally {
		E.speculativeDepth = i, E.renderCollector = r, D = n;
	}
}
function we(e) {
	if (e.flags = _, xe(e), e.cleanup !== void 0) try {
		Ce(e);
	} catch (e) {
		U(e);
	}
}
function Te(e) {
	let t = z("source", v, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			return B(t);
		},
		set value(e) {
			ve(t, e);
		},
		peek() {
			return W(() => B(t));
		}
	};
}
function Ee(e) {
	let t = z("source", v, {
		currentValue: e,
		pendingValue: e
	});
	function n(...e) {
		if (e.length) {
			if (!Object.is(this.pendingValue, this.pendingValue = e[0])) {
				this.flags = v | S;
				let e = this.subs;
				e !== void 0 && (F(e, !!k), A || H());
			}
		} else return this.flags & S && ge(this) && this.subs !== void 0 && I(this.subs), D !== void 0 && P(this, D, O), this.currentValue;
	}
	let r = n.bind(t), i = { peek() {
		return W(() => r());
	} };
	return Object.defineProperty(i, "value", {
		get: r,
		set: r,
		enumerable: !0
	}), i;
}
function De(e) {
	let t = z("source", v, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			if (t.flags & S && (t.flags = v, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
				let e = t.subs;
				e !== void 0 && I(e);
			}
			return D !== void 0 && P(t, D, O), t.currentValue;
		},
		set value(e) {
			if (!Object.is(t.pendingValue, t.pendingValue = e)) {
				t.flags = v | S;
				let e = t.subs;
				e !== void 0 && (F(e, !!k), A || H());
			}
		},
		peek() {
			return W(() => {
				if (t.flags & S && (t.flags = v, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
					let e = t.subs;
					e !== void 0 && I(e);
				}
				return D !== void 0 && P(t, D, O), t.currentValue;
			});
		}
	};
}
var Oe = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		return B(this.#e);
	}
	set value(e) {
		ve(this.#e, e);
	}
	peek() {
		return W(() => B(this.#e));
	}
}, ke = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		let e = this.#e;
		if (e.flags & S && (e.flags = v, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
			let t = e.subs;
			t !== void 0 && I(t);
		}
		return D !== void 0 && P(e, D, O), e.currentValue;
	}
	set value(e) {
		let t = this.#e;
		if (!Object.is(t.pendingValue, t.pendingValue = e)) {
			t.flags = v | S;
			let e = t.subs;
			e !== void 0 && (F(e, !!k), A || H());
		}
	}
	peek() {
		return W(() => this.value);
	}
};
function Ae(e) {
	return new Oe(z("source", v, {
		currentValue: e,
		pendingValue: e
	}));
}
function je(e) {
	return new ke(z("source", v, {
		currentValue: e,
		pendingValue: e
	}));
}
function Me(e) {
	let t = z("computed", _, {
		getter: e,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	});
	return Object.freeze({
		get value() {
			return V(t);
		},
		peek() {
			return W(() => V(t));
		}
	});
}
function Ne(e) {
	let t = z("effect", y | b, {
		fn: e,
		cleanup: void 0
	}), n = D;
	n !== void 0 && (P(t, n, 0), n.flags |= w);
	try {
		D = t, k += 1;
		try {
			let n = pe(t, e);
			t.cleanup = typeof n == "function" ? n : void 0;
		} catch (e) {
			t.cleanup = void 0, U(e);
		} finally {
			--k, D = n, t.flags &= ~b, Se(t);
		}
	} catch (e) {
		U(e);
	}
	return () => we(t);
}
function Pe(e) {
	A += 1;
	try {
		return e();
	} finally {
		--A, A || H();
	}
}
function W(e) {
	let t = D, n = E.graphCollector, r = E.renderCollector, i = E.speculativeDepth;
	D = void 0, E.graphCollector = void 0, E.renderCollector = void 0, E.speculativeDepth = 0;
	try {
		return m(() => ne(e));
	} finally {
		D = t, E.graphCollector = n, E.renderCollector = r, E.speculativeDepth = i;
	}
}
var G = /* @__PURE__ */ new WeakMap(), Fe = /* @__PURE__ */ new WeakMap(), Ie = /* @__PURE__ */ new WeakMap(), Le = /* @__PURE__ */ new WeakMap(), K;
function Re(e) {
	let t = Le.get(e);
	if (t !== void 0) for (let e = t.length - 1; e >= 0; --e) {
		let n = t[e], r = !0;
		for (let [e, t] of n.dependencies) try {
			if (pt(e) !== t) {
				r = !1;
				break;
			}
		} catch {
			r = !1;
			break;
		}
		if (r) return n;
	}
}
function ze(e, t) {
	let n = Le.get(e) ?? [];
	n.push(t), n.length > 4 && n.shift(), Le.set(e, n);
}
function Be(e) {
	let t = Fe.get(e);
	if (t === void 0) return !0;
	for (let [e, n] of t) {
		if (!n.canPromote || e.initialized) continue;
		let t = [];
		for (let [e, r] of n.dependencies) {
			let n;
			try {
				n = pt(e);
			} catch {
				return !1;
			}
			if (n !== r) return !1;
			let i = G.get(e);
			if (i === void 0) return !1;
			t.push(i);
		}
		xe(e), e.depsTail = void 0;
		let r = D;
		D = e, O += 1;
		try {
			for (let n of t) P(n, e, O);
		} finally {
			D = r;
		}
		e.value = n.value, e.error = n.error, e.hasError = n.hasError, e.initialized = !0, e.flags = v;
	}
	return !0;
}
var q = Symbol.for("react-fine-grained-signals.signal"), Ve = 1, He = 1, Ue = /* @__PURE__ */ new WeakSet(), We = () => ({
	value: Ve,
	enumerable: !1,
	writable: !1,
	configurable: !1
});
function Ge(e) {
	Ue.add(e), Object.defineProperty(e, q, We());
}
function Ke(e) {
	Object.defineProperty(e, q, We());
}
function J(e) {
	if (e.flags & S && (e.flags = v, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
		let t = e.subs;
		t !== void 0 && I(t);
	}
	return D !== void 0 && P(e, D, O), e.currentValue;
}
function qe(e, t) {
	if (!Object.is(e.pendingValue, e.pendingValue = t)) {
		e.renderRevision = e.renderRevision + 1 | 0, e.flags = v | S;
		let t = e.subs;
		t !== void 0 && (F(t, !!k), A || H());
	}
}
var Je = class {
	#e;
	constructor(e) {
		this.#e = e, Ge(this);
	}
	get value() {
		return J(this.#e);
	}
	set value(e) {
		qe(this.#e, e);
	}
	peek() {
		return W(() => this.value);
	}
}, Ye = class {
	#e;
	constructor(e) {
		this.#e = e, Ke(this), G.set(this, e), he(this, e);
	}
	get value() {
		let e = this.#e;
		if (e.renderReadMode === "helper-call") {
			let t = f();
			if (t !== void 0) return ee()?.add(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== T && R(this, e), e.flags & S ? e.pendingValue : e.currentValue;
			let n = J(e);
			return L(e), p(this, e.renderRevision), n;
		}
		if (s === void 0) {
			let t = J(e);
			return E.graphCollector !== void 0 && E.graphCollector.runtimeToken !== T && L(e), t;
		}
		let t = s;
		if (t !== void 0) return c !== void 0 && (t.runtimeToken === void 0 || t.runtimeToken === T || c !== t) && p(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== T && R(this, e), e.flags & S ? e.pendingValue : e.currentValue;
		let n = J(e);
		return L(e), c !== void 0 && p(this, e.renderRevision), n;
	}
	set value(e) {
		qe(this.#e, e);
	}
	peek() {
		return W(() => this.value);
	}
}, Xe = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, q, {
			value: Ve,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return J(this.#e);
	}
	set value(e) {
		qe(this.#e, e);
	}
	peek() {
		return W(() => this.value);
	}
};
function Ze(e, t) {
	return new e(z("source", v, {
		currentValue: t,
		pendingValue: t
	}));
}
var Qe = (e) => Ze(Je, e), $e = (e) => Ze(Ye, e), et = (e) => Ze(Xe, e), tt = (e) => new Ye(z("source", v, {
	currentValue: e,
	pendingValue: e,
	renderReadMode: "helper-call"
})), nt = class {
	#e;
	constructor(e) {
		this.#e = e, Ge(this);
	}
	get value() {
		return V(this.#e);
	}
	peek() {
		return W(() => V(this.#e));
	}
}, rt = class {
	#e;
	constructor(e) {
		this.#e = e, Ke(this), G.set(this, e), he(this, e);
	}
	get value() {
		let e = this.#e;
		if (e.initialized && !(e.flags & (S | C))) {
			if (D !== void 0 && P(e, D, O), L(e), p(this, e.renderRevision), s?.runtimeToken !== void 0 && s.runtimeToken !== T && R(this, e), e.hasError) throw e.error;
			return e.value;
		}
		if (s !== void 0) {
			if (K !== void 0 && K !== e) {
				let t = E.renderCollector, n = E.speculativeDepth;
				E.renderCollector = void 0, E.speculativeDepth = 0;
				let r;
				try {
					r = m(() => V(e));
				} finally {
					E.speculativeDepth = n, E.renderCollector = t;
				}
				return p(this, e.renderRevision), L(e), r;
			}
			let t = s, n = Fe.get(t);
			n === void 0 && Fe.set(t, n = /* @__PURE__ */ new Map());
			let r = n.get(e);
			if (r === void 0 && (r = Re(e), r !== void 0 && n.set(e, r)), r === void 0) {
				let i = /* @__PURE__ */ new Map(), a = Ie.get(t);
				if (a === void 0 && Ie.set(t, a = /* @__PURE__ */ new Set()), a.has(e)) throw Error("Computed cycle detected");
				a.add(e);
				let o = K;
				K = e;
				try {
					let t = E.speculativeDeepReadEpoch;
					try {
						let t = E, n = t.speculativeDepth;
						t.speculativeDepth = n + 1;
						let a;
						try {
							a = te({ add(e, t) {
								i.has(e) || i.set(e, t);
							} }, () => e.getter(e.value));
						} finally {
							t.speculativeDepth = n;
						}
						r = {
							hasError: !1,
							value: a,
							error: void 0,
							dependencies: i,
							canPromote: !1
						};
					} catch (e) {
						r = {
							hasError: !0,
							value: void 0,
							error: e,
							dependencies: i,
							canPromote: !1
						};
					}
					r.canPromote = E.speculativeDeepReadEpoch === t, n.set(e, r), E.speculativeDeepReadEpoch === t && ze(e, r);
				} finally {
					K = o, a.delete(e);
				}
			}
			if (c !== void 0 && (t.runtimeToken === void 0 || t.runtimeToken === T || c !== t) && p(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== T && R(this, e), r.hasError) throw r.error;
			return r.value;
		}
		try {
			let t = V(e);
			return L(e), p(this, e.renderRevision), t;
		} catch (t) {
			throw L(e), (s?.runtimeToken === T || s?.runtimeToken === void 0) && c !== void 0 && p(this, e.renderRevision), s?.runtimeToken !== void 0 && s?.runtimeToken !== T && R(this, e), t;
		}
	}
	peek() {
		return W(() => this.value);
	}
}, it = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, q, {
			value: Ve,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return V(this.#e);
	}
	peek() {
		return W(() => V(this.#e));
	}
};
function at(e, t) {
	return new e(z("computed", _, {
		getter: t,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	}));
}
var ot = (e) => at(nt, e), st = (e) => at(rt, e), ct = (e) => at(it, e);
function lt(e) {
	if (typeof e != "object" || !e) return !1;
	let t = e[q];
	return typeof t == "number" && t >= He && typeof e.peek == "function";
}
function ut(e) {
	return typeof e != "object" || !e ? !1 : Ue.has(e) || lt(e);
}
var dt = lt, ft = lt;
function pt(e) {
	let t = G.get(e);
	if (t === void 0) {
		let t = e?.[h];
		if (t?.version === 1 && typeof t.getRevision == "function") return t.getRevision();
		throw TypeError("Unknown render-readable");
	}
	return t.renderRevision;
}
function mt(e, t) {
	let n = !0;
	return Ne(() => m(() => {
		for (let t of e) try {
			t.value;
		} catch {}
		n ? n = !1 : t();
	}));
}
function ht(e) {
	return gt(e).value;
}
function gt(e) {
	let t = l();
	t.runtimeToken = T;
	let n, r = E.renderCollector;
	E.renderCollector = t;
	try {
		re(t, () => {
			n = e.value;
		});
	} finally {
		E.renderCollector = r;
	}
	return {
		value: n,
		dependencies: t.dependencies
	};
}
function _t(e) {
	let t = G.get(e);
	if (t === void 0) throw TypeError("Unknown render-readable");
	return {
		flags: t.flags,
		currentValue: t.currentValue,
		pendingValue: t.pendingValue,
		deps: t.deps,
		depsTail: t.depsTail,
		subs: t.subs,
		subsTail: t.subsTail,
		computedValue: t.value,
		hasError: t.hasError,
		error: t.error,
		initialized: t.initialized
	};
}
function vt(e) {
	return G.get(e)?.subs !== void 0;
}
function yt() {
	return D !== void 0;
}
function bt() {
	return A;
}
function xt(e) {
	ce.add(e);
}
function St(e) {
	return ce.has(e);
}
//#endregion
//#region benchmarks/phase9/m15/react-adapter.mjs
function Y(e) {
	return typeof e == "object" && !!e && typeof e.getRevision == "function" && typeof e.subscribe == "function";
}
function Ct(e, t) {
	return Y(t) ? t.getRevision() : e.getRenderVersion(t);
}
function wt(e, t, n) {
	return Y(t) ? t.subscribe(() => n()).unsubscribe : e.subscribeReadables([t], n);
}
function Tt(e, t, n) {
	let r = t.captureRenderSnapshot(e);
	return n.current !== void 0 && n.current.dependencies.size === r.dependencies.size && [...r.dependencies].every(([e, r]) => n.current.dependencies.get(e) === r && Ct(t, e) === r) ? n.current.value : (n.current = r, r.value);
}
var Et = class {
	#e;
	#t;
	#n = /* @__PURE__ */ new Map();
	#r = /* @__PURE__ */ new Set();
	#i = /* @__PURE__ */ new Set();
	#a = 0;
	#o = 0;
	constructor(e, t) {
		this.#e = e, this.#t = t;
	}
	getSnapshot = () => this.#a;
	subscribe = (e) => (this.#i.add(e), () => this.#i.delete(e));
	begin() {
		let e = l();
		e.runtimeToken = this.#e.runtimeToken, e.restoreCollector = d(e);
		let t = g(), n = t.renderCollector;
		t.renderCollector = e, e.restoreSharedCollector = () => {
			t.renderCollector = n;
		};
		let r = ++this.#o;
		return queueMicrotask(() => {
			this.#o === r && u(void 0);
		}), e;
	}
	finish(e, t = !1) {
		e !== void 0 && (t ? (e.restoreCollector?.(), e.restoreSharedCollector?.()) : (u(void 0), g().renderCollector = void 0));
	}
	commit(e) {
		this.finish(e);
		let t = e.dependencies, n = this.#e.promoteRenderAttempt?.(e) === !1;
		if (this.#t === "combined") {
			let e = new Set([...t.keys()].filter((e) => !Y(e)));
			e.size === this.#r.size && [...e].every((e) => this.#r.has(e)) || (this.#n.get(this)?.(), this.#n.delete(this), this.#r = e, e.size > 0 && this.#n.set(this, this.#e.subscribeReadables([...e], this.#s)));
			for (let [e, n] of this.#n) e !== this && (!Y(e) || !t.has(e)) && (n(), this.#n.delete(e));
			for (let e of t.keys()) Y(e) && !this.#n.has(e) && this.#n.set(e, wt(this.#e, e, this.#s));
		} else {
			for (let [e, n] of this.#n) t.has(e) || (n(), this.#n.delete(e));
			for (let e of t.keys()) this.#n.has(e) || this.#n.set(e, wt(this.#e, e, this.#s));
		}
		for (let [e, r] of t) Ct(this.#e, e) !== r && (n = !0);
		n && this.#s();
	}
	#s = () => {
		this.#a = this.#a + 1 | 0;
		for (let e of [...this.#i]) e();
	};
	dispose() {
		for (let e of this.#n.values()) e();
		this.#n.clear(), this.#r.clear();
	}
	scheduleDispose() {
		let e = ++this.#o;
		queueMicrotask(() => {
			this.#o === e && this.dispose();
		});
	}
	activate() {
		this.#o += 1;
	}
};
function Dt(r, { mode: a = "combined" } = {}) {
	if (a !== "combined" && a !== "per-readable") throw Error(`Unknown render subscription mode: ${a}`);
	function o(e) {
		let t = n(() => (t) => r.subscribeReadables([e], t), [e]), a = n(() => ({ current: void 0 }), [e]), o = n(() => () => Tt(e, r, a), [e, a]);
		return i(t, o, o);
	}
	function s() {
		let o = n(() => new Et(r, a), []);
		i(o.subscribe, o.getSnapshot, o.getSnapshot);
		let s = o.begin();
		return t(() => {
			o.commit(s);
		}, [o, s]), e(() => (o.activate(), () => o.scheduleDispose()), [o]), {
			store: o,
			attempt: s
		};
	}
	function c() {
		s();
	}
	function l() {
		let { store: e, attempt: t } = s();
		return { finish: () => e.finish(t, !0) };
	}
	return {
		useSignalValue: o,
		useSignalTracking: c,
		useManagedSignals: l
	};
}
function Ot(e, t) {
	try {
		return t();
	} finally {
		e.finish();
	}
}
//#endregion
//#region src/core/interop.ts
var kt = Symbol.for("react-fine-grained-signals.readable-interop.v1"), At = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), X;
function jt() {
	if (X !== void 0) return X;
	let e = globalThis, t = e[At];
	if (t !== void 0) {
		if (t.version !== 1 || typeof t.speculativeDepth != "number") throw Error("Incompatible react-fine-grained-signals interop context");
		return X = t, t;
	}
	let n = {
		version: 1,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	};
	return Object.defineProperty(e, At, {
		value: n,
		enumerable: !1,
		configurable: !1,
		writable: !1
	}), X = n, n;
}
function Mt(e) {
	let t = e[kt];
	if (t === void 0 || typeof t != "object" || !t) return;
	let n = t;
	return n.version === 1 && typeof n.getRevision == "function" && typeof n.subscribe == "function" && typeof n.runtimeToken == "object" && n.runtimeToken !== null ? n : void 0;
}
function Nt(e, t) {
	Object.defineProperty(e, kt, {
		value: t,
		enumerable: !1,
		configurable: !1,
		writable: !1
	});
}
function Pt() {
	return jt().speculativeDepth > 0;
}
function Ft() {
	let e = jt();
	e.speculativeDeepReadEpoch = (e.speculativeDeepReadEpoch ?? 0) + 1;
}
function It() {
	return !1;
}
//#endregion
//#region src/core/signal-brand.ts
var Lt = Symbol.for("react-fine-grained-signals.signal");
//#endregion
//#region src/core/deep-signal-engine.ts
function Z(e) {
	return typeof e == "object" && !!e || typeof e == "function";
}
function Rt(e) {
	if (!Object.isExtensible(e)) throw TypeError("deepSignal() cannot proxy a non-extensible object or array");
}
function zt(e) {
	for (let t of Reflect.ownKeys(e)) {
		let n = Reflect.getOwnPropertyDescriptor(e, t);
		if (n !== void 0 && !("value" in n)) throw TypeError("deepSignal() does not support accessor properties");
	}
}
function Bt(e) {
	let t = [];
	return t.length = e, t;
}
function Vt(e) {
	if (typeof e != "string" || e === "") return !1;
	let t = Number(e);
	return Number.isInteger(t) && t >= 0 && t < 4294967295 && String(t) === e;
}
var Q = (e, t) => {
	let n = e.get(t);
	n !== void 0 && (n.value += 1);
}, $ = (e, t) => {
	!e.properties.has(t) && !e.existence.has(t) || (e.prunable ??= /* @__PURE__ */ new Set()).add(t);
}, Ht = (e) => {
	e.iteration !== void 0 && (e.iteration.value += 1);
};
function Ut(e) {
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
		if (Pt()) return Ft(), !1;
		let t = jt();
		return e.hasActiveSubscriber() || It() || t.graphCollector !== void 0 || t.renderCollector !== void 0;
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
	})(), u = (e) => Z(e) && l.has(e);
	function d(t) {
		if (typeof t != "object" || !t || e.isSignal(t) || l.has(t)) return !1;
		if (Array.isArray(t)) return !0;
		let n = Object.getPrototypeOf(t);
		return n === Object.prototype || n === null;
	}
	function f(e) {
		if (!Z(e)) return;
		let t = n.get(e);
		return t === void 0 ? o.get(e) : t;
	}
	function ee(e, t, n, r, i, a) {
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
	function p(e) {
		return ee(e, i, Map.prototype, "Map", (e, t, n) => ({
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
	function te(e) {
		return ee(e, a, Set.prototype, "Set", (e, t, n) => ({
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
				let i = Z(n) ? o.get(n) ?? n : n;
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
	function ne(e) {
		if (!d(e)) throw TypeError("deepSignal() only accepts a plain object or array root");
	}
	function m(e) {
		if (!Z(e)) return !1;
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
					for (let [e, t] of o) Z(e) && r.push({
						value: e,
						insideOpaque: !0
					}), Z(t) && r.push({
						value: t,
						insideOpaque: !0
					});
					continue;
				}
				if (o instanceof Set) {
					for (let e of o) Z(e) && r.push({
						value: e,
						insideOpaque: !0
					});
					continue;
				}
				if (!d(o)) {
					for (let e of Reflect.ownKeys(o)) {
						let t = Reflect.getOwnPropertyDescriptor(o, e);
						t !== void 0 && "value" in t && Z(t.value) && r.push({
							value: t.value,
							insideOpaque: !0
						});
					}
					continue;
				}
				a || (Rt(o), zt(o));
				for (let e of Reflect.ownKeys(o)) {
					let t = Reflect.getOwnPropertyDescriptor(o, e);
					if (t !== void 0 && "value" in t) {
						let e = t.value;
						Z(e) && r.push({
							value: e,
							insideOpaque: a
						});
					}
				}
			}
		}
		return i;
	}
	function re(e, t) {
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
	function ie(e) {
		let t = f(e);
		if (t !== void 0) return t;
		if (!Z(e)) return e;
		let n = s.get(e);
		if (n !== void 0 && re(e, n)) return n;
		let r = /* @__PURE__ */ new WeakMap(), i = [], a = [], o = (e) => {
			let t = f(e);
			if (t !== void 0) return t;
			if (!d(e)) return e;
			let n = r.get(e);
			if (n !== void 0) return n;
			let o = Array.isArray(e) ? Bt(e.length) : Object.create(Object.getPrototypeOf(e));
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
	function h(e) {
		let t = f(e);
		return t === void 0 ? m(e) ? ie(e) : e : t;
	}
	let g = (e) => h(e), _ = new Set(Reflect.ownKeys(Object.prototype)), v = /* @__PURE__ */ new Set([...Reflect.ownKeys(Object.prototype), ...Reflect.ownKeys(Array.prototype)]), y = (e, t) => {
		if (Object.prototype.hasOwnProperty.call(e, t)) return !1;
		let n = Object.getPrototypeOf(e);
		return n === Object.prototype ? _.has(t) : n === Array.prototype && v.has(t);
	}, b = (t, n) => {
		let r = t.get(n);
		return r === void 0 && (r = e.createSignal(0), t.set(n, r)), r;
	}, x = (t, n, r, i) => {
		if (!c() || y(t, i)) return;
		Vt(i) && r.add(Number(i));
		let a = b(n, i);
		e.markWatched(a), a.value;
	}, S = (t, n) => {
		let r = t.prunable;
		if (r !== void 0 && r.size !== 0 && e.getBatchDepth() === 0) {
			for (let i of r) {
				if (Object.prototype.hasOwnProperty.call(n, i)) {
					r.delete(i);
					continue;
				}
				let a = t.properties.get(i), o = t.existence.get(i);
				if (!(a !== void 0 && e.hasSubscribers(a) || o !== void 0 && e.hasSubscribers(o))) {
					if (t.properties.delete(i), t.existence.delete(i), Vt(i)) {
						let e = Number(i);
						t.propertyIndices.delete(e), t.existenceIndices.delete(e);
					}
					r.delete(i);
				}
			}
			r.size === 0 && (t.prunable = void 0);
		}
	}, C = (t) => {
		c() && (t.iteration ??= e.createSignal(0), t.iteration.value);
	}, w = (e, t, n) => {
		let r = n - t, i = e.propertyIndices.size + e.existenceIndices.size;
		if (i !== 0) {
			if (r <= i) {
				for (let r = t; r < n; r++) {
					let t = String(r);
					Q(e.properties, t), Q(e.existence, t), $(e, t);
				}
				return;
			}
			for (let r of e.propertyIndices) if (r >= t && r < n) {
				let t = String(r);
				Q(e.properties, t), $(e, t);
			}
			for (let r of e.existenceIndices) if (r >= t && r < n) {
				let t = String(r);
				Q(e.existence, t), $(e, t);
			}
		}
	}, T = (e) => d(e) || e instanceof Map || e instanceof Set, E = (i) => {
		let a = f(i) ?? i;
		if (a instanceof Map) return p(a);
		if (a instanceof Set) return te(a);
		if (!d(a)) return a;
		Rt(a);
		let o = r.get(a);
		if (o !== void 0) return o.proxy;
		zt(a);
		let s = {
			properties: /* @__PURE__ */ new Map(),
			existence: /* @__PURE__ */ new Map(),
			propertyIndices: /* @__PURE__ */ new Set(),
			existenceIndices: /* @__PURE__ */ new Set(),
			arrayMethods: /* @__PURE__ */ new Map(),
			proxy: void 0
		}, c = new Proxy(a, {
			get(n, r, i) {
				if (r === Lt && !Object.prototype.hasOwnProperty.call(n, r)) return;
				x(n, s.properties, s.propertyIndices, r);
				let a = Reflect.get(n, r, i);
				if (Array.isArray(n) && t.has(r) && typeof a == "function") {
					let t = s.arrayMethods.get(r);
					if (t?.method === a) return t.wrapper;
					let i = a, o = function(...t) {
						try {
							return e.batch(() => Reflect.apply(i, this, t));
						} finally {
							S(s, n);
						}
					};
					return s.arrayMethods.set(r, {
						method: i,
						wrapper: o
					}), o;
				}
				if (T(a)) {
					let e = Reflect.getOwnPropertyDescriptor(n, r);
					if (e !== void 0 && "value" in e && e.configurable === !1 && e.writable === !1) throw TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
				}
				return E(a);
			},
			set(t, n, r) {
				if (n === "__proto__") throw TypeError("deepSignal() does not support prototype mutation");
				if (n === Lt) throw TypeError("deepSignal() does not support branding state as a signal");
				let i = Reflect.get(t, n, t), a = Reflect.has(t, n), o = Object.prototype.hasOwnProperty.call(t, n), c = Array.isArray(t) ? t.length : void 0, l = g(r);
				if (!Reflect.set(t, n, l, t)) return !1;
				let u = Reflect.get(t, n, t), d = Reflect.has(t, n), f = Object.prototype.hasOwnProperty.call(t, n);
				return e.batch(() => {
					if ((!Object.is(i, u) || o !== f) && Q(s.properties, n), a !== d && Q(s.existence, n), o !== f && Ht(s), Array.isArray(t) && c !== void 0) {
						let e = t.length;
						n !== "length" && c !== e && Q(s.properties, "length"), n === "length" && e < c && (w(s, e, c), Ht(s));
					}
				}), S(s, t), !0;
			},
			deleteProperty(t, n) {
				let r = Reflect.has(t, n), i = Object.prototype.hasOwnProperty.call(t, n), a = Reflect.deleteProperty(t, n);
				return !a || !i ? a : (e.batch(() => {
					Q(s.properties, n), r !== Reflect.has(t, n) && Q(s.existence, n), Ht(s), $(s, n);
				}), S(s, t), !0);
			},
			getOwnPropertyDescriptor(e, t) {
				x(e, s.properties, s.propertyIndices, t);
				let n = Reflect.getOwnPropertyDescriptor(e, t);
				return n === void 0 || !("value" in n) || n.configurable === !1 && n.writable === !1 || (n.value = E(n.value)), n;
			},
			has(e, t) {
				return x(e, s.existence, s.existenceIndices, t), Reflect.has(e, t);
			},
			ownKeys(e) {
				return C(s), Reflect.ownKeys(e);
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
	class D {
		#e;
		constructor(e) {
			this.#e = e;
			let t = Mt(this.#e);
			t !== void 0 && Nt(this, t);
		}
		get value() {
			return E(this.#e.value);
		}
		set value(e) {
			let t = g(e);
			ne(t), this.#e.value = t;
		}
		peek() {
			return this.#e.peek();
		}
	}
	function O(e) {
		let t = r.get(f(e) ?? e);
		if (t !== void 0) return {
			properties: [...t.properties.keys()],
			existence: [...t.existence.keys()],
			propertyIndices: [...t.propertyIndices],
			existenceIndices: [...t.existenceIndices]
		};
	}
	function k(t) {
		let n = h(t);
		ne(n), E(n);
		let r = e.createSignal(n), i = new D(r);
		return e.registerDeepSignal?.(i), i;
	}
	return {
		deepSignal: k,
		inspectDeepSignalMetadata: O
	};
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-deep-signal-engine.ts
var Wt = /* @__PURE__ */ new WeakSet(), Gt = Ut({
	createSignal: $e,
	markWatched(e) {
		Wt.add(e), xt(e);
	},
	hasSubscribers: vt,
	batch: Pe,
	isSignal: dt,
	hasActiveSubscriber: yt,
	getBatchDepth: bt,
	registerDeepSignal(e) {
		Object.defineProperty(e, q, {
			value: 1,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
}), Kt = Gt.deepSignal, qt = Gt.inspectDeepSignalMetadata;
//#endregion
//#region benchmarks/phase9/m15/deep-selector-react-hook.mjs
function Jt(e) {
	return function(t) {
		let r = n(() => (n) => {
			let r = !0;
			return e.effect(() => {
				t.value, r ? r = !1 : n();
			});
		}, [t]), a = n(() => () => t.value, [t]);
		return i(r, a, a);
	};
}
function Yt(e) {
	return function(t, a, o = []) {
		let s = r(o.length);
		if (o.length !== s.current) throw Error("selector dependencies length changed");
		let c = n(() => {
			let n = () => {
				try {
					let e = a(t.value);
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
			}, r = e.untracked(n), i = (e) => r.kind !== e.kind || r.kind === "value" && e.kind === "value" && !Object.is(r.value, e.value) || r.kind === "error" && e.kind === "error" && !Object.is(r.error, e.error);
			return {
				getSnapshot() {
					if (r.kind === "error") throw r.error;
					return r.value;
				},
				subscribe(t) {
					let a = !0;
					return e.effect(() => {
						let e = n(), o = i(e);
						r = e, a ? a = !1 : o && t();
					});
				}
			};
		}, [t, ...o]);
		return i(c.subscribe, c.getSnapshot, c.getSnapshot);
	};
}
//#endregion
export { h as READABLE_INTEROP_V1, q as SIGNAL_BRAND, Pe as batch, gt as captureRenderSnapshot, Me as computed, ct as computedClassBrandDirect, st as computedClassBrandHelper, ot as computedClassBrandWeakSet, Yt as createDeepSelectorHook, Dt as createReactAdapter, Jt as createSignalValueHook, Kt as deepSignal, Ne as effect, bt as getBatchDepth, _t as getRenderDebugSnapshot, pt as getRenderVersion, yt as hasActiveSubscriber, vt as hasSubscribers, qt as inspectDeepSignalMetadata, St as isDeepSignalWatched, ft as isSignalBrandDirect, dt as isSignalBrandHelper, ut as isSignalBrandWeakSet, Ot as managed, xt as markDeepSignalWatched, Be as promoteRenderAttempt, ht as readRenderSnapshot, T as runtimeToken, Te as signal, Ee as signalBoundAccessor, et as signalClassBrandDirect, $e as signalClassBrandHelper, tt as signalClassBrandHelperCalls, Qe as signalClassBrandWeakSet, Ae as signalClassHelper, je as signalClassInline, De as signalInlineAccessor, mt as subscribeReadables, W as untracked };
