/*
 * M1.5 Core Candidate: Alien-derived graph + Object.is + one-object public brand + computed error cache/recovery.
 *
 * M1.5 disposable baseline prototype, derived from Alien Signals 3.2.1.
 * Reference: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See ALIEN-SIGNALS-LICENSE.txt.
 *
 * This intentionally small harness-only port retains Alien's lazy computed,
 * pending signal values, push/pull graph, synchronous effect queue, batching,
 * and linked-list dependency cleanup. It imports only Alien's low-level
 * `alien-signals/system` entry. It is not production code and does not yet
 * implement RFSG's rendering, interop, error, deep-signal, or lifecycle rules.
 */
import { createReactiveSystem, ReactiveFlags } from "alien-signals/system";
import { activeAttempt, activeDependencyCollector, createRenderAttempt, getRenderAttempt, getRenderCollector, trackReadable, withRenderAttempt, withRenderDependencyCollector, withoutRenderAttempt, withoutRenderCollection } from "./render-context.mjs";
import { getSharedInteropContext, READABLE_INTEROP_V1 } from "./alien-derived-runtime-interop-context.mjs";
export { READABLE_INTEROP_V1 };

const { None, Mutable, Watching, RecursedCheck, Recursed, Dirty, Pending } = ReactiveFlags;
const HasChildEffect = 64;
export const runtimeToken = {};
const sharedInterop = getSharedInteropContext();

let activeSub;
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let flushIndex = 0;
let queuedLength = 0;
const queue = [];
const localProtocols = new WeakMap();
const foreignNodes = new WeakMap();
const nodeProtocols = new WeakMap();
const deepSignalWatched = new WeakSet();

const system = createReactiveSystem({
  update(node) {
    if (node.kind === "external") {
      const changed = node.revision !== node.pendingRevision;
      node.revision = node.pendingRevision;
      node.flags = Mutable;
      return changed;
    }
    if (node.kind === "computed") return updateComputed(node);
    if (node.kind === "source") return updateSource(node);
    node.flags = Mutable;
    return true;
  },
  notify(effect) {
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queue[insertIndex++] = effect;
      effect.flags &= ~Watching;
      effect = effect.subs?.sub;
      if (effect === undefined || !(effect.flags & Watching)) break;
    // This queue walk intentionally advances until its linked-list sentinel.
    // oxlint-disable-next-line no-constant-condition
    } while (true);
    queuedLength = insertIndex;
    let leftIndex = firstInsertedIndex;
    while (leftIndex < --insertIndex) {
      const left = queue[leftIndex];
      queue[leftIndex++] = queue[insertIndex];
      queue[insertIndex] = left;
    }
  },
  unwatched(node) {
    if (node.kind === "external") {
      node.subscription?.unsubscribe();
      node.subscription = undefined;
      return;
    }
    if (node.kind === "computed") {
      if (node.depsTail !== undefined) {
        node.flags = Mutable | Dirty;
        disposeDeps(node);
      }
    } else if (node.kind === "effect") {
      disposeEffect(node);
    }
  },
});
const { link, unlink, propagate, checkDirty, shallowPropagate } = system;

const graphCollector = {
  runtimeToken,
  add(protocol, observedRevision) {
    if (protocol.runtimeToken === runtimeToken || activeSub === undefined) return;
    let node = foreignNodes.get(protocol);
    if (node === undefined) {
      node = makeNode("external", Mutable, {
        protocol,
        revision: observedRevision,
        pendingRevision: observedRevision,
        subscription: undefined,
      });
      foreignNodes.set(protocol, node);
    }
    node.pendingRevision = observedRevision;
    link(node, activeSub, cycle);
    if (node.subscription === undefined) {
      try {
        const subscription = protocol.subscribe((revision) => {
          if (revision === node.revision || revision === node.pendingRevision) return;
          node.pendingRevision = revision;
          node.flags = Mutable | Dirty;
          if (node.subs !== undefined) {
            propagate(node.subs, !!runDepth);
            if (!batchDepth) flush();
          }
        });
        node.subscription = subscription;
        if (subscription.revision !== node.revision) {
          node.pendingRevision = subscription.revision;
          node.flags = Mutable | Dirty;
          if (node.subs !== undefined) {
            propagate(node.subs, !!runDepth);
            if (!batchDepth) flush();
          }
        }
      } catch (error) {
        reportFailure(error);
      }
    }
  },
};

function publishGraphRead(node) {
  const collector = sharedInterop.graphCollector;
  if (collector === undefined || collector.runtimeToken === runtimeToken) return;
  const protocol = nodeProtocols.get(node);
  if (protocol !== undefined) collector.add(protocol, node.renderRevision);
}

function publishRenderRead(readable, node) {
  const collector = sharedInterop.renderCollector;
  if (collector === undefined || collector.runtimeToken === runtimeToken) return;
  const protocol = localProtocols.get(readable);
  if (protocol !== undefined) collector.add(protocol, node.renderRevision);
}

function withTrackedGraph(subscriber, callback) {
  const previousSub = activeSub;
  const previousCollector = sharedInterop.graphCollector;
  activeSub = subscriber;
  sharedInterop.graphCollector = graphCollector;
  try { return callback(); }
  finally {
    activeSub = previousSub;
    sharedInterop.graphCollector = previousCollector;
  }
}

function withDurableEffectGraph(subscriber, callback) {
  const previousRenderCollector = sharedInterop.renderCollector;
  const previousSpeculativeDepth = sharedInterop.speculativeDepth;
  sharedInterop.renderCollector = undefined;
  sharedInterop.speculativeDepth = 0;
  try {
    return withoutRenderAttempt(() => withTrackedGraph(subscriber, callback));
  } finally {
    sharedInterop.speculativeDepth = previousSpeculativeDepth;
    sharedInterop.renderCollector = previousRenderCollector;
  }
}

function makeNode(kind, flags, fields = {}) {
  return { kind, flags, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, renderRevision: 0, ...fields };
}

class RuntimeReadableInterop {
  #readable;
  #node;
  constructor(readable, node) {
    this.#readable = readable;
    this.#node = node;
    this.runtimeToken = runtimeToken;
    Object.freeze(this);
  }
  get version() { return 1; }
  getRevision() { return this.#node.renderRevision; }
  subscribe(listener) {
    let initial = true;
    const dispose = effect(() => {
      try { this.#readable.value; } catch { /* Keep errored computed boundaries observed. */ }
      if (initial) initial = false;
      else listener(this.#node.renderRevision);
    });
    return { unsubscribe: dispose, revision: this.#node.renderRevision };
  }
}

function attachProtocol(readable, node) {
  const protocol = new RuntimeReadableInterop(readable, node);
  localProtocols.set(readable, protocol);
  nodeProtocols.set(node, protocol);
  Object.defineProperty(readable, READABLE_INTEROP_V1, {
    value: protocol,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

function readSource(source) {
  if (source.flags & Dirty && updateSource(source)) {
    if (source.subs !== undefined) shallowPropagate(source.subs);
  }
  if (activeSub !== undefined) link(source, activeSub, cycle);
  publishGraphRead(source);
  return source.currentValue;
}

function updateSource(source) {
  source.flags = Mutable;
  const changed = !Object.is(source.currentValue, source.currentValue = source.pendingValue);
  return changed;
}

function readComputed(computed) {
  const flags = computed.flags;
  if (flags & Dirty || (flags & Pending && (checkDirty(computed.deps, computed) || (computed.flags = flags & ~Pending, false)))) {
    if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
  } else if (!flags) {
    updateComputed(computed);
  }
  if (activeSub !== undefined) link(computed, activeSub, cycle);
  publishGraphRead(computed);
  if (computed.hasError) throw computed.error;
  return computed.value;
}

function updateComputed(computed) {
  if (computed.flags & HasChildEffect) disposeChildEffects(computed);
  computed.depsTail = undefined;
  computed.flags = Mutable | RecursedCheck;
  const previous = activeSub;
  activeSub = computed;
  let changed = !computed.initialized;
  const hadError = computed.hasError;
  const previousValue = computed.value;
  try {
    cycle += 1;
    try {
      computed.value = withTrackedGraph(computed, () => computed.getter(previousValue));
      computed.error = undefined;
      computed.hasError = false;
    } catch (error) {
      computed.value = undefined;
      computed.error = error;
      computed.hasError = true;
    }
    computed.initialized = true;
    changed = changed || hadError || computed.hasError || !Object.is(previousValue, computed.value);
    if (changed) computed.renderRevision = (computed.renderRevision + 1) | 0;
    return changed;
  } finally {
    activeSub = previous;
    computed.flags &= ~RecursedCheck;
    purgeDeps(computed);
  }
}

function writeSource(source, value) {
  if (!Object.is(source.pendingValue, source.pendingValue = value)) {
    source.renderRevision = (source.renderRevision + 1) | 0;
    source.flags = Mutable | Dirty;
    if (source.subs !== undefined) {
      propagate(source.subs, !!runDepth);
      if (!batchDepth) flush();
    }
  }
}

function runEffect(effect) {
  const flags = effect.flags;
  if (flags & Dirty || (flags & Pending && checkDirty(effect.deps, effect))) {
    if (flags & HasChildEffect) disposeChildEffects(effect);
    if (effect.cleanup !== undefined) {
      try {
        runCleanup(effect);
      } catch (error) {
        // The cleanup has been consumed. Keep the existing dependencies live so
        // a later source change can retry the effect body.
        effect.flags = Watching | (flags & HasChildEffect);
        throw error;
      }
      if (!effect.flags) return;
    }
    effect.depsTail = undefined;
    effect.flags = Watching | RecursedCheck;
    const previous = activeSub;
    activeSub = effect;
    try {
      cycle += 1;
      runDepth += 1;
      const cleanup = withDurableEffectGraph(effect, effect.fn);
      effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    } finally {
      runDepth -= 1;
      activeSub = previous;
      effect.flags &= ~RecursedCheck;
      purgeDeps(effect);
    }
  } else if (effect.deps !== undefined) {
    effect.flags = Watching | (flags & HasChildEffect);
  }
}

function flush() {
  try {
    while (flushIndex < queuedLength) {
      const effect = queue[flushIndex];
      queue[flushIndex++] = undefined;
      try {
        runEffect(effect);
      } catch (error) {
        reportFailure(error);
      }
    }
  } finally {
    while (flushIndex < queuedLength) {
      const effect = queue[flushIndex];
      queue[flushIndex++] = undefined;
      effect.flags |= Watching | Recursed;
    }
    flushIndex = 0;
    queuedLength = 0;
  }
}

function reportFailure(error) {
  try {
    console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: error });
  } catch { /* Reporting must not interrupt scheduler progress. */ }
  try {
    const report = globalThis.reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch { /* Keep a failing host reporter from escaping the runtime. */ }
}

function disposeChildEffects(parent) {
  let depLink = parent.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    if (depLink.dep.kind === "effect") unlink(depLink, parent);
    depLink = previous;
  }
}

function disposeDeps(sub) {
  let depLink = sub.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    unlink(depLink, sub);
    depLink = previous;
  }
}

function purgeDeps(sub) {
  const tail = sub.depsTail;
  let depLink = tail === undefined ? sub.deps : tail.nextDep;
  while (depLink !== undefined) depLink = unlink(depLink, sub);
}

function runCleanup(effect) {
  const cleanup = effect.cleanup;
  effect.cleanup = undefined;
  const previous = activeSub;
  const previousRenderCollector = sharedInterop.renderCollector;
  const previousSpeculativeDepth = sharedInterop.speculativeDepth;
  activeSub = undefined;
  sharedInterop.renderCollector = undefined;
  sharedInterop.speculativeDepth = 0;
  try {
    withoutRenderAttempt(cleanup);
  } finally {
    sharedInterop.speculativeDepth = previousSpeculativeDepth;
    sharedInterop.renderCollector = previousRenderCollector;
    activeSub = previous;
  }
}

function disposeEffect(effect) {
  effect.flags = None;
  disposeDeps(effect);
  if (effect.cleanup !== undefined) {
    try { runCleanup(effect); }
    catch (error) { reportFailure(error); }
  }
}

export function signal(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return {
    get value() { return readSource(node); },
    set value(value) { writeSource(node, value); },
    peek() { return untracked(() => readSource(node)); },
  };
}

// Alternative 2: preserve the public object/accessor shape, but have its
// accessors call a bound Alien-style signalOper directly on the private node.
export function signalBoundAccessor(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  function signalOper(...value) {
    if (value.length) {
      if (!Object.is(this.pendingValue, this.pendingValue = value[0])) {
        this.flags = Mutable | Dirty;
        const subscribers = this.subs;
        if (subscribers !== undefined) {
          propagate(subscribers, !!runDepth);
          if (!batchDepth) flush();
        }
      }
    } else {
      if (this.flags & Dirty && updateSource(this) && this.subs !== undefined) shallowPropagate(this.subs);
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
  }
  const operate = signalOper.bind(node);
  const readable = { peek() { return untracked(() => operate()); } };
  Object.defineProperty(readable, "value", {
    get: operate,
    set: operate,
    enumerable: true,
  });
  return readable;
}

// Alternative 3: preserve the public object/accessor shape and inline the
// signal read/write bodies to remove both helper dispatch and bound-call path.
export function signalInlineAccessor(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return {
    get value() {
      if (node.flags & Dirty) {
        node.flags = Mutable;
        if (!Object.is(node.currentValue, node.currentValue = node.pendingValue)) {
          const subscribers = node.subs;
          if (subscribers !== undefined) shallowPropagate(subscribers);
        }
      }
      if (activeSub !== undefined) link(node, activeSub, cycle);
      return node.currentValue;
    },
    set value(value) {
      if (!Object.is(node.pendingValue, node.pendingValue = value)) {
        node.flags = Mutable | Dirty;
        const subscribers = node.subs;
        if (subscribers !== undefined) {
          propagate(subscribers, !!runDepth);
          if (!batchDepth) flush();
        }
      }
    },
    peek() {
      return untracked(() => {
        if (node.flags & Dirty) {
          node.flags = Mutable;
          if (!Object.is(node.currentValue, node.currentValue = node.pendingValue)) {
            const subscribers = node.subs;
            if (subscribers !== undefined) shallowPropagate(subscribers);
          }
        }
        if (activeSub !== undefined) link(node, activeSub, cycle);
        return node.currentValue;
      });
    },
  };
}

class SharedHelperReadable {
  #node;

  constructor(node) { this.#node = node; }
  get value() { return readSource(this.#node); }
  set value(value) { writeSource(this.#node, value); }
  peek() { return untracked(() => readSource(this.#node)); }
}

class SharedInlineReadable {
  #node;

  constructor(node) { this.#node = node; }
  get value() {
    const node = this.#node;
    if (node.flags & Dirty) {
      node.flags = Mutable;
      if (!Object.is(node.currentValue, node.currentValue = node.pendingValue)) {
        const subscribers = node.subs;
        if (subscribers !== undefined) shallowPropagate(subscribers);
      }
    }
    if (activeSub !== undefined) link(node, activeSub, cycle);
    return node.currentValue;
  }
  set value(value) {
    const node = this.#node;
    if (!Object.is(node.pendingValue, node.pendingValue = value)) {
      node.flags = Mutable | Dirty;
      const subscribers = node.subs;
      if (subscribers !== undefined) {
        propagate(subscribers, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }
  peek() { return untracked(() => this.value); }
}

export function signalClassHelper(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new SharedHelperReadable(node);
}

export function signalClassInline(initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new SharedInlineReadable(node);
}

export function computed(getter) {
  const node = makeNode("computed", None, { getter, value: undefined, error: undefined, hasError: false, initialized: false });
  return Object.freeze({
    get value() { return readComputed(node); },
    peek() { return untracked(() => readComputed(node)); },
  });
}

export function effect(fn) {
  const node = makeNode("effect", Watching | RecursedCheck, { fn, cleanup: undefined });
  const previous = activeSub;
  if (previous !== undefined) {
    link(node, previous, 0);
    previous.flags |= HasChildEffect;
  }
  try {
    activeSub = node;
    runDepth += 1;
    try {
      const cleanup = withDurableEffectGraph(node, fn);
      node.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    } catch (error) {
      node.cleanup = undefined;
      reportFailure(error);
    } finally {
      runDepth -= 1;
      activeSub = previous;
      node.flags &= ~RecursedCheck;
      purgeDeps(node);
    }
  } catch (error) {
    // Keep setup failures from escaping even if bookkeeping itself fails.
    reportFailure(error);
  }
  return () => disposeEffect(node);
}

export function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (!batchDepth) flush();
  }
}

export function untracked(fn) {
  const previous = activeSub;
  const previousGraphCollector = sharedInterop.graphCollector;
  const previousRenderCollector = sharedInterop.renderCollector;
  const previousSpeculativeDepth = sharedInterop.speculativeDepth;
  activeSub = undefined;
  sharedInterop.graphCollector = undefined;
  sharedInterop.renderCollector = undefined;
  sharedInterop.speculativeDepth = 0;
  try {
    return withoutRenderAttempt(() => withoutRenderCollection(fn));
  } finally {
    activeSub = previous;
    sharedInterop.graphCollector = previousGraphCollector;
    sharedInterop.renderCollector = previousRenderCollector;
    sharedInterop.speculativeDepth = previousSpeculativeDepth;
  }
}

const renderNodes = new WeakMap();
const speculativeComputedCaches = new WeakMap();
const speculativeComputing = new WeakMap();
const sharedSpeculativeComputedCaches = new WeakMap();
let activeSpeculativeComputed;

function findReusableSpeculativeComputed(node) {
  const entries = sharedSpeculativeComputedCaches.get(node);
  if (entries === undefined) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    let current = true;
    for (const [dependency, revision] of entry.dependencies) {
      try {
        if (getRenderVersion(dependency) !== revision) { current = false; break; }
      } catch {
        current = false;
        break;
      }
    }
    if (current) return entry;
  }
  return undefined;
}

function saveSharedSpeculativeComputed(node, entry) {
  const entries = sharedSpeculativeComputedCaches.get(node) ?? [];
  entries.push(entry);
  // A few signatures cover short concurrent/transition overlap without making
  // the per-node cache grow with every historical dependency combination.
  if (entries.length > 4) entries.shift();
  sharedSpeculativeComputedCaches.set(node, entries);
}

// A speculative result is promoted only from React's commit phase. Every
// dependency must still have the revision observed by that render and must be
// a local readable whose node can be linked into this runtime's graph.
export function promoteRenderAttempt(attempt) {
  const cache = speculativeComputedCaches.get(attempt);
  if (cache === undefined) return true;
  for (const [computed, entry] of cache) {
    if (!entry.canPromote || computed.initialized) continue;
    const dependencies = [];
    for (const [readable, revision] of entry.dependencies) {
      let current;
      try { current = getRenderVersion(readable); }
      catch { return false; }
      if (current !== revision) return false;
      const dependency = renderNodes.get(readable);
      if (dependency === undefined) return false;
      dependencies.push(dependency);
    }
    disposeDeps(computed);
    computed.depsTail = undefined;
    const previousSub = activeSub;
    activeSub = computed;
    cycle += 1;
    try {
      for (const dependency of dependencies) link(dependency, computed, cycle);
    } finally {
      activeSub = previousSub;
    }
    computed.value = entry.value;
    computed.error = entry.error;
    computed.hasError = entry.hasError;
    computed.initialized = true;
    computed.flags = Mutable;
  }
  return true;
}

// Public API/brand candidates. Each public object is the readable class
// instance itself; no outer wrapper, interop protocol, or per-instance methods.
export const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
const BRAND_VERSION = 1;
const MIN_BRAND_VERSION = 1;
const brandedLocals = new WeakSet();
const brandDescriptor = () => ({ value: BRAND_VERSION, enumerable: false, writable: false, configurable: false });
function registerWeakSetBrand(value) {
  brandedLocals.add(value);
  Object.defineProperty(value, SIGNAL_BRAND, brandDescriptor());
}
function registerHelperBrand(value) {
  Object.defineProperty(value, SIGNAL_BRAND, brandDescriptor());
}

function inlineRead(node) {
  if (node.flags & Dirty) {
    node.flags = Mutable;
    if (!Object.is(node.currentValue, node.currentValue = node.pendingValue)) {
      const subscribers = node.subs;
      if (subscribers !== undefined) shallowPropagate(subscribers);
    }
  }
  if (activeSub !== undefined) link(node, activeSub, cycle);
  return node.currentValue;
}
function inlineWrite(node, value) {
  if (!Object.is(node.pendingValue, node.pendingValue = value)) {
    node.renderRevision = (node.renderRevision + 1) | 0;
    node.flags = Mutable | Dirty;
    const subscribers = node.subs;
    if (subscribers !== undefined) {
      propagate(subscribers, !!runDepth);
      if (!batchDepth) flush();
    }
  }
}

class WeakSetSignal {
  #node;
  constructor(node) { this.#node = node; registerWeakSetBrand(this); }
  get value() { return inlineRead(this.#node); }
  set value(value) { inlineWrite(this.#node, value); }
  peek() { return untracked(() => this.value); }
}
class HelperBrandSignal {
  #node;
  constructor(node) { this.#node = node; registerHelperBrand(this); renderNodes.set(this, node); attachProtocol(this, node); }
  get value() {
    const node = this.#node;
    if (node.renderReadMode === "helper-call") {
      const attempt = getRenderAttempt();
      if (attempt !== undefined) {
        getRenderCollector()?.add(this, node.renderRevision);
        if (attempt.runtimeToken !== undefined && attempt.runtimeToken !== runtimeToken) publishRenderRead(this, node);
        return node.flags & Dirty ? node.pendingValue : node.currentValue;
      }
      const value = inlineRead(node);
      publishGraphRead(node);
      trackReadable(this, node.renderRevision);
      return value;
    }
    if (activeAttempt === undefined) {
      const value = inlineRead(node);
      if (sharedInterop.graphCollector !== undefined && sharedInterop.graphCollector.runtimeToken !== runtimeToken) {
        publishGraphRead(node);
      }
      return value;
    }
    const attempt = activeAttempt;
    if (attempt !== undefined) {
      if (activeDependencyCollector !== undefined) {
        if (attempt.runtimeToken === undefined || attempt.runtimeToken === runtimeToken || activeDependencyCollector !== attempt) {
          trackReadable(this, node.renderRevision);
        }
      }
      if (attempt.runtimeToken !== undefined && attempt.runtimeToken !== runtimeToken) publishRenderRead(this, node);
      // A render observes the newest pending value, but does not settle the
      // live Alien node (flags/currentValue/subscriber propagation).
      return node.flags & Dirty ? node.pendingValue : node.currentValue;
    }
    const value = inlineRead(node);
    publishGraphRead(node);
    if (activeDependencyCollector !== undefined) trackReadable(this, node.renderRevision);
    return value;
  }
  set value(value) { inlineWrite(this.#node, value); }
  peek() { return untracked(() => this.value); }
}
class DirectBrandSignal {
  #node;
  constructor(node) {
    this.#node = node;
    Object.defineProperty(this, SIGNAL_BRAND, { value: BRAND_VERSION, enumerable: false, writable: false, configurable: false });
  }
  get value() { return inlineRead(this.#node); }
  set value(value) { inlineWrite(this.#node, value); }
  peek() { return untracked(() => this.value); }
}

function createBrandedSignal(makeReadable, initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new makeReadable(node);
}
export const signalClassBrandWeakSet = (initialValue) => createBrandedSignal(WeakSetSignal, initialValue);
export const signalClassBrandHelper = (initialValue) => createBrandedSignal(HelperBrandSignal, initialValue);
export const signalClassBrandDirect = (initialValue) => createBrandedSignal(DirectBrandSignal, initialValue);
export const signalClassBrandHelperCalls = (initialValue) => {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue, renderReadMode: "helper-call" });
  return new HelperBrandSignal(node);
};

class WeakSetComputed {
  #node;
  constructor(node) { this.#node = node; registerWeakSetBrand(this); }
  get value() { return readComputed(this.#node); }
  peek() { return untracked(() => readComputed(this.#node)); }
}
class HelperBrandComputed {
  #node;
  constructor(node) { this.#node = node; registerHelperBrand(this); renderNodes.set(this, node); attachProtocol(this, node); }
  // The getter's speculative/live branches all return or rethrow; the static
  // control-flow rule cannot follow the deliberate `try/finally` promotion.
  // oxlint-disable-next-line getter-return
  get value() {
    const node = this.#node;
    if (node.initialized && !(node.flags & (Dirty | Pending))) {
      if (activeSub !== undefined) link(node, activeSub, cycle);
      publishGraphRead(node);
      trackReadable(this, node.renderRevision);
      if (activeAttempt?.runtimeToken !== undefined && activeAttempt.runtimeToken !== runtimeToken) publishRenderRead(this, node);
      if (node.hasError) throw node.error;
      return node.value;
    }
    if (activeAttempt !== undefined) {
      if (activeSpeculativeComputed !== undefined && activeSpeculativeComputed !== node) {
        const previousRenderCollector = sharedInterop.renderCollector;
        const previousSpeculativeDepth = sharedInterop.speculativeDepth;
        sharedInterop.renderCollector = undefined;
        sharedInterop.speculativeDepth = 0;
        let value;
        try { value = withoutRenderAttempt(() => readComputed(node)); }
        finally {
          sharedInterop.speculativeDepth = previousSpeculativeDepth;
          sharedInterop.renderCollector = previousRenderCollector;
        }
        trackReadable(this, node.renderRevision);
        publishGraphRead(node);
        return value;
      }
      const attempt = activeAttempt;
      let cache = speculativeComputedCaches.get(attempt);
      if (cache === undefined) speculativeComputedCaches.set(attempt, cache = new Map());
      let cached = cache.get(node);
      if (cached === undefined) {
        cached = findReusableSpeculativeComputed(node);
        if (cached !== undefined) cache.set(node, cached);
      }
      if (cached === undefined) {
        const dependencies = new Map();
        let computing = speculativeComputing.get(attempt);
        if (computing === undefined) speculativeComputing.set(attempt, computing = new Set());
        if (computing.has(node)) throw new Error("Computed cycle detected");
        computing.add(node);
        const previousSpeculativeComputed = activeSpeculativeComputed;
        activeSpeculativeComputed = node;
        try {
          const deepReadEpoch = sharedInterop.speculativeDeepReadEpoch;
          try {
            const context = sharedInterop;
            const previousSpeculativeDepth = context.speculativeDepth;
            context.speculativeDepth = previousSpeculativeDepth + 1;
            let value;
            try {
              value = withRenderDependencyCollector({ add(readable, version) { if (!dependencies.has(readable)) dependencies.set(readable, version); } }, () => node.getter(node.value));
            } finally {
              context.speculativeDepth = previousSpeculativeDepth;
            }
            cached = { hasError: false, value, error: undefined, dependencies, canPromote: false };
          } catch (error) {
            cached = { hasError: true, value: undefined, error, dependencies, canPromote: false };
          }
          cached.canPromote = sharedInterop.speculativeDeepReadEpoch === deepReadEpoch;
          cache.set(node, cached);
          // DeepSignal intentionally refuses to collect per-key dependencies
          // from a speculative read. Such a result is safe only for this one
          // attempt, never as a cross-attempt memo.
          if (sharedInterop.speculativeDeepReadEpoch === deepReadEpoch) {
            saveSharedSpeculativeComputed(node, cached);
          }
        } finally {
          activeSpeculativeComputed = previousSpeculativeComputed;
          computing.delete(node);
        }
      }
      if (activeDependencyCollector !== undefined && (attempt.runtimeToken === undefined || attempt.runtimeToken === runtimeToken || activeDependencyCollector !== attempt)) {
        trackReadable(this, node.renderRevision);
      }
      if (attempt.runtimeToken !== undefined && attempt.runtimeToken !== runtimeToken) publishRenderRead(this, node);
      // The computed itself is the render dependency. Its committed graph bridge
      // owns the underlying sources; flattening speculative child dependencies
      // here would subscribe the root store twice and can duplicate renders.
      if (cached.hasError) throw cached.error;
      return cached.value;
    }
    try {
      const value = readComputed(node);
      publishGraphRead(node);
      trackReadable(this, node.renderRevision);
      return value;
    } catch (error) {
      publishGraphRead(node);
      if (activeAttempt?.runtimeToken === runtimeToken || activeAttempt?.runtimeToken === undefined) {
        if (activeDependencyCollector !== undefined) trackReadable(this, node.renderRevision);
      }
      if (activeAttempt?.runtimeToken !== undefined && activeAttempt?.runtimeToken !== runtimeToken) publishRenderRead(this, node);
      throw error;
    }
  }
  peek() { return untracked(() => this.value); }
}
class DirectBrandComputed {
  #node;
  constructor(node) {
    this.#node = node;
    Object.defineProperty(this, SIGNAL_BRAND, { value: BRAND_VERSION, enumerable: false, writable: false, configurable: false });
  }
  get value() { return readComputed(this.#node); }
  peek() { return untracked(() => readComputed(this.#node)); }
}
function createBrandedComputed(makeReadable, getter) {
  const node = makeNode("computed", None, { getter, value: undefined, error: undefined, hasError: false, initialized: false });
  return new makeReadable(node);
}
export const computedClassBrandWeakSet = (getter) => createBrandedComputed(WeakSetComputed, getter);
export const computedClassBrandHelper = (getter) => createBrandedComputed(HelperBrandComputed, getter);
export const computedClassBrandDirect = (getter) => createBrandedComputed(DirectBrandComputed, getter);

function hasBrandAndPeek(value) {
  if (typeof value !== "object" || value === null) return false;
  const version = value[SIGNAL_BRAND];
  return typeof version === "number" && version >= MIN_BRAND_VERSION && typeof value.peek === "function";
}
export function isSignalBrandWeakSet(value) {
  if (typeof value !== "object" || value === null) return false;
  return brandedLocals.has(value) || hasBrandAndPeek(value);
}
export const isSignalBrandHelper = hasBrandAndPeek;
export const isSignalBrandDirect = hasBrandAndPeek;


export function getRenderVersion(readable) {
  const node = renderNodes.get(readable);
  if (node === undefined) {
    const protocol = readable?.[READABLE_INTEROP_V1];
    if (protocol?.version === 1 && typeof protocol.getRevision === "function") return protocol.getRevision();
    throw new TypeError("Unknown render-readable");
  }
  return node.renderRevision;
}

export function subscribeReadables(readables, notify) {
  let initial = true;
  return effect(() => withoutRenderAttempt(() => {
    for (const readable of readables) {
      try { readable.value; } catch { /* Keep erroring dependencies subscribed. */ }
    }
    if (initial) initial = false;
    else notify();
  }));
}

export function readRenderSnapshot(readable) {
  return captureRenderSnapshot(readable).value;
}

export function captureRenderSnapshot(readable) {
  const attempt = createRenderAttempt();
  attempt.runtimeToken = runtimeToken;
  let value;
  const previousRenderCollector = sharedInterop.renderCollector;
  sharedInterop.renderCollector = attempt;
  try {
    withRenderAttempt(attempt, () => { value = readable.value; });
  } finally { sharedInterop.renderCollector = previousRenderCollector; }
  return { value, dependencies: attempt.dependencies };
}

export function getRenderDebugSnapshot(readable) {
  const node = renderNodes.get(readable);
  if (node === undefined) throw new TypeError("Unknown render-readable");
  return {
    flags: node.flags,
    currentValue: node.currentValue,
    pendingValue: node.pendingValue,
    deps: node.deps,
    depsTail: node.depsTail,
    subs: node.subs,
    subsTail: node.subsTail,
    computedValue: node.value,
    hasError: node.hasError,
    error: node.error,
    initialized: node.initialized,
  };
}

export function hasSubscribers(readable) {
  return renderNodes.get(readable)?.subs !== undefined;
}
export function hasActiveSubscriber() { return activeSub !== undefined; }
export function getBatchDepth() { return batchDepth; }
export function markDeepSignalWatched(readable) { deepSignalWatched.add(readable); }
export function isDeepSignalWatched(readable) { return deepSignalWatched.has(readable); }
