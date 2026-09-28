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
//#region benchmarks/phase9/m15/alien-derived-runtime-execution-owner.mjs
var s = Symbol.for("react-fine-grained-signals.shared-execution-owner.v2"), c = globalThis[s];
if (c !== void 0 && c.version !== 2) throw Error("Incompatible RFSG shared execution owner");
var l = c ?? {
	version: 2,
	owner: void 0
};
c === void 0 && Object.defineProperty(globalThis, s, {
	value: l,
	enumerable: !1,
	configurable: !1,
	writable: !1
});
var u = Symbol.for("react-fine-grained-signals.untracked-owner.v2");
function d(e, t) {
	let n = l.owner;
	l.owner = e;
	try {
		return t();
	} finally {
		l.owner = n;
	}
}
function f(e) {
	let t = l.owner;
	l.owner = e;
	let n = !0;
	return () => {
		n && (n = !1, l.owner === e && (l.owner = t));
	};
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-interop-context.mjs
var p = Symbol.for("react-fine-grained-signals.readable-interop.v1");
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-foreign-adapter.mjs
function m(e) {
	return e.renderRevision ??= 0;
}
function h({ runtimeToken: e, makeNode: t, mutableFlag: n, dirtyFlag: r, getActiveSubscriber: i, link: a, propagate: o, flush: s, isRunning: c, isBatching: f, effect: h }) {
	let g = /* @__PURE__ */ new WeakMap(), _ = /* @__PURE__ */ new WeakMap(), v = /* @__PURE__ */ new WeakMap();
	function y(e, l) {
		let u = v.get(e);
		u === void 0 && (u = t("external", n, {
			protocol: e,
			revision: l,
			pendingRevision: l,
			unsubscribe: void 0
		}), v.set(e, u)), u.pendingRevision = l;
		let d = i();
		if (d !== void 0 && a(u, d), u.unsubscribe === void 0) {
			let t = e.subscribe((e) => {
				e !== u.revision && e !== u.pendingRevision && (u.pendingRevision = e, u.flags = n | r, u.subs !== void 0 && (o(u.subs, c()), f() || s()));
			});
			u.unsubscribe = t.unsubscribe, t.revision !== u.revision && (u.pendingRevision = t.revision, u.flags = n | r, u.subs !== void 0 && (o(u.subs, c()), f() || s()));
		}
		return u;
	}
	let b = {
		kind: "graph",
		runtimeToken: e,
		add(e, t) {
			y(e, t);
		}
	};
	function x(t) {
		let n = l.owner;
		return n?.kind === "graph" && n.runtimeToken === e ? t() : d(b, t);
	}
	function S(t, n, r) {
		if (r === u || r?.runtimeToken === e) return;
		let i = g.get(t);
		i !== void 0 && (r?.kind === "graph" || r?.kind === "render") && r.add(i, m(n));
	}
	function C(t, n) {
		_.set(t, n);
		let r = {
			version: 1,
			runtimeToken: e,
			getRevision: () => m(n),
			subscribe(e) {
				let r = m(n), i = !0;
				return {
					unsubscribe: h(() => {
						try {
							t.value;
						} catch {}
						i ? i = !1 : e(m(n));
					}),
					revision: r
				};
			}
		};
		g.set(t, r), Object.defineProperty(t, p, {
			value: r,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	function w(e) {
		let t = _.get(e);
		if (t !== void 0) return m(t);
		let n = e?.[p];
		if (n?.version === 1 && typeof n.getRevision == "function") return n.getRevision();
		throw TypeError("Unknown candidate readable");
	}
	return {
		attachProtocol: C,
		ensureForeignNode: y,
		getNodeForReadable: (e) => _.get(e),
		getReadableRevision: w,
		observeRevision: m,
		publishForeignReadable: S,
		graphOwner: b,
		withGraphOwner: x
	};
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-owner-core.mjs
var { None: g, Mutable: _, Watching: v, RecursedCheck: y, Recursed: b, Dirty: x, Pending: S } = a, C = 64, w = Symbol("no graph callback argument"), T = {}, E, D, O, k = 0, A = 0, j = 0, M = 0, N = 0, P = [], { link: F, unlink: I, propagate: L, checkDirty: ee, shallowPropagate: R } = o({
	update(e) {
		if (e.kind === "external") {
			let t = e.revision !== e.pendingRevision;
			return e.revision = e.pendingRevision, e.flags = _, t;
		}
		return e.kind === "computed" ? ge(e) : e.kind === "source" ? he(e) : (e.flags = _, !0);
	},
	notify(e) {
		let t = N, n = t;
		do
			if (P[t++] = e, e.flags &= ~v, e = e.subs?.sub, e === void 0 || !(e.flags & v)) break;
		while (!0);
		N = t;
		let r = n;
		for (; r < --t;) {
			let e = P[r];
			P[r++] = P[t], P[t] = e;
		}
	},
	unwatched(e) {
		e.kind === "external" ? (e.unsubscribe?.(), e.unsubscribe = void 0) : e.kind === "computed" ? e.depsTail !== void 0 && (e.flags = _ | x, be(e)) : e.kind === "effect" && Ce(e);
	}
});
function z(e, t, n = {}) {
	return {
		kind: e,
		flags: t,
		deps: void 0,
		depsTail: void 0,
		subs: void 0,
		subsTail: void 0,
		renderRevision: void 0,
		...n
	};
}
var B = h({
	runtimeToken: T,
	makeNode: z,
	mutableFlag: _,
	dirtyFlag: x,
	getActiveSubscriber: () => O,
	link: (e, t) => F(e, t, k),
	propagate: L,
	flush: () => W(),
	isRunning: () => !!A,
	isBatching: () => !!j,
	effect: (e) => Me(e)
});
function V(e) {
	return e.flags & x && he(e) && e.subs !== void 0 && R(e.subs), O !== void 0 && F(e, O, k), e.currentValue;
}
var te = B.attachProtocol, ne = B.ensureForeignNode, re = B.graphOwner;
function ie(e, t = w, n = void 0) {
	let r = l.owner, i = D, a = r?.kind === "graph" && r.runtimeToken === T;
	if (i === void 0 && a) return t === w ? e() : e.call(n, t);
	D = void 0, a || (l.owner = re);
	try {
		return t === w ? e() : e.call(n, t);
	} finally {
		a || (l.owner = r), D = i;
	}
}
function ae(e) {
	E = e;
}
function oe(e, t) {
	let n = H(e);
	try {
		return t();
	} finally {
		n();
	}
}
function H(e) {
	let t = D;
	D = e;
	let n = !0;
	return () => {
		n && (n = !1, D === e && (D = t));
	};
}
function se() {
	return D;
}
var ce = B.getNodeForReadable, le = B.getReadableRevision;
function ue(e) {
	return e.initialized && !(e.flags & (x | S));
}
function de(e, t, n) {
	if (t.initialized) return !0;
	let r = [];
	for (let [e, t] of n.dependencies) {
		if (le(e) !== t) return !1;
		let n = B.getNodeForReadable(e);
		if (n !== void 0) r.push(n);
		else {
			let n = e?.version === 1 && typeof e.getRevision == "function" && typeof e.subscribe == "function" ? e : void 0;
			if (n === void 0) return !1;
			r.push(ne(n, t));
		}
	}
	be(t), t.depsTail = void 0;
	let i = O;
	O = t, k += 1;
	try {
		for (let e of r) F(e, t, k);
	} finally {
		O = i;
	}
	return t.value = n.value, t.error = n.error, t.hasError = n.hasError, t.initialized = !0, t.flags = _, !0;
}
function fe(e) {
	return B.getNodeForReadable(e)?.subs !== void 0;
}
function pe() {
	return O !== void 0;
}
function me() {
	return j;
}
function he(e) {
	return e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue);
}
function U(e) {
	let t = e.flags;
	if (t & x || t & S && (ee(e.deps, e) || (e.flags = t & ~S, !1)) ? ge(e) && e.subs !== void 0 && R(e.subs) : t || ge(e), O !== void 0 && F(e, O, k), e.hasError) throw e.error;
	return e.value;
}
function ge(e) {
	e.flags & C && ye(e), e.depsTail = void 0, e.flags = _ | y;
	let t = O;
	O = e;
	let n = !e.initialized, r = e.hasError, i = e.value;
	try {
		k += 1;
		try {
			e.value = ie(e.getter, i, e), e.error = void 0, e.hasError = !1;
		} catch (t) {
			e.value = void 0, e.error = t, e.hasError = !0;
		}
		return e.initialized = !0, n = n || r || e.hasError || !Object.is(i, e.value), n && e.renderRevision !== void 0 && (e.renderRevision = e.renderRevision + 1 | 0), n;
	} finally {
		O = t, e.flags &= ~y, xe(e);
	}
}
function _e(e, t) {
	Object.is(e.pendingValue, e.pendingValue = t) || (e.renderRevision !== void 0 && (e.renderRevision = e.renderRevision + 1 | 0), e.flags = _ | x, e.subs !== void 0 && (L(e.subs, !!A), j || W()));
}
function ve(e) {
	let t = e.flags;
	if (t & x || t & S && ee(e.deps, e)) {
		if (t & C && ye(e), e.cleanup !== void 0) {
			try {
				Se(e);
			} catch (n) {
				throw e.flags = v | t & C, n;
			}
			if (!e.flags) return;
		}
		e.depsTail = void 0, e.flags = v | y;
		let n = O;
		O = e;
		try {
			k += 1, A += 1;
			let t = ie(e.fn);
			e.cleanup = typeof t == "function" ? t : void 0;
		} finally {
			--A, O = n, e.flags &= ~y, xe(e);
		}
	} else e.deps !== void 0 && (e.flags = v | t & C);
}
function W() {
	try {
		for (; M < N;) {
			let e = P[M];
			P[M++] = void 0;
			try {
				ve(e);
			} catch (e) {
				G(e);
			}
		}
	} finally {
		for (; M < N;) {
			let e = P[M];
			P[M++] = void 0, e.flags |= v | b;
		}
		M = 0, N = 0;
	}
}
function G(e) {
	try {
		console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: e });
	} catch {}
	try {
		let t = globalThis.reportError;
		typeof t == "function" && t.call(globalThis, e);
	} catch {}
}
function ye(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		t.dep.kind === "effect" && I(t, e), t = n;
	}
}
function be(e) {
	let t = e.depsTail;
	for (; t !== void 0;) {
		let n = t.prevDep;
		I(t, e), t = n;
	}
}
function xe(e) {
	let t = e.depsTail, n = t === void 0 ? e.deps : t.nextDep;
	for (; n !== void 0;) n = I(n, e);
}
function Se(e) {
	let t = e.cleanup;
	e.cleanup = void 0;
	let n = O;
	O = void 0;
	try {
		return d(u, t);
	} finally {
		O = n;
	}
}
function Ce(e) {
	if (e.flags = g, be(e), e.cleanup !== void 0) try {
		Se(e);
	} catch (e) {
		G(e);
	}
}
function we(e) {
	let t = z("source", _, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			return V(t);
		},
		set value(e) {
			_e(t, e);
		},
		peek() {
			return K(() => V(t));
		}
	};
}
function Te(e) {
	let t = z("source", _, {
		currentValue: e,
		pendingValue: e
	});
	function n(...e) {
		if (e.length) {
			if (!Object.is(this.pendingValue, this.pendingValue = e[0])) {
				this.flags = _ | x;
				let e = this.subs;
				e !== void 0 && (L(e, !!A), j || W());
			}
		} else return this.flags & x && he(this) && this.subs !== void 0 && R(this.subs), O !== void 0 && F(this, O, k), this.currentValue;
	}
	let r = n.bind(t), i = { peek() {
		return K(() => r());
	} };
	return Object.defineProperty(i, "value", {
		get: r,
		set: r,
		enumerable: !0
	}), i;
}
function Ee(e) {
	let t = z("source", _, {
		currentValue: e,
		pendingValue: e
	});
	return {
		get value() {
			if (t.flags & x && (t.flags = _, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
				let e = t.subs;
				e !== void 0 && R(e);
			}
			return O !== void 0 && F(t, O, k), t.currentValue;
		},
		set value(e) {
			if (!Object.is(t.pendingValue, t.pendingValue = e)) {
				t.flags = _ | x;
				let e = t.subs;
				e !== void 0 && (L(e, !!A), j || W());
			}
		},
		peek() {
			return K(() => {
				if (t.flags & x && (t.flags = _, !Object.is(t.currentValue, t.currentValue = t.pendingValue))) {
					let e = t.subs;
					e !== void 0 && R(e);
				}
				return O !== void 0 && F(t, O, k), t.currentValue;
			});
		}
	};
}
var De = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		return V(this.#e);
	}
	set value(e) {
		_e(this.#e, e);
	}
	peek() {
		return K(() => V(this.#e));
	}
}, Oe = class {
	#e;
	constructor(e) {
		this.#e = e;
	}
	get value() {
		let e = this.#e;
		if (e.flags & x && (e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
			let t = e.subs;
			t !== void 0 && R(t);
		}
		return O !== void 0 && F(e, O, k), e.currentValue;
	}
	set value(e) {
		let t = this.#e;
		if (!Object.is(t.pendingValue, t.pendingValue = e)) {
			t.flags = _ | x;
			let e = t.subs;
			e !== void 0 && (L(e, !!A), j || W());
		}
	}
	peek() {
		return K(() => this.value);
	}
};
function ke(e) {
	return new De(z("source", _, {
		currentValue: e,
		pendingValue: e
	}));
}
function Ae(e) {
	return new Oe(z("source", _, {
		currentValue: e,
		pendingValue: e
	}));
}
function je(e) {
	let t = z("computed", g, {
		getter: e,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	});
	return Object.freeze({
		get value() {
			return U(t);
		},
		peek() {
			return K(() => U(t));
		}
	});
}
function Me(e) {
	let t = z("effect", v | y, {
		fn: e,
		cleanup: void 0
	}), n = O;
	n !== void 0 && (F(t, n, 0), n.flags |= C);
	try {
		O = t, A += 1;
		try {
			let n = ie(e);
			t.cleanup = typeof n == "function" ? n : void 0;
		} catch (e) {
			t.cleanup = void 0, G(e);
		} finally {
			--A, O = n, t.flags &= ~y, xe(t);
		}
	} catch (e) {
		G(e);
	}
	return () => Ce(t);
}
function Ne(e) {
	j += 1;
	try {
		return e();
	} finally {
		--j, j || W();
	}
}
function K(e) {
	let t = O, n = D;
	O = void 0, D = void 0;
	try {
		return d(u, e);
	} finally {
		D = n, O = t;
	}
}
var q = Symbol.for("react-fine-grained-signals.signal"), Pe = 1, Fe = 1, Ie = /* @__PURE__ */ new WeakSet(), Le = () => ({
	value: Pe,
	enumerable: !1,
	writable: !1,
	configurable: !1
});
function Re(e) {
	Ie.add(e), Object.defineProperty(e, q, Le());
}
function ze(e) {
	Object.defineProperty(e, q, Le());
}
function Be(e) {
	if (e.flags & x && (e.flags = _, !Object.is(e.currentValue, e.currentValue = e.pendingValue))) {
		let t = e.subs;
		t !== void 0 && R(t);
	}
	return O !== void 0 && F(e, O, k), e.currentValue;
}
function Ve(e, t) {
	if (!Object.is(e.pendingValue, e.pendingValue = t)) {
		e.renderRevision !== void 0 && (e.renderRevision = e.renderRevision + 1 | 0), e.flags = _ | x;
		let t = e.subs;
		t !== void 0 && (L(t, !!A), j || W());
	}
}
var He = class {
	#e;
	constructor(e) {
		this.#e = e, Re(this);
	}
	get value() {
		return Be(this.#e);
	}
	set value(e) {
		Ve(this.#e, e);
	}
	peek() {
		return K(() => this.value);
	}
}, Ue = class {
	#e;
	constructor(e) {
		this.#e = e, ze(this), te(this, e);
	}
	get value() {
		let e = this.#e, t = D;
		if (t !== void 0 && E !== void 0) return B.observeRevision(e), E.readSource(this, e, t);
		let n = V(e), r = l.owner;
		return r !== void 0 && r !== u && r.runtimeToken !== T && B.publishForeignReadable(this, e, r), n;
	}
	set value(e) {
		Ve(this.#e, e);
	}
	peek() {
		return K(() => this.value);
	}
}, We = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, q, {
			value: Pe,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return Be(this.#e);
	}
	set value(e) {
		Ve(this.#e, e);
	}
	peek() {
		return K(() => this.value);
	}
};
function Ge(e, t) {
	return new e(z("source", _, {
		currentValue: t,
		pendingValue: t
	}));
}
var Ke = (e) => Ge(He, e), qe = (e) => Ge(Ue, e), Je = (e) => Ge(We, e), Ye = class {
	#e;
	constructor(e) {
		this.#e = e, Re(this);
	}
	get value() {
		return U(this.#e);
	}
	peek() {
		return K(() => U(this.#e));
	}
}, Xe = class {
	#e;
	constructor(e) {
		this.#e = e, ze(this), te(this, e);
	}
	get value() {
		let e = this.#e, t = D;
		if (t !== void 0 && E !== void 0) return B.observeRevision(e), E.readComputed(this, e, t);
		let n = U(e), r = l.owner;
		return r !== void 0 && r !== u && r.runtimeToken !== T && B.publishForeignReadable(this, e, r), n;
	}
	peek() {
		return K(() => U(this.#e));
	}
}, Ze = class {
	#e;
	constructor(e) {
		this.#e = e, Object.defineProperty(this, q, {
			value: Pe,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
	get value() {
		return U(this.#e);
	}
	peek() {
		return K(() => U(this.#e));
	}
};
function Qe(e, t) {
	return new e(z("computed", g, {
		getter: t,
		value: void 0,
		error: void 0,
		hasError: !1,
		initialized: !1
	}));
}
var $e = (e) => Qe(Ye, e), et = (e) => Qe(Xe, e), tt = (e) => Qe(Ze, e);
function nt(e) {
	if (typeof e != "object" || !e) return !1;
	let t = e[q];
	return typeof t == "number" && t >= Fe && typeof e.peek == "function";
}
function rt(e) {
	return typeof e != "object" || !e ? !1 : Ie.has(e) || nt(e);
}
var it = nt, at = nt, J, ot = /* @__PURE__ */ new WeakMap();
function Y(e, t, n) {
	let r = ce(t);
	r !== void 0 && ot.set(r, t), J === void 0 ? e.add(t, n) : J.dependencies.set(t, n);
}
function st(e, t, n) {
	return Y(n, e, t.renderRevision), t.pendingValue;
}
function ct(e, t, n) {
	if (J !== void 0 && J !== t) {
		let r = H(void 0);
		try {
			return e.value;
		} finally {
			Y(n, e, t.renderRevision), r();
		}
	}
	Y(n, e, t.renderRevision);
	let r = n.computedCache, i = r.get(t);
	if (i !== void 0) {
		if (i.hasError) throw i.error;
		return i.value;
	}
	if (ue(t)) {
		if (t.hasError) throw t.error;
		return t.value;
	}
	i = {
		dependencies: /* @__PURE__ */ new Map(),
		value: void 0,
		error: void 0,
		hasError: !1,
		canPromote: !1
	}, r.set(t, i);
	let a = J;
	J = i;
	let o = n.speculativeDeepReadEpoch;
	try {
		i.value = t.getter(t.value);
	} catch (e) {
		i.error = e, i.hasError = !0;
	} finally {
		J = a, i.canPromote = o === n.speculativeDeepReadEpoch;
	}
	if (i.hasError) throw i.error;
	return i.value;
}
ae({
	readSource: st,
	readComputed: ct
});
function lt() {
	return {
		dependencies: /* @__PURE__ */ new Map(),
		computedCache: /* @__PURE__ */ new Map(),
		speculativeDeepReadEpoch: 0,
		add(e, t) {
			this.dependencies.has(e) || this.dependencies.set(e, t);
		},
		markSpeculativeDeepRead() {
			this.speculativeDeepReadEpoch += 1;
		}
	};
}
function ut(e) {
	return {
		kind: "render",
		runtimeToken: T,
		add(t, n) {
			Y(e, t, n);
		},
		isSpeculative() {
			return J !== void 0;
		},
		markSpeculativeDeepRead() {
			e.markSpeculativeDeepRead();
		}
	};
}
function dt(e) {
	let t = H(e), n = f(ut(e)), r = !0;
	return () => {
		r && (r = !1, t(), n());
	};
}
function ft(e, t) {
	let n = dt(e);
	try {
		return t();
	} finally {
		n();
	}
}
function pt(e) {
	for (let [t, n] of e.computedCache) {
		if (!n.canPromote) continue;
		let e = ot.get(t);
		if (e === void 0 || !de(e, t, n)) return !1;
	}
	return !0;
}
function mt(e) {
	return le(e);
}
function ht() {
	return l.owner?.kind === "render";
}
function gt() {
	let e = l.owner;
	return e?.kind === "graph" || e?.kind === "untracked" ? !1 : e?.kind === "render" && (e.isSpeculative?.() === !0 || J !== void 0);
}
function _t() {
	let e = se();
	e === void 0 ? l.owner?.markSpeculativeDeepRead?.() : e.markSpeculativeDeepRead();
}
function vt(e, t) {
	let n = !0;
	return Me(() => {
		for (let t of e) try {
			t.value;
		} catch {}
		n ? n = !1 : t();
	});
}
function yt(e) {
	let t = lt(), n;
	return ft(t, () => {
		n = e.value;
	}), {
		value: n,
		dependencies: t.dependencies,
		attempt: t
	};
}
function bt() {
	return l.owner;
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-runtime-react-adapter.mjs
function X(e) {
	return typeof e == "object" && !!e && e.version === 1 && typeof e.getRevision == "function" && typeof e.subscribe == "function";
}
function xt(e) {
	return X(e) ? e.getRevision() : mt(e);
}
function St(e, t) {
	return X(e) ? e.subscribe(() => t()).unsubscribe : vt([e], t);
}
function Ct(e, t) {
	let n = yt(e);
	return t.current !== void 0 && t.current.dependencies.size === n.dependencies.size && [...n.dependencies].every(([e, n]) => t.current.dependencies.get(e) === n && xt(e) === n) ? t.current.value : (t.current = n, n.value);
}
var wt = class {
	#e;
	#t = /* @__PURE__ */ new Map();
	#n = /* @__PURE__ */ new Set();
	#r = /* @__PURE__ */ new Set();
	#i = 0;
	#a = 0;
	constructor(e) {
		this.#e = e;
	}
	getSnapshot = () => this.#i;
	subscribe = (e) => (this.#r.add(e), () => this.#r.delete(e));
	begin() {
		let e = lt();
		e.restoreScope = dt(e);
		let t = ++this.#a;
		return queueMicrotask(() => {
			this.#a === t && this.finish(e);
		}), e;
	}
	finish(e) {
		e?.restoreScope?.(), e.restoreScope = void 0;
	}
	commit(e) {
		this.finish(e);
		let t = !pt(e), n = e.dependencies;
		if (this.#e === "combined") {
			let e = new Set([...n.keys()].filter((e) => !X(e)));
			e.size === this.#n.size && [...e].every((e) => this.#n.has(e)) || (this.#t.get(this)?.(), this.#t.delete(this), this.#n = e, e.size > 0 && this.#t.set(this, vt([...e], this.#o)));
			for (let [e, t] of this.#t) e !== this && (!X(e) || !n.has(e)) && (t(), this.#t.delete(e));
			for (let e of n.keys()) X(e) && !this.#t.has(e) && this.#t.set(e, St(e, this.#o));
		} else {
			for (let [e, t] of this.#t) n.has(e) || (t(), this.#t.delete(e));
			for (let e of n.keys()) this.#t.has(e) || this.#t.set(e, St(e, this.#o));
		}
		for (let [e, r] of n) xt(e) !== r && (t = !0);
		t && this.#o();
	}
	#o = () => {
		this.#i = this.#i + 1 | 0;
		for (let e of this.#r) e();
	};
	dispose() {
		for (let e of this.#t.values()) e();
		this.#t.clear(), this.#n.clear();
	}
	scheduleDispose() {
		let e = ++this.#a;
		queueMicrotask(() => {
			this.#a === e && this.dispose();
		});
	}
	activate() {
		this.#a += 1;
	}
};
function Tt(r, a) {
	let o = a?.mode ?? r?.mode ?? "combined";
	if (o !== "combined" && o !== "per-readable") throw Error(`Unknown render subscription mode: ${o}`);
	function s(e) {
		let t = n(() => (t) => St(e, t), [e]), r = n(() => ({
			readable: e,
			current: void 0
		}), [e]), a = n(() => () => Ct(e, r), [e, r]);
		return i(t, a, a);
	}
	function c() {
		let r = n(() => new wt(o), []);
		i(r.subscribe, r.getSnapshot, r.getSnapshot);
		let a = r.begin();
		return t(() => {
			r.commit(a);
		}, [r, a]), e(() => (r.activate(), () => r.scheduleDispose()), [r]), {
			store: r,
			attempt: a
		};
	}
	function l() {
		c();
	}
	function u() {
		let { store: e, attempt: t } = c();
		return { finish: () => e.finish(t) };
	}
	return {
		useSignalValue: s,
		useSignalTracking: l,
		useManagedSignals: u
	};
}
function Et(e, t) {
	try {
		return t();
	} finally {
		e.finish();
	}
}
//#endregion
//#region src/core/interop.ts
var Dt = Symbol.for("react-fine-grained-signals.readable-interop.v1"), Ot = Symbol.for("react-fine-grained-signals.shared-interop-context.v1"), Z;
function kt() {
	if (Z !== void 0) return Z;
	let e = globalThis, t = e[Ot];
	if (t !== void 0) {
		if (t.version !== 1 || typeof t.speculativeDepth != "number") throw Error("Incompatible react-fine-grained-signals interop context");
		return Z = t, t;
	}
	let n = {
		version: 1,
		speculativeDepth: 0,
		speculativeDeepReadEpoch: 0
	};
	return Object.defineProperty(e, Ot, {
		value: n,
		enumerable: !1,
		configurable: !1,
		writable: !1
	}), Z = n, n;
}
function At(e) {
	let t = e[Dt];
	if (t === void 0 || typeof t != "object" || !t) return;
	let n = t;
	return n.version === 1 && typeof n.getRevision == "function" && typeof n.subscribe == "function" && typeof n.runtimeToken == "object" && n.runtimeToken !== null ? n : void 0;
}
function jt(e, t) {
	Object.defineProperty(e, Dt, {
		value: t,
		enumerable: !1,
		configurable: !1,
		writable: !1
	});
}
function Mt() {
	return kt().speculativeDepth > 0;
}
function Nt() {
	let e = kt();
	e.speculativeDeepReadEpoch = (e.speculativeDeepReadEpoch ?? 0) + 1;
}
function Pt() {
	return !1;
}
//#endregion
//#region src/core/signal-brand.ts
var Ft = Symbol.for("react-fine-grained-signals.signal");
//#endregion
//#region src/core/deep-signal-engine.ts
function Q(e) {
	return typeof e == "object" && !!e || typeof e == "function";
}
function It(e) {
	if (!Object.isExtensible(e)) throw TypeError("deepSignal() cannot proxy a non-extensible object or array");
}
function Lt(e) {
	for (let t of Reflect.ownKeys(e)) {
		let n = Reflect.getOwnPropertyDescriptor(e, t);
		if (n !== void 0 && !("value" in n)) throw TypeError("deepSignal() does not support accessor properties");
	}
}
function Rt(e) {
	let t = [];
	return t.length = e, t;
}
function zt(e) {
	if (typeof e != "string" || e === "") return !1;
	let t = Number(e);
	return Number.isInteger(t) && t >= 0 && t < 4294967295 && String(t) === e;
}
var $ = (e, t) => {
	let n = e.get(t);
	n !== void 0 && (n.value += 1);
}, Bt = (e, t) => {
	!e.properties.has(t) && !e.existence.has(t) || (e.prunable ??= /* @__PURE__ */ new Set()).add(t);
}, Vt = (e) => {
	e.iteration !== void 0 && (e.iteration.value += 1);
};
function Ht(e) {
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
	]), n = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap(), i = /* @__PURE__ */ new WeakMap(), a = /* @__PURE__ */ new WeakMap(), o = /* @__PURE__ */ new WeakMap(), s = /* @__PURE__ */ new WeakMap(), c = e.isSpeculative ?? Mt, l = e.markSpeculativeDeepRead ?? Nt;
	function u() {
		if (c()) return l(), !1;
		let t = kt();
		return e.hasActiveSubscriber() || Pt() || t.graphCollector !== void 0 || t.renderCollector !== void 0;
	}
	let d = (() => {
		let e = /* @__PURE__ */ new Set();
		for (let t of /* @__PURE__ */ "Object.Array.Function.Boolean.Number.String.Symbol.BigInt.Date.RegExp.Error.AggregateError.EvalError.RangeError.ReferenceError.SyntaxError.TypeError.URIError.Map.Set.WeakMap.WeakSet.WeakRef.FinalizationRegistry.Promise.ArrayBuffer.SharedArrayBuffer.DataView".split(".")) {
			let n = globalThis[t];
			if (typeof n != "function") continue;
			let r = n.prototype;
			(typeof r == "object" && r || typeof r == "function") && e.add(r);
		}
		return e;
	})(), f = (e) => Q(e) && d.has(e);
	function p(t) {
		if (typeof t != "object" || !t || e.isSignal(t) || d.has(t)) return !1;
		if (Array.isArray(t)) return !0;
		let n = Object.getPrototypeOf(t);
		return n === Object.prototype || n === null;
	}
	function m(e) {
		if (!Q(e)) return;
		let t = n.get(e);
		return t === void 0 ? o.get(e) : t;
	}
	function h(e, t, n, r, i, a) {
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
	function g(e) {
		return h(e, i, Map.prototype, "Map", (e, t, n) => ({
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
	function _(e) {
		return h(e, a, Set.prototype, "Set", (e, t, n) => ({
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
				let i = Q(n) ? o.get(n) ?? n : n;
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
	function v(e) {
		if (!p(e)) throw TypeError("deepSignal() only accepts a plain object or array root");
	}
	function y(e) {
		if (!Q(e)) return !1;
		let t = /* @__PURE__ */ new WeakMap(), r = [{
			value: e,
			insideOpaque: !1
		}], i = !1;
		for (; r.length > 0;) {
			let { value: e, insideOpaque: a } = r.pop();
			if (m(e) !== void 0) {
				if (a) throw TypeError(n.has(e) ? "deepSignal() cannot store a deep proxy inside an opaque value" : "deepSignal() cannot store a deep collection view inside an opaque value");
				i = !0;
				continue;
			}
			let o = e, s = t.get(o) ?? 0, c = a ? 2 : 1;
			if ((s & c) === 0) {
				if (t.set(o, s | c), !a && f(o)) throw TypeError("deepSignal() cannot store a built-in prototype object in deep state");
				if (o instanceof Map) {
					for (let [e, t] of o) Q(e) && r.push({
						value: e,
						insideOpaque: !0
					}), Q(t) && r.push({
						value: t,
						insideOpaque: !0
					});
					continue;
				}
				if (o instanceof Set) {
					for (let e of o) Q(e) && r.push({
						value: e,
						insideOpaque: !0
					});
					continue;
				}
				if (!p(o)) {
					for (let e of Reflect.ownKeys(o)) {
						let t = Reflect.getOwnPropertyDescriptor(o, e);
						t !== void 0 && "value" in t && Q(t.value) && r.push({
							value: t.value,
							insideOpaque: !0
						});
					}
					continue;
				}
				a || (It(o), Lt(o));
				for (let e of Reflect.ownKeys(o)) {
					let t = Reflect.getOwnPropertyDescriptor(o, e);
					if (t !== void 0 && "value" in t) {
						let e = t.value;
						Q(e) && r.push({
							value: e,
							insideOpaque: a
						});
					}
				}
			}
		}
		return i;
	}
	function b(e, t) {
		let n = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap(), i = [[e, t]];
		for (; i.length > 0;) {
			let [e, t] = i.pop();
			if (typeof e != "object" || !e) {
				if (!Object.is(e, t)) return !1;
				continue;
			}
			let a = m(e);
			if (a !== void 0) {
				if (a !== t) return !1;
				continue;
			}
			if (!p(e)) {
				if (e !== t) return !1;
				continue;
			}
			if (typeof t != "object" || !t || !p(t)) return !1;
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
	function x(e) {
		let t = m(e);
		if (t !== void 0) return t;
		if (!Q(e)) return e;
		let n = s.get(e);
		if (n !== void 0 && b(e, n)) return n;
		let r = /* @__PURE__ */ new WeakMap(), i = [], a = [], o = (e) => {
			let t = m(e);
			if (t !== void 0) return t;
			if (!p(e)) return e;
			let n = r.get(e);
			if (n !== void 0) return n;
			let o = Array.isArray(e) ? Rt(e.length) : Object.create(Object.getPrototypeOf(e));
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
	function S(e) {
		let t = m(e);
		return t === void 0 ? y(e) ? x(e) : e : t;
	}
	let C = (e) => S(e), w = new Set(Reflect.ownKeys(Object.prototype)), T = /* @__PURE__ */ new Set([...Reflect.ownKeys(Object.prototype), ...Reflect.ownKeys(Array.prototype)]), E = (e, t) => {
		if (Object.prototype.hasOwnProperty.call(e, t)) return !1;
		let n = Object.getPrototypeOf(e);
		return n === Object.prototype ? w.has(t) : n === Array.prototype && T.has(t);
	}, D = (t, n) => {
		let r = t.get(n);
		return r === void 0 && (r = e.createSignal(0), t.set(n, r)), r;
	}, O = (t, n, r, i) => {
		if (!u() || E(t, i)) return;
		zt(i) && r.add(Number(i));
		let a = D(n, i);
		e.markWatched(a), a.value;
	}, k = (t, n) => {
		let r = t.prunable;
		if (r !== void 0 && r.size !== 0 && e.getBatchDepth() === 0) {
			for (let i of r) {
				if (Object.prototype.hasOwnProperty.call(n, i)) {
					r.delete(i);
					continue;
				}
				let a = t.properties.get(i), o = t.existence.get(i);
				if (!(a !== void 0 && e.hasSubscribers(a) || o !== void 0 && e.hasSubscribers(o))) {
					if (t.properties.delete(i), t.existence.delete(i), zt(i)) {
						let e = Number(i);
						t.propertyIndices.delete(e), t.existenceIndices.delete(e);
					}
					r.delete(i);
				}
			}
			r.size === 0 && (t.prunable = void 0);
		}
	}, A = (t) => {
		u() && (t.iteration ??= e.createSignal(0), t.iteration.value);
	}, j = (e, t, n) => {
		let r = n - t, i = e.propertyIndices.size + e.existenceIndices.size;
		if (i !== 0) {
			if (r <= i) {
				for (let r = t; r < n; r++) {
					let t = String(r);
					$(e.properties, t), $(e.existence, t), Bt(e, t);
				}
				return;
			}
			for (let r of e.propertyIndices) if (r >= t && r < n) {
				let t = String(r);
				$(e.properties, t), Bt(e, t);
			}
			for (let r of e.existenceIndices) if (r >= t && r < n) {
				let t = String(r);
				$(e.existence, t), Bt(e, t);
			}
		}
	}, M = (e) => p(e) || e instanceof Map || e instanceof Set, N = (i) => {
		let a = m(i) ?? i;
		if (a instanceof Map) return g(a);
		if (a instanceof Set) return _(a);
		if (!p(a)) return a;
		It(a);
		let o = r.get(a);
		if (o !== void 0) return o.proxy;
		Lt(a);
		let s = {
			properties: /* @__PURE__ */ new Map(),
			existence: /* @__PURE__ */ new Map(),
			propertyIndices: /* @__PURE__ */ new Set(),
			existenceIndices: /* @__PURE__ */ new Set(),
			arrayMethods: /* @__PURE__ */ new Map(),
			proxy: void 0
		}, c = new Proxy(a, {
			get(n, r, i) {
				if (r === Ft && !Object.prototype.hasOwnProperty.call(n, r)) return;
				O(n, s.properties, s.propertyIndices, r);
				let a = Reflect.get(n, r, i);
				if (Array.isArray(n) && t.has(r) && typeof a == "function") {
					let t = s.arrayMethods.get(r);
					if (t?.method === a) return t.wrapper;
					let i = a, o = function(...t) {
						try {
							return e.batch(() => Reflect.apply(i, this, t));
						} finally {
							k(s, n);
						}
					};
					return s.arrayMethods.set(r, {
						method: i,
						wrapper: o
					}), o;
				}
				if (M(a)) {
					let e = Reflect.getOwnPropertyDescriptor(n, r);
					if (e !== void 0 && "value" in e && e.configurable === !1 && e.writable === !1) throw TypeError("deepSignal() cannot wrap a non-configurable, non-writable object property");
				}
				return N(a);
			},
			set(t, n, r) {
				if (n === "__proto__") throw TypeError("deepSignal() does not support prototype mutation");
				if (n === Ft) throw TypeError("deepSignal() does not support branding state as a signal");
				let i = Reflect.get(t, n, t), a = Reflect.has(t, n), o = Object.prototype.hasOwnProperty.call(t, n), c = Array.isArray(t) ? t.length : void 0, l = C(r);
				if (!Reflect.set(t, n, l, t)) return !1;
				let u = Reflect.get(t, n, t), d = Reflect.has(t, n), f = Object.prototype.hasOwnProperty.call(t, n);
				return e.batch(() => {
					if ((!Object.is(i, u) || o !== f) && $(s.properties, n), a !== d && $(s.existence, n), o !== f && Vt(s), Array.isArray(t) && c !== void 0) {
						let e = t.length;
						n !== "length" && c !== e && $(s.properties, "length"), n === "length" && e < c && (j(s, e, c), Vt(s));
					}
				}), k(s, t), !0;
			},
			deleteProperty(t, n) {
				let r = Reflect.has(t, n), i = Object.prototype.hasOwnProperty.call(t, n), a = Reflect.deleteProperty(t, n);
				return !a || !i ? a : (e.batch(() => {
					$(s.properties, n), r !== Reflect.has(t, n) && $(s.existence, n), Vt(s), Bt(s, n);
				}), k(s, t), !0);
			},
			getOwnPropertyDescriptor(e, t) {
				O(e, s.properties, s.propertyIndices, t);
				let n = Reflect.getOwnPropertyDescriptor(e, t);
				return n === void 0 || !("value" in n) || n.configurable === !1 && n.writable === !1 || (n.value = N(n.value)), n;
			},
			has(e, t) {
				return O(e, s.existence, s.existenceIndices, t), Reflect.has(e, t);
			},
			ownKeys(e) {
				return A(s), Reflect.ownKeys(e);
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
	class P {
		#e;
		constructor(e) {
			this.#e = e;
			let t = At(this.#e);
			t !== void 0 && jt(this, t);
		}
		get value() {
			return N(this.#e.value);
		}
		set value(e) {
			let t = C(e);
			v(t), this.#e.value = t;
		}
		peek() {
			return this.#e.peek();
		}
	}
	function F(e) {
		let t = r.get(m(e) ?? e);
		if (t !== void 0) return {
			properties: [...t.properties.keys()],
			existence: [...t.existence.keys()],
			propertyIndices: [...t.propertyIndices],
			existenceIndices: [...t.existenceIndices]
		};
	}
	function I(t) {
		let n = S(t);
		v(n), N(n);
		let r = e.createSignal(n), i = new P(r);
		return e.registerDeepSignal?.(i), i;
	}
	return {
		deepSignal: I,
		inspectDeepSignalMetadata: F
	};
}
//#endregion
//#region benchmarks/phase9/m15/alien-derived-deep-signal-owner-engine.ts
var Ut = /* @__PURE__ */ new WeakSet(), Wt = Ht({
	createSignal: qe,
	markWatched(e) {
		Ut.add(e);
	},
	hasSubscribers: fe,
	batch: Ne,
	isSignal: it,
	hasActiveSubscriber() {
		let e = bt();
		return pe() || e?.kind === "graph" || e?.kind === "render";
	},
	getBatchDepth: me,
	isSpeculative: gt,
	markSpeculativeDeepRead: _t,
	registerDeepSignal(e) {
		Object.defineProperty(e, q, {
			value: 1,
			enumerable: !1,
			writable: !1,
			configurable: !1
		});
	}
}), Gt = Wt.deepSignal, Kt = Wt.inspectDeepSignalMetadata;
//#endregion
//#region benchmarks/phase9/m15/deep-selector-react-hook.mjs
function qt(e) {
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
function Jt(e) {
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
export { q as SIGNAL_BRAND, Ne as batch, yt as captureRenderSnapshot, je as computed, tt as computedClassBrandDirect, et as computedClassBrandHelper, $e as computedClassBrandWeakSet, ae as configureRenderAdapter, Jt as createDeepSelectorHook, Tt as createReactAdapter, lt as createRenderAttempt, qt as createSignalValueHook, Gt as deepSignal, Me as effect, se as getActiveRenderAttempt, me as getBatchDepth, bt as getExecutionOwner, ce as getNodeForReadable, le as getReadableRevision, mt as getRenderVersion, ht as hasActiveRenderOwner, pe as hasActiveSubscriber, fe as hasSubscribers, Kt as inspectDeepSignalMetadata, ue as isComputedClean, at as isSignalBrandDirect, it as isSignalBrandHelper, rt as isSignalBrandWeakSet, gt as isSpeculative, Et as managed, _t as markSpeculativeDeepRead, de as promoteComputed, pt as promoteRenderAttempt, H as pushRenderAttempt, dt as pushRenderScope, T as runtimeToken, we as signal, Te as signalBoundAccessor, Je as signalClassBrandDirect, qe as signalClassBrandHelper, Ke as signalClassBrandWeakSet, ke as signalClassHelper, Ae as signalClassInline, Ee as signalInlineAccessor, vt as subscribeReadables, K as untracked, oe as withRenderAttempt, ft as withRenderScope };
