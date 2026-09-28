/* Production-shaped Alien-derived graph, adapted from Alien Signals 3.2.1.
 * Source: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See the repository license notice.
 * Imports only alien-signals/system; RFSG APIs and adapters remain local.
 */
import { createReactiveSystem, ReactiveFlags } from "alien-signals/system";
import { UNTRACKED_OWNER, executionContext, withExecutionOwner } from "./execution-owner.js";
import { createForeignReadableAdapter } from "./foreign-readable-v1.mjs";
import { activeRenderCollector, trackRenderDependency } from "./render-tracking.js";

export function createAlienDerivedRuntime() {const { None, Mutable, Watching, RecursedCheck, Recursed, Dirty, Pending } = ReactiveFlags;
const NO_OWNER_ARGUMENT = Symbol("no graph callback argument");
const runtimeToken = {};
let renderAdapter;
let activeRenderAttempt;

let activeSub;
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let flushIndex = 0;
let queuedLength = 0;
const queue = [];

const system = createReactiveSystem({
  update(node) {
    if (node.kind === "external") {
      node.pendingRevision = node.protocol.getRevision();
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
      node.unsubscribe?.();
      node.unsubscribe = undefined;
    } else if (node.kind === "computed") {
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

function makeNode(kind, flags, fields = {}) {
  return { kind, flags, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, renderRevision: 0, ...fields };
}

const foreignAdapter = createForeignReadableAdapter({
  runtimeToken,
  makeNode,
  mutableFlag: Mutable,
  dirtyFlag: Dirty,
  getActiveSubscriber: () => activeSub,
  link: (node, subscriber) => link(node, subscriber, cycle),
  propagate,
  flush: () => flush(),
  isRunning: () => !!runDepth,
  isBatching: () => !!batchDepth,
  effect: (callback) => effect(callback),
});
const renderDependencies = new WeakMap();
const deepSignalNodes = new WeakSet();
const deepWatchedNodes = new WeakSet();

function getRenderDependency(readable, node) {
  if (!renderDependencies.has(readable)) {
    node.getRenderVersion = () => foreignAdapter.observeRevision(node);
    node.subscribeRender = (listener) => {
      let initial = true;
      let version = foreignAdapter.observeRevision(node);
      return effect(() => {
        try { readable.value; } catch { /* Keep erroring boundaries subscribed. */ }
        const nextVersion = foreignAdapter.observeRevision(node);
        if (initial) initial = false;
        else if (nextVersion !== version) listener();
        version = nextVersion;
      });
    };
    renderDependencies.set(readable, node);
  }
  return renderDependencies.get(readable);
}

function readSource(source) {
  if (source.flags & Dirty && updateSource(source)) {
    if (source.subs !== undefined) shallowPropagate(source.subs);
  }
  if (activeSub !== undefined) link(source, activeSub, cycle);
  return source.currentValue;
}

const attachProtocol = foreignAdapter.attachProtocol;
const ensureForeignNode = foreignAdapter.ensureForeignNode;
const graphOwner = foreignAdapter.graphOwner;
function withGraphOwner(callback, argument = NO_OWNER_ARGUMENT, thisArg = undefined) {
  const owner = executionContext.owner;
  const previousAttempt = activeRenderAttempt;
  const alreadyOwned = owner?.kind === "graph" && owner.runtimeToken === runtimeToken;
  if (previousAttempt === undefined && alreadyOwned) {
    return argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument);
  }
  activeRenderAttempt = undefined;
  try {
    return withExecutionOwner(graphOwner, () =>
      argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument));
  } finally { activeRenderAttempt = previousAttempt; }
}

function configureRenderAdapter(adapter) {
  renderAdapter = adapter;
}

function withRenderAttempt(attempt, callback) {
  const restore = pushRenderAttempt(attempt);
  try { return callback(); }
  finally { restore(); }
}

function pushRenderAttempt(attempt) {
  const previous = activeRenderAttempt;
  activeRenderAttempt = attempt;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (activeRenderAttempt === attempt) activeRenderAttempt = previous;
  };
}

function getActiveRenderAttempt() { return activeRenderAttempt; }
const getNodeForReadable = foreignAdapter.getNodeForReadable;
const getReadableRevision = foreignAdapter.getReadableRevision;
function isComputedClean(node) {
  return node.initialized && !(node.flags & (Dirty | Pending));
}

function promoteComputed(readable, node, entry) {
  if (node.initialized) return true;
  const dependencies = [];
  for (const [dependency, revision] of entry.dependencies) {
    if (getReadableRevision(dependency) !== revision) return false;
    const dependencyNode = foreignAdapter.getNodeForReadable(dependency);
    if (dependencyNode !== undefined) dependencies.push(dependencyNode);
    else {
      const protocol = dependency?.version === 1
        && typeof dependency.getRevision === "function"
        && typeof dependency.subscribe === "function"
        ? dependency
        : undefined;
      if (protocol === undefined) return false;
      dependencies.push(ensureForeignNode(protocol, revision));
    }
  }
  disposeDeps(node);
  node.depsTail = undefined;
  const previousSub = activeSub;
  activeSub = node;
  cycle += 1;
  try {
    for (const dependency of dependencies) link(dependency, node, cycle);
  } finally { activeSub = previousSub; }
  node.value = entry.value;
  node.error = entry.error;
  node.hasError = entry.hasError;
  node.initialized = true;
  node.flags = Mutable;
  return true;
}

function hasSubscribers(readable) {
  return foreignAdapter.getNodeForReadable(readable)?.subs !== undefined;
}
function hasActiveSubscriber() { return activeSub !== undefined; }
function getBatchDepth() { return batchDepth; }

function updateSource(source) {
  source.flags = Mutable;
  const changed = !Object.is(source.currentValue, source.currentValue = source.pendingValue);
  return changed;
}

function readComputed(computed) {
  if (computed.foreignDependent && computed.subs === undefined) {
    refreshColdForeignDependencies(computed, new Set());
  }
  if (activeSub === computed && computed.flags & RecursedCheck) {
    throw new Error("Computed cycle detected");
  }
  const flags = computed.flags;
  if (flags & Dirty || (flags & Pending && (checkDirty(computed.deps, computed) || (computed.flags = flags & ~Pending, false)))) {
    if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
  } else if (!flags) {
    updateComputed(computed);
  }
  if (activeSub !== undefined) {
    link(computed, activeSub, cycle);
    if (activeSub.kind === "effect") activateForeignDependencies(computed, new Set());
  }
  if (computed.hasError) throw computed.error;
  return computed.value;
}

function refreshColdForeignDependencies(node, visited) {
  if (visited.has(node)) return false;
  visited.add(node);
  let changed = false;
  let dependency = node.deps;
  while (dependency !== undefined) {
    const dep = dependency.dep;
    if (dep.kind === "external") {
      const revision = dep.protocol.getRevision();
      if (revision !== dep.revision) {
        dep.pendingRevision = revision;
        dep.flags = Mutable | Dirty;
        changed = true;
      }
    } else if (dep.kind === "computed" && dep.foreignDependent) {
      if (refreshColdForeignDependencies(dep, visited)) changed = true;
    }
    dependency = dependency.nextDep;
  }
  if (changed) node.flags |= Dirty;
  return changed;
}

function activateForeignDependencies(node, visited) {
  if (visited.has(node)) return;
  visited.add(node);
  let dependency = node.deps;
  while (dependency !== undefined) {
    const dep = dependency.dep;
    if (dep.kind === "external") foreignAdapter.activateForeignNode(dep);
    else if (dep.kind === "computed") activateForeignDependencies(dep, visited);
    dependency = dependency.nextDep;
  }
}

function updateComputed(computed) {
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
      computed.value = withGraphOwner(computed.getter, previousValue, computed);
      computed.error = undefined;
      computed.hasError = false;
    } catch (error) {
      computed.value = undefined;
      computed.error = error;
      computed.hasError = true;
    }
    computed.initialized = true;
    changed = changed || hadError || computed.hasError || !Object.is(previousValue, computed.value);
    if (changed && computed.renderRevision !== undefined) computed.renderRevision = (computed.renderRevision + 1) | 0;
    return changed;
  } finally {
    activeSub = previous;
    computed.flags &= ~RecursedCheck;
    purgeDeps(computed);
  }
}

function runEffect(effect) {
  const flags = effect.flags;
  if (flags & Dirty || (flags & Pending && checkDirty(effect.deps, effect))) {
    if (effect.cleanup !== undefined) {
      try {
        runCleanup(effect);
      } catch (error) {
        reportFailure(error);
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
      const cleanup = withGraphOwner(effect.fn);
      effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      if (!effect.flags && effect.cleanup !== undefined) runCleanup(effect);
    } finally {
      runDepth -= 1;
      activeSub = previous;
      effect.flags &= ~RecursedCheck;
      purgeDeps(effect);
    }
  } else if (effect.deps !== undefined) {
    effect.flags = Watching;
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

function disposeDeps(sub) {
  let depLink = sub.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    const dependency = depLink.dep;
    unlink(depLink, sub);
    if (dependency.kind === "computed" && dependency.subs === undefined && dependency.depsTail !== undefined) {
      dependency.flags = Mutable | Dirty;
      disposeDeps(dependency);
    }
    depLink = previous;
  }
}

function purgeDeps(sub) {
  const tail = sub.depsTail;
  let depLink = tail === undefined ? sub.deps : tail.nextDep;
  while (depLink !== undefined) {
    const dependency = depLink.dep;
    depLink = unlink(depLink, sub);
    if (dependency.kind === "computed" && dependency.subs === undefined && dependency.depsTail !== undefined) {
      dependency.flags = Mutable | Dirty;
      disposeDeps(dependency);
    }
  }
}

function runCleanup(effect) {
  const cleanup = effect.cleanup;
  effect.cleanup = undefined;
  const previous = activeSub;
  activeSub = undefined;
  try {
    return withExecutionOwner(UNTRACKED_OWNER, cleanup);
  } finally { activeSub = previous; }
}

function disposeEffect(effect) {
  effect.flags = None;
  disposeDeps(effect);
  if (effect.cleanup !== undefined) {
    try { runCleanup(effect); }
    catch (error) { reportFailure(error); }
  }
}

function effect(fn) {
  const node = makeNode("effect", Watching | RecursedCheck, { fn, cleanup: undefined });
  const previous = activeSub;
  try {
    activeSub = node;
    runDepth += 1;
    try {
      const cleanup = withGraphOwner(fn);
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
  if (!runDepth && !batchDepth) {
    if (node.flags & (Dirty | Pending)) runEffect(node);
    if (queuedLength) flush();
  }
  return () => disposeEffect(node);
}

function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (!batchDepth) flush();
  }
}

function untracked(fn) {
  const previous = activeSub;
  const previousAttempt = activeRenderAttempt;
  activeSub = undefined;
  activeRenderAttempt = undefined;
  try { return withExecutionOwner(UNTRACKED_OWNER, fn); }
  finally {
    activeRenderAttempt = previousAttempt;
    activeSub = previous;
  }
}

// Public API/brand candidates. Each public object is the readable class
// instance itself; no outer wrapper, interop protocol, or per-instance methods.
const SIGNAL_BRAND = Symbol.for("react-fine-grained-signals.signal");
const BRAND_VERSION = 1;
const MIN_BRAND_VERSION = 1;
const brandDescriptor = () => ({ value: BRAND_VERSION, enumerable: false, writable: false, configurable: false });
function registerHelperBrand(value) {
  Object.defineProperty(value, SIGNAL_BRAND, brandDescriptor());
}

function inlineWrite(node, value) {
  if (deepSignalNodes.has(node)) deepWatchedNodes.delete(node);
  if (!Object.is(node.pendingValue, node.pendingValue = value)) {
    if (node.renderRevision !== undefined) node.renderRevision = (node.renderRevision + 1) | 0;
    node.flags = Mutable | Dirty;
    const subscribers = node.subs;
    if (subscribers !== undefined) {
      propagate(subscribers, !!runDepth);
      if (!batchDepth) flush();
    }
  }
}

class HelperBrandSignal {
  #node;
  constructor(node, branded = true) { this.#node = node; if (branded) registerHelperBrand(this); attachProtocol(this, node); }
  get value() {
    const node = this.#node;
    const attempt = activeRenderAttempt;
    const currentOwner = executionContext.owner;
    if (attempt !== undefined && currentOwner?.kind === "render" && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      foreignAdapter.observeRevision(node);
      return renderAdapter.readSource(this, node, attempt);
    }
    const value = readSource(node);
    const owner = currentOwner;
    if (owner !== undefined && owner !== UNTRACKED_OWNER && owner.runtimeToken !== runtimeToken) {
      foreignAdapter.publishForeignReadable(this, node, owner);
    }
    if (owner === undefined && activeRenderCollector !== undefined) {
      trackRenderDependency(getRenderDependency(this, node));
    }
    return value;
  }
  set value(value) { inlineWrite(this.#node, value); }
  peek() { return this.#node.pendingValue; }
}
function createBrandedSignal(makeReadable, initialValue) {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new makeReadable(node);
}
const signalClassBrandHelper = (initialValue) => createBrandedSignal(HelperBrandSignal, initialValue);

class HelperBrandComputed {
  #node;
  constructor(node, branded = true) { this.#node = node; if (branded) registerHelperBrand(this); attachProtocol(this, node); }
  get value() {
    const node = this.#node;
    const attempt = activeRenderAttempt;
    const currentOwner = executionContext.owner;
    if (attempt !== undefined && currentOwner?.kind === "render" && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      foreignAdapter.observeRevision(node);
      return renderAdapter.readComputed(this, node, attempt);
    }
    const owner = currentOwner;
    try {
      return readComputed(node);
    } finally {
      if (owner !== undefined && owner !== UNTRACKED_OWNER && owner.runtimeToken !== runtimeToken) {
        foreignAdapter.publishForeignReadable(this, node, owner);
      }
      if (owner === undefined && activeRenderCollector !== undefined) trackRenderDependency(getRenderDependency(this, node));
    }
  }
  peek() { return untracked(() => readComputed(this.#node)); }
}
function createBrandedComputed(makeReadable, getter) {
  const node = makeNode("computed", None, { getter, value: undefined, error: undefined, hasError: false, initialized: false });
  return new makeReadable(node);
}
const computedClassBrandHelper = (getter) => createBrandedComputed(HelperBrandComputed, getter);

function hasBrandAndPeek(value) {
  if (typeof value !== "object" || value === null) return false;
  const version = value[SIGNAL_BRAND];
  return typeof version === "number" && version >= MIN_BRAND_VERSION && typeof value.peek === "function";
}
const isSignalBrandHelper = hasBrandAndPeek;
  function createDeepSignal(initialValue) {
    const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
    const readable = new HelperBrandSignal(node, false);
    deepSignalNodes.add(node);
    return readable;
  }
  function markDeepSignalWatched(readable) {
    const node = foreignAdapter.getNodeForReadable(readable);
    if (node !== undefined) deepWatchedNodes.add(node);
  }
  function hasDeepSignalSubscribers(readable) {
    const node = foreignAdapter.getNodeForReadable(readable);
    return node !== undefined && (
      deepWatchedNodes.has(node) || (deepSignalNodes.has(node) && hasSubscribers(readable))
    );
  }
  function getRenderVersion(readable) {
    return foreignAdapter.getReadableRevision(readable);
  }
  function subscribeReadables(readables, notify) {
    let initial = true;
    return effect(() => {
      for (const readable of readables) {
        try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
      }
      if (initial) initial = false;
      else notify();
    });
  }

  return {
    runtimeToken, graphOwner, configureRenderAdapter, withRenderAttempt, pushRenderAttempt,
    getActiveRenderAttempt, getNodeForReadable, getReadableRevision, isComputedClean,
    promoteComputed, hasSubscribers, hasActiveSubscriber, getBatchDepth,
    signal: signalClassBrandHelper, computed: computedClassBrandHelper,
    effect, batch, untracked, SIGNAL_BRAND, isSignal: isSignalBrandHelper,
    createDeepSignal, markDeepSignalWatched, hasDeepSignalSubscribers,
    getRenderVersion, subscribeReadables,
  };
}
