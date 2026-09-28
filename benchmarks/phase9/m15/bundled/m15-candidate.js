import { useEffect as e, useLayoutEffect as t, useMemo as n, useSyncExternalStore as r } from "react";
//#region benchmarks/phase9/node_modules/.pnpm/alien-signals@3.2.1/node_modules/alien-signals/esm/system.mjs
var i = {
	None: 0,
	Mutable: 1,
	Watching: 2,
	RecursedCheck: 4,
	Recursed: 8,
	Dirty: 16,
	Pending: 32
};
function a({ update: e, notify: t, unwatched: n }) {
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
var o, s;
function c() {
	return {
		dependencies: /* @__PURE__ */ new Map(),
		add(e, t) {
			this.dependencies.has(e) || this.dependencies.set(e, t);
		}
	};
}
function l(e) {
	let t = s;
	return s = e, o = e, t;
}
function ee(e) {
	let t = o, n = s;
	return o = e, s = e, () => {
		o = t, s = n;
	};
}
function u() {
	return o;
}
function d() {
	return s;
}
function f(e, t) {
	s?.add(e, t);
}
function te(e, t) {
	let n = s;
	s = e;
	try {
		return t();
	} finally {
		s = n;
	}
}
function ne(e) {
	let t = s;
	s = void 0;
	try {
		return e();
	} finally {
		s = t;
	}
}
function p(e) {
	let t = o, n = s;
	o = void 0, s = void 0;
	try {
		return e();
	} finally {
		o = t, s = n;
	}
}
function re(e, t) {
	let n = o, r = s;
	o = e, s = e;
	try {
		return t();
	} finally {
		o = n, s = r;
	}
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-interop-context.mjs
var ie = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), m = Symbol.for("react-fine-grained-signals.readable-interop.v1");
function h() {
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
var { None: g, Mutable: _, Watching: v, RecursedCheck: y, Recursed: ae, Dirty: b, Pending: x } = i, S = 64, C = {}, w = h(), T, E = 0, D = 0, O = 0, k = 0, A = 0, j = [], oe = /* @__PURE__ */ new WeakMap(), se = /* @__PURE__ */ new WeakMap(), ce = /* @__PURE__ */ new WeakMap(), le = /* @__PURE__ */ new WeakSet(), { link: M, unlink: ue, propagate: N, checkDirty: de, shallowPropagate: P } = a({
	update(e) {
		if (e.kind === "external") {
			let t = e.revision !== e.pendingRevision;
			return e.revision = e.pendingRevision, e.flags = _, t;
		}
		return e.kind === "computed" ? ve(e) : e.kind === "source" ? _e(e) : (e.flags = _, !0);
	},
	notify(e) {
		let t = A, n = t;
		do
			if (j[t++] = e, e.flags &= ~v, e = e.subs?.sub, e === void 0 || !(e.flags & v)) break;
		while (!0);
		A = t;
		let r = n;
		for (; r < --t;) {
			let e = j[r];
			j[r++] = j[t], j[t] = e;
		}
	},
	unwatched(e) {
		if (e.kind === "external") {
			e.subscription?.unsubscribe(), e.subscription = void 0;
			return;
		}
		e.kind === "computed" ? e.depsTail !== void 0 && (e.flags = _ | b, Se(e)) : e.kind === "effect" && Te(e);
	}
}), fe = {
	runtimeToken: C,
	add(e, t) {
		if (e.runtimeToken === C || T === void 0) return;
		let n = se.get(e);
		if (n === void 0 && (n = L("external", _, {
			protocol: e,
			revision: t,
			pendingRevision: t,
			subscription: void 0
		}), se.set(e, n)), n.pendingRevision = t, M(n, T, E), n.subscription === void 0) try {
			let t = e.subscribe((e) => {
				e !== n.revision && e !== n.pendingRevision && (n.pendingRevision = e, n.flags = _ | b, n.subs !== void 0 && (N(n.subs, !!D), O || B()));
			});
			n.subscription = t, t.revision !== n.revision && (n.pendingRevision = t.revision, n.flags = _ | b, n.subs !== void 0 && (N(n.subs, !!D), O || B()));
		} catch (e) {
			V(e);
		}
	}
};
function F(e) {
	let t = w.graphCollector;
	if (t === void 0 || t.runtimeToken === C) return;
	let n = ce.get(e);
	n !== void 0 && t.add(n, e.renderRevision);
}
function I(e, t) {
	let n = w.renderCollector;
	if (n === void 0 || n.runtimeToken === C) return;
	let r = oe.get(e);
	r !== void 0 && n.add(r, t.renderRevision);
}
function pe(e, t) {
	let n = T, r = w.graphCollector;
	T = e, w.graphCollector = fe;
	try {
		return t();
	} finally {
		T = n, w.graphCollector = r;
	}
}
function me(e, t) {
	let n = w.renderCollector, r = w.speculativeDepth;
	w.renderCollector = void 0, w.speculativeDepth = 0;
	try {
		return p(() => pe(e, t));
	} finally {
		w.speculativeDepth = r, w.renderCollector = n;
	}
}
function L(e, t, n = {}) {
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
var he = class {
	#e;
	#t;
	constructor(e, t) {
		this.#e = e, this.#t = t, this.runtimeToken = C, Object.freeze(this);
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
			unsubscribe: Pe(() => {
				try {
					this.#e.value;
				} catch {}
				t ? t = !1 : e(this.#t.renderRevision);
			}),
			revision: this.#t.renderRevision
		};
	}
};
function ge(e, t) {
	let n = new he(e, t);
	oe.set(e, n), ce.set(t, n), Object.defineProperty(e, m, {
		value: n,
		enumerable: !1,
		writable: !1,
		configurable: !1
	});
}
function R(e) {
	return e.flags & b && _e(e) && e.subs !== void 0 && P(e.subs), T !== void 0 && M(e, T, E), F(e), e.currentValue;
}
function _e(e) {
	return e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue);
}
function z(e) {
	let t = e.flags;
	if (t & b || t & x && (de(e.deps, e) || (e.flags = t & ~x, !1)) ? ve(e) && e.subs !== void 0 && P(e.subs) : t || ve(e), T !== void 0 && M(e, T, E), F(e), e.hasError) throw e.error;
	return e.value;
}
function ve(e) {
	e.flags & S && xe(e), e.depsTail = void 0, e.flags = _ | y;
	let t = T;
	T = e;
	let n = !e.initialized, r = e.hasError, i = e.value;
	try {
		E += 1;
		try {
			e.value = pe(e, () => e.getter(i)), e.error = void 0, e.hasError = !1;
		} catch (t) {
			e.value = void 0, e.error = t, e.hasError = !0;
		}
		return e.initialized = !0, n = n || r || e.hasError || !Object.is(i, e.value), n && (e.renderRevision = e.renderRevision + 1 | 0), n;
	} finally {
		T = t, e.flags &= ~y, Ce(e);
	}
}
function ye(e, t) {
	Object.is(e.pendingValue, e.pendingValue = t) || (e.renderRevision = e.renderRevision + 1 | 0, e.flags = _ | b, e.subs !== void 0 && (N(e.subs, !!D), O || B()));
}
function be(e) {
	let t = e.flags;
	if (t & b || t & x && de(e.deps, e)) {
		if (t & S && xe(e), e.cleanup !== void 0) {
			try {
				we(e);
			} catch (n) {
				throw e.flags = v | t & S, n;
			}
			if (!e.flags) return;
		}
		e.depsTail = void 0, e.flags = v | y;
		let n = T;
		T = e;
		try {
			E += 1, D += 1;
			let t = me(e, e.fn);
			e.cleanup = typeof t == "function" ? t : void 0;
		} finally {
			--D, T = n, e.flags &= ~y, Ce(e);
		}
	} else e.deps !== void 0 && (e.flags = v | t & S);
}
function B() {
	try {
		for (; k < A;) {
			let e = j[k];
			j[k++] = void 0;
			try {
				be(e);
			} catch (e) {
				V(e);
			}
		}
	} finally {
		for (; k < A;) {
			let e = j[k];
			j[k++] = void 0, e.flags |= v | ae;
		}
		k = 0, A = 0;
	}
}
function V(e) {
	try {
		console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: e });
	} catch {}
	try {
		let t = globalThis.reportError;
		typeof t == "function" && t.call(globalThis, e);
	} catch {}
}
function xe(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		t.dep.kind === "effect" && ue(t, e), t = n;
	}
}
function Se(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		ue(t, e), t = n;
	}
}
function Ce(e) {
	let t = e.depsTail, n = t === void 0 ? e.deps : t.nextDep;
	for (; n !== void 0;) n = ue(n, e);
}
function we(e) {
	let t = e.cleanup;
	e.cleanup = void 0;
	let n = T, r = w.renderCollector, i = w.speculativeDepth;
	T = void 0, w.renderCollector = void 0, w.speculativeDepth = 0;
	try {
		p(t);
	} finally {
		w.speculativeDepth = i, w.renderCollector = r, T = n;
	}
}
function Te(e) {
	if (e.flags = g, Se(e), e.cleanup !== void 0) try {
		we(e);
	} catch (e) {
		V(e);
	}
}
function Ee(e) {
	let t = L("source", _, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			return R(t);
		},
		set value(e) {
			ye(t, e);
		},
		peek() {
			return H(() => R(t));
		}
	};
}
function De(e) {
	let t = L("source", _, {
		currentValue: e,
		pendingValue: e
	});
	function n(...e) {
		if (e.length) {
			if (!Object.is(this.pendingValue, this.pendingValue = e[0])) {
				this.flags = _ | b;
				let e = this.subs;
				e !== void 0 && (N(e, !!D), O || B());
			}
		} else return this.flags & b && _e(this) && this.subs !== void 0 && P(this.subs), T !== void 0 && M(this, T, E), this.currentValue;
	}
	let r = n.bind(t), i = { peek() {
		return H(() => r());
	} };
	return Object.defineProperty(i, "value", {
		get: r,
		set: r,
		enumerable: !0
	}), i;
}
function Oe(e) {
	let t = L("source", _, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			if (t.flags & b && (t.flags = _, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
				let e = t.subs;
				e !== void 0 && P(e);
			}
			return T !== void 0 && M(t, T, E), t.currentValue;
		},
		set value(e) {
			if (!Object.is(t.pendingValue, t.pendingValue = e)) {
				t.flags = _ | b;
				let e = t.subs;
				e !== void 0 && (N(e, !!D), O || B());
			}
		},
		peek() {
			return H(() => {
				if (t.flags & b && (t.flags = _, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
					let e = t.subs;
					e !== void 0 && P(e);
				}
				return T !== void 0 && M(t, T, E), t.currentValue;
			});
		}
	};
}
var ke = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		return R(this.#e);
	}
	set value(e) {
		ye(this.#e, e);
	}
	peek() {
		return H(() => R(this.#e));
	}
}, Ae = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		let e = this.#e;
		if (e.flags & b && (e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
			let t = e.subs;
			t !== void 0 && P(t);
		}
		return T !== void 0 && M(e, T, E), e.currentValue;
	}
	set value(e) {
		let t = this.#e;
		if (!Object.is(t.pendingValue, t.pendingValue = e)) {
			t.flags = _ | b;
			let e = t.subs;
			e !== void 0 && (N(e, !!D), O || B());
		}
	}
	peek() {
		return H(() => this.value);
	}
};
function je(e) {
	return new ke(L("source", _, {
		currentValue: e,
		pendingValue: e
	}));
}
function Me(e) {
	return new Ae(L("source", _, {
		currentValue: e,
		pendingValue: e
	}));
}
function Ne(e) {
	let t = L("computed", g, {
		getter: e,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	});
	return Object.freeze({
		get value() {
			return z(t);
		},
		peek() {
			return H(() => z(t));
		}
	});
}
function Pe(e) {
	let t = L("effect", v | y, {
		fn: e,
		cleanup: void 0
	}), n = T;
	n !== void 0 && (M(t, n, 0), n.flags |= S);
	try {
		T = t, D += 1;
		try {
			let n = me(t, e);
			t.cleanup = typeof n == "function" ? n : void 0;
		} catch (e) {
			t.cleanup = void 0, V(e);
		} finally {
			--D, T = n, t.flags &= ~y, Ce(t);
		}
	} catch (e) {
		V(e);
	}
	return () => Te(t);
}
function Fe(e) {
	O += 1;
	try {
		return e();
	} finally {
		--O, O || B();
	}
}
function H(e) {
	let t = T, n = w.graphCollector, r = w.renderCollector, i = w.speculativeDepth;
	T = void 0, w.graphCollector = void 0, w.renderCollector = void 0, w.speculativeDepth = 0;
	try {
		return p(() => ne(e));
	} finally {
		T = t, w.graphCollector = n, w.renderCollector = r, w.speculativeDepth = i;
	}
}
var U = /* @__PURE__ */ new WeakMap(), Ie = /* @__PURE__ */ new WeakMap(), Le = /* @__PURE__ */ new WeakMap(), W, G = Symbol.for("react-fine-grained-signals.signal"), K = 1, Re = 1, ze = /* @__PURE__ */ new WeakSet(), Be = () => ({
	value: K,
	enumerable: !1,
	writable: !1,
	configurable: !1
});
function Ve(e) {
	ze.add(e), Object.defineProperty(e, G, Be());
}
function He(e) {
	Object.defineProperty(e, G, Be());
}
function q(e) {
	if (e.flags & b && (e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
		let t = e.subs;
		t !== void 0 && P(t);
	}
	return T !== void 0 && M(e, T, E), e.currentValue;
}
function Ue(e, t) {
	if (!Object.is(e.pendingValue, e.pendingValue = t)) {
		e.renderRevision = e.renderRevision + 1 | 0, e.flags = _ | b;
		let t = e.subs;
		t !== void 0 && (N(t, !!D), O || B());
	}
}
var We = class {
	#e;
	constructor(e) {
		this.#e = e, Ve(this);
	}
	get value() {
		return q(this.#e);
	}
	set value(e) {
		Ue(this.#e, e);
	}
	peek() {
		return H(() => this.value);
	}
}, Ge = class {
	#e;
	constructor(e) {
		this.#e = e, He(this), U.set(this, e), ge(this, e);
	}
	get value() {
		let e = this.#e;
		if (e.renderReadMode === "helper-call") {
			let t = u();
			if (t !== void 0) return d()?.add(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== C && I(this, e), e.flags & b ? e.pendingValue : e.currentValue;
			let n = q(e);
			return F(e), f(this, e.renderRevision), n;
		}
		if (o === void 0) {
			let t = q(e);
			return w.graphCollector !== void 0 && w.graphCollector.runtimeToken !== C && F(e), t;
		}
		let t = o;
		if (t !== void 0) return s !== void 0 && (t.runtimeToken === void 0 || t.runtimeToken === C || s !== t) && f(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== C && I(this, e), e.flags & b ? e.pendingValue : e.currentValue;
		let n = q(e);
		return F(e), s !== void 0 && f(this, e.renderRevision), n;
	}
	set value(e) {
		Ue(this.#e, e);
	}
	peek() {
		return H(() => this.value);
	}
}, Ke = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, G, {
			value: K,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return q(this.#e);
	}
	set value(e) {
		Ue(this.#e, e);
	}
	peek() {
		return H(() => this.value);
	}
};
function qe(e, t) {
	return new e(L("source", _, {
		currentValue: t,
		pendingValue: t
	}));
}
var Je = (e) => qe(We, e), Ye = (e) => qe(Ge, e), Xe = (e) => qe(Ke, e), Ze = (e) => new Ge(L("source", _, {
	currentValue: e,
	pendingValue: e,
	renderReadMode: "helper-call"
})), Qe = class {
	#e;
	constructor(e) {
		this.#e = e, Ve(this);
	}
	get value() {
		return z(this.#e);
	}
	peek() {
		return H(() => z(this.#e));
	}
}, $e = class {
	#e;
	constructor(e) {
		this.#e = e, He(this), U.set(this, e), ge(this, e);
	}
	get value() {
		let e = this.#e;
		if (o !== void 0) {
			if (W !== void 0 && W !== e) {
				let t = w.renderCollector, n = w.speculativeDepth;
				w.renderCollector = void 0, w.speculativeDepth = 0;
				let r;
				try {
					r = p(() => z(e));
				} finally {
					w.speculativeDepth = n, w.renderCollector = t;
				}
				return f(this, e.renderRevision), F(e), r;
			}
			let t = o, n = Ie.get(t);
			n === void 0 && Ie.set(t, n = /* @__PURE__ */ new Map());
			let r = n.get(e);
			if (r === void 0) {
				let i = /* @__PURE__ */ new Map(), a = Le.get(t);
				if (a === void 0 && Le.set(t, a = /* @__PURE__ */ new Set()), a.has(e)) throw Error("Computed cycle detected");
				a.add(e);
				let o = W;
				W = e;
				try {
					try {
						let t = w, n = t.speculativeDepth;
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
							dependencies: i
						};
					} catch (e) {
						r = {
							hasError: !0,
							value: void 0,
							error: e,
							dependencies: i
						};
					}
					n.set(e, r);
				} finally {
					W = o, a.delete(e);
				}
			}
			if (s !== void 0 && (t.runtimeToken === void 0 || t.runtimeToken === C || s !== t) && f(this, e.renderRevision), t.runtimeToken !== void 0 && t.runtimeToken !== C && I(this, e), r.hasError) throw r.error;
			return r.value;
		}
		try {
			let t = z(e);
			return F(e), f(this, e.renderRevision), t;
		} catch (t) {
			throw F(e), (o?.runtimeToken === C || o?.runtimeToken === void 0) && s !== void 0 && f(this, e.renderRevision), o?.runtimeToken !== void 0 && o?.runtimeToken !== C && I(this, e), t;
		}
	}
	peek() {
		return H(() => this.value);
	}
}, et = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, G, {
			value: K,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return z(this.#e);
	}
	peek() {
		return H(() => z(this.#e));
	}
};
function tt(e, t) {
	return new e(L("computed", g, {
		getter: t,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	}));
}
var nt = (e) => tt(Qe, e), rt = (e) => tt($e, e), it = (e) => tt(et, e);
function J(e) {
	if (typeof e != "object" || !e) return !1;
	let t = e[G];
	return typeof t == "number" && t >= Re && typeof e.peek == "function";
}
function at(e) {
	return typeof e != "object" || !e ? !1 : ze.has(e) || J(e);
}
var ot = J, st = J;
function ct(e) {
	let t = U.get(e);
	if (t === void 0) {
		let t = e?.[m];
		if (t?.version === 1 && typeof t.getRevision == "function") return t.getRevision();
		throw TypeError("Unknown render-readable");
	}
	return t.renderRevision;
}
function lt(e, t) {
	let n = !0;
	return Pe(() => p(() => {
		for (let t of e) try {
			t.value;
		} catch {}
		n ? n = !1 : t();
	}));
}
function ut(e) {
	return dt(e).value;
}
function dt(e) {
	let t = c();
	t.runtimeToken = C;
	let n, r = w.renderCollector;
	w.renderCollector = t;
	try {
		re(t, () => {
			n = e.value;
		});
	} finally {
		w.renderCollector = r;
	}
	return {
		value: n,
		dependencies: t.dependencies
	};
}
function ft(e) {
	let t = U.get(e);
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
function pt(e) {
	return U.get(e)?.subs !== void 0;
}
function mt() {
	return T !== void 0;
}
function ht() {
	return O;
}
function gt(e) {
	le.add(e);
}
function _t(e) {
	return le.has(e);
}
//#endregion
//#region benchmarks/phase9/m15/react-adapter.mjs
function Y(e) {
	return typeof e == "object" && !!e && typeof e.getRevision == "function" && typeof e.subscribe == "function";
}
function vt(e, t) {
	return Y(t) ? t.getRevision() : e.getRenderVersion(t);
}
function yt(e, t, n) {
	return Y(t) ? t.subscribe(() => n()).unsubscribe : e.subscribeReadables([t], n);
}
function bt(e, t, n) {
	let r = t.captureRenderSnapshot(e);
	return n.current !== void 0 && n.current.dependencies.size === r.dependencies.size && [...r.dependencies].every(([e, r]) => n.current.dependencies.get(e) === r && vt(t, e) === r) ? n.current.value : (n.current = r, r.value);
}
var xt = class {
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
		let e = c();
		e.runtimeToken = this.#e.runtimeToken, e.restoreCollector = ee(e);
		let t = h(), n = t.renderCollector;
		t.renderCollector = e, e.restoreSharedCollector = () => {
			t.renderCollector = n;
		};
		let r = ++this.#o;
		return queueMicrotask(() => {
			this.#o === r && l(void 0);
		}), e;
	}
	finish(e, t = !1) {
		e !== void 0 && (t ? (e.restoreCollector?.(), e.restoreSharedCollector?.()) : (l(void 0), h().renderCollector = void 0));
	}
	commit(e) {
		this.finish(e);
		let t = e.dependencies, n = !1;
		if (this.#t === "combined") {
			let e = new Set([...t.keys()].filter((e) => !Y(e)));
			e.size === this.#r.size && [...e].every((e) => this.#r.has(e)) || (this.#n.get(this)?.(), this.#n.delete(this), this.#r = e, e.size > 0 && this.#n.set(this, this.#e.subscribeReadables([...e], this.#s)));
			for (let [e, n] of this.#n) e !== this && (!Y(e) || !t.has(e)) && (n(), this.#n.delete(e));
			for (let e of t.keys()) Y(e) && !this.#n.has(e) && this.#n.set(e, yt(this.#e, e, this.#s));
		} else {
			for (let [e, n] of this.#n) t.has(e) || (n(), this.#n.delete(e));
			for (let e of t.keys()) this.#n.has(e) || this.#n.set(e, yt(this.#e, e, this.#s));
		}
		for (let [e, r] of t) vt(this.#e, e) !== r && (n = !0);
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
function St(i, { mode: a = "combined" } = {}) {
	if (a !== "combined" && a !== "per-readable") throw Error(`Unknown render subscription mode: ${a}`);
	function o(e) {
		let t = n(() => (t) => i.subscribeReadables([e], t), [e]), a = n(() => ({ current: void 0 }), [e]), o = n(() => () => bt(e, i, a), [e, a]);
		return r(t, o, o);
	}
	function s() {
		let o = n(() => new xt(i, a), []);
		r(o.subscribe, o.getSnapshot, o.getSnapshot);
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
function Ct(e, t) {
	try {
		return t();
	} finally {
		e.finish();
	}
}
//#endregion
//#region src/core/interop.ts
var wt = Symbol.for("react-fine-grained-signals.readable-interop.v1"), Tt = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), X;
function Et() {
	if (X !== void 0) return X;
	let e = globalThis, t = e[Tt];
	if (t !== void 0) {
		if (t.version !== 1 || typeof t.speculativeDepth != "number") throw Error("Incompatible react-fine-grained-signals interop context");
		return X = t, t;
	}
	let n = {
		version: 1,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	};
	return Object.defineProperty(e, Tt, {
		value: n,
		enumerable: !1,
		configurable: !1,
		writable: !1
	}), X = n, n;
}
function Dt(e) {
	let t = e[wt];
	if (t === void 0 || typeof t != "object" || !t) return;
	let n = t;
	return n.version === 1 && typeof n.getRevision == "function" && typeof n.subscribe == "function" && typeof n.runtimeToken == "object" && n.runtimeToken !== null ? n : void 0;
}
function Ot(e, t) {
	Object.defineProperty(e, wt, {
		value: t,
		enumerable: !1,
		configurable: !1,
		writable: !1
	});
}
function kt() {
	return Et().speculativeDepth > 0;
}
function At() {
	let e = Et();
	e.speculativeDeepReadEpoch = (e.speculativeDeepReadEpoch ?? 0) + 1;
}
function jt() {
	return !1;
}
//#endregion
//#region src/core/signal-brand.ts
var Mt = Symbol.for("react-fine-grained-signals.signal");
//#endregion
//#region src/core/deep-signal-engine.ts
function Z(e) {
	return typeof e == "object" && !!e || typeof e == "function";
}
function Nt(e) {
	if (!Object.isExtensible(e)) throw TypeError("deepSignal() cannot proxy a non-extensible object or array");
}
function Pt(e) {
	for (let t of Reflect.ownKeys(e)) {
		let n = Reflect.getOwnPropertyDescriptor(e, t);
		if (n !== void 0 && !("value" in n)) throw TypeError("deepSignal() does not support accessor properties");
	}
}
function Ft(e) {
	let t = [];
	return t.length = e, t;
}
function It(e) {
	if (typeof e != "string" || e === "") return !1;
	let t = Number(e);
	return Number.isInteger(t) && t >= 0 && t < 4294967295 && String(t) === e;
}
var Q = (e, t) => {
	let n = e.get(t);
	n !== void 0 && (n.value += 1);
}, $ = (e, t) => {
	!e.properties.has(t) && !e.existence.has(t) || (e.prunable ??= /* @__PURE__ */ new Set()).add(t);
}, Lt = (e) => {
	e.iteration !== void 0 && (e.iteration.value += 1);
};
function Rt(e) {
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
		if (kt()) return At(), !1;
		let t = Et();
		return e.hasActiveSubscriber() || jt() || t.graphCollector !== void 0 || t.renderCollector !== void 0;
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
	})(), ee = (e) => Z(e) && l.has(e);
	function u(t) {
		if (typeof t != "object" || !t || e.isSignal(t) || l.has(t)) return !1;
		if (Array.isArray(t)) return !0;
		let n = Object.getPrototypeOf(t);
		return n === Object.prototype || n === null;
	}
	function d(e) {
		if (!Z(e)) return;
		let t = n.get(e);
		return t === void 0 ? o.get(e) : t;
	}
	function f(e, t, n, r, i, a) {
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
	function te(e) {
		return f(e, i, Map.prototype, "Map", (e, t, n) => ({
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
	function ne(e) {
		return f(e, a, Set.prototype, "Set", (e, t, n) => ({
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
	function p(e) {
		if (!u(e)) throw TypeError("deepSignal() only accepts a plain object or array root");
	}
	function re(e) {
		if (!Z(e)) return !1;
		let t = /* @__PURE__ */ new WeakMap(), r = [{
			value: e,
			insideOpaque: !1
		}], i = !1;
		for (; r.length > 0;) {
			let { value: e, insideOpaque: a } = r.pop();
			if (d(e) !== void 0) {
				if (a) throw TypeError(n.has(e) ? "deepSignal() cannot store a deep proxy inside an opaque value" : "deepSignal() cannot store a deep collection view inside an opaque value");
				i = !0;
				continue;
			}
			let o = e, s = t.get(o) ?? 0, c = a ? 2 : 1;
			if ((s & c) === 0) {
				if (t.set(o, s | c), !a && ee(o)) throw TypeError("deepSignal() cannot store a built-in prototype object in deep state");
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
				if (!u(o)) {
					for (let e of Reflect.ownKeys(o)) {
						let t = Reflect.getOwnPropertyDescriptor(o, e);
						t !== void 0 && "value" in t && Z(t.value) && r.push({
							value: t.value,
							insideOpaque: !0
						});
					}
					continue;
				}
				a || (Nt(o), Pt(o));
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
	function ie(e, t) {
		let n = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap(), i = [[e, t]];
		for (; i.length > 0;) {
			let [e, t] = i.pop();
			if (typeof e != "object" || !e) {
				if (!Object.is(e, t)) return !1;
				continue;
			}
			let a = d(e);
			if (a !== void 0) {
				if (a !== t) return !1;
				continue;
			}
			if (!u(e)) {
				if (e !== t) return !1;
				continue;
			}
			if (typeof t != "object" || !t || !u(t)) return !1;
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
	function m(e) {
		let t = d(e);
		if (t !== void 0) return t;
		if (!Z(e)) return e;
		let n = s.get(e);
		if (n !== void 0 && ie(e, n)) return n;
		let r = /* @__PURE__ */ new WeakMap(), i = [], a = [], o = (e) => {
			let t = d(e);
			if (t !== void 0) return t;
			if (!u(e)) return e;
			let n = r.get(e);
			if (n !== void 0) return n;
			let o = Array.isArray(e) ? Ft(e.length) : Object.create(Object.getPrototypeOf(e));
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
		let t = d(e);
		return t === void 0 ? re(e) ? m(e) : e : t;
	}
	let g = (e) => h(e), _ = new Set(Reflect.ownKeys(Object.prototype)), v = /* @__PURE__ */ new Set([...Reflect.ownKeys(Object.prototype), ...Reflect.ownKeys(Array.prototype)]), y = (e, t) => {
		if (Object.prototype.hasOwnProperty.call(e, t)) return !1;
		let n = Object.getPrototypeOf(e);
		return n === Object.prototype ? _.has(t) : n === Array.prototype && v.has(t);
	}, ae = (t, n) => {
		let r = t.get(n);
		return r === void 0 && (r = e.createSignal(0), t.set(n, r)), r;
	}, b = (t, n, r, i) => {
		if (!c() || y(t, i)) return;
		It(i) && r.add(Number(i));
		let a = ae(n, i);
		e.markWatched(a), a.value;
	}, x = (t, n) => {
		let r = t.prunable;
		if (r !== void 0 && r.size !== 0 && e.getBatchDepth() === 0) {
			for (let i of r) {
				if (Object.prototype.hasOwnProperty.call(n, i)) {
					r.delete(i);
					continue;
				}
				let a = t.properties.get(i), o = t.existence.get(i);
				if (!(a !== void 0 && e.hasSubscribers(a) || o !== void 0 && e.hasSubscribers(o))) {
					if (t.properties.delete(i), t.existence.delete(i), It(i)) {
						let e = Number(i);
						t.propertyIndices.delete(e), t.existenceIndices.delete(e);
					}
					r.delete(i);
				}
			}
			r.size === 0 && (t.prunable = void 0);
		}
	}, S = (t) => {
		c() && (t.iteration ??= e.createSignal(0), t.iteration.value);
	}, C = (e, t, n) => {
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
	}, w = (e) => u(e) || e instanceof Map || e instanceof Set, T = (i) => {
		let a = d(i) ?? i;
		if (a instanceof Map) return te(a);
		if (a instanceof Set) return ne(a);
		if (!u(a)) return a;
		Nt(a);
		let o = r.get(a);
		if (o !== void 0) return o.proxy;
		Pt(a);
		let s = {
			properties: /* @__PURE__ */ new Map(),
			existence: /* @__PURE__ */ new Map(),
			propertyIndices: /* @__PURE__ */ new Set(),
			existenceIndices: /* @__PURE__ */ new Set(),
			arrayMethods: /* @__PURE__ */ new Map(),
			proxy: void 0
		}, c = new Proxy(a, {
			get(n, r, i) {
				if (r === Mt && !Object.prototype.hasOwnProperty.call(n, r)) return;
				b(n, s.properties, s.propertyIndices, r);
				let a = Reflect.get(n, r, i);
				if (Array.isArray(n) && t.has(r) && typeof a == "function") {
					let t = s.arrayMethods.get(r);
					if (t?.method === a) return t.wrapper;
					let i = a, o = function(...t) {
						try {
							return e.batch(() => Reflect.apply(i, this, t));
						} finally {
							x(s, n);
						}
					};
					return s.arrayMethods.set(r, {
						method: i,
						wrapper: o
					}), o;
				}
				if (w(a)) {
					let e = Reflect.getOwnPropertyDescriptor(n, r);
					if (e !== void 0 && "value" in e && e.configurable === !1 && e.writable === !1) throw TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
				}
				return T(a);
			},
			set(t, n, r) {
				if (n === "__proto__") throw TypeError("deepSignal() does not support prototype mutation");
				if (n === Mt) throw TypeError("deepSignal() does not support branding state as a signal");
				let i = Reflect.get(t, n, t), a = Reflect.has(t, n), o = Object.prototype.hasOwnProperty.call(t, n), c = Array.isArray(t) ? t.length : void 0, l = g(r);
				if (!Reflect.set(t, n, l, t)) return !1;
				let ee = Reflect.get(t, n, t), u = Reflect.has(t, n), d = Object.prototype.hasOwnProperty.call(t, n);
				return e.batch(() => {
					if ((!Object.is(i, ee) || o !== d) && Q(s.properties, n), a !== u && Q(s.existence, n), o !== d && Lt(s), Array.isArray(t) && c !== void 0) {
						let e = t.length;
						n !== "length" && c !== e && Q(s.properties, "length"), n === "length" && e < c && (C(s, e, c), Lt(s));
					}
				}), x(s, t), !0;
			},
			deleteProperty(t, n) {
				let r = Reflect.has(t, n), i = Object.prototype.hasOwnProperty.call(t, n), a = Reflect.deleteProperty(t, n);
				return !a || !i ? a : (e.batch(() => {
					Q(s.properties, n), r !== Reflect.has(t, n) && Q(s.existence, n), Lt(s), $(s, n);
				}), x(s, t), !0);
			},
			getOwnPropertyDescriptor(e, t) {
				b(e, s.properties, s.propertyIndices, t);
				let n = Reflect.getOwnPropertyDescriptor(e, t);
				return n === void 0 || !("value" in n) || n.configurable === !1 && n.writable === !1 || (n.value = T(n.value)), n;
			},
			has(e, t) {
				return b(e, s.existence, s.existenceIndices, t), Reflect.has(e, t);
			},
			ownKeys(e) {
				return S(s), Reflect.ownKeys(e);
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
	class E {
		#e;
		constructor(e) {
			this.#e = e;
			let t = Dt(this.#e);
			t !== void 0 && Ot(this, t);
		}
		get value() {
			return T(this.#e.value);
		}
		set value(e) {
			let t = g(e);
			p(t), this.#e.value = t;
		}
		peek() {
			return this.#e.peek();
		}
	}
	function D(e) {
		let t = r.get(d(e) ?? e);
		if (t !== void 0) return {
			properties: [...t.properties.keys()],
			existence: [...t.existence.keys()],
			propertyIndices: [...t.propertyIndices],
			existenceIndices: [...t.existenceIndices]
		};
	}
	function O(t) {
		let n = h(t);
		p(n), T(n);
		let r = e.createSignal(n), i = new E(r);
		return e.registerDeepSignal?.(i), i;
	}
	return {
		deepSignal: O,
		inspectDeepSignalMetadata: D
	};
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-deep-signal-engine.ts
var zt = /* @__PURE__ */ new WeakSet(), Bt = Rt({
	createSignal: Ye,
	markWatched(e) {
		zt.add(e), gt(e);
	},
	hasSubscribers: pt,
	batch: Fe,
	isSignal: ot,
	hasActiveSubscriber: mt,
	getBatchDepth: ht,
	registerDeepSignal(e) {
		Object.defineProperty(e, G, {
			value: 1,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
}), Vt = Bt.deepSignal, Ht = Bt.inspectDeepSignalMetadata;
//#endregion
export { m as READABLE_INTEROP_V1, G as SIGNAL_BRAND, Fe as batch, dt as captureRenderSnapshot, Ne as computed, it as computedClassBrandDirect, rt as computedClassBrandHelper, nt as computedClassBrandWeakSet, St as createReactAdapter, Vt as deepSignal, Pe as effect, ht as getBatchDepth, ft as getRenderDebugSnapshot, ct as getRenderVersion, mt as hasActiveSubscriber, pt as hasSubscribers, Ht as inspectDeepSignalMetadata, _t as isDeepSignalWatched, st as isSignalBrandDirect, ot as isSignalBrandHelper, at as isSignalBrandWeakSet, Ct as managed, gt as markDeepSignalWatched, ut as readRenderSnapshot, C as runtimeToken, Ee as signal, De as signalBoundAccessor, Xe as signalClassBrandDirect, Ye as signalClassBrandHelper, Ze as signalClassBrandHelperCalls, Je as signalClassBrandWeakSet, je as signalClassHelper, Me as signalClassInline, Oe as signalInlineAccessor, lt as subscribeReadables, H as untracked };
