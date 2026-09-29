/* Production-shaped Alien-derived graph, adapted from Alien Signals 3.2.1.
 * Source: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See the repository license notice.
 * Imports only alien-signals/system; RFSG APIs and adapters remain local.
 */
import { createReactiveSystem } from "alien-signals/system";
import type { Link, ReactiveFlags, ReactiveNode } from "alien-signals/system";
import { UNTRACKED_OWNER, executionContext, isGraphExecutionOwner, isRenderExecutionOwner, withSynchronousExecutionOwner } from "./execution-owner.js";
import { createForeignReadableAdapter } from "./foreign-readable-v1.mjs";
import { activeRenderCollector, trackRenderDependency } from "./render-tracking.js";
import type { AlienDerivedGraphRuntime, RenderAdapterForCore, RenderAttempt, RuntimeNode, RuntimeSource, RuntimeComputed, RuntimeEffect, RuntimeReadable, RuntimeWritable, SpeculativeComputedEntry } from "./alien-derived-types.js";

const None = 0 as ReactiveFlags;
const Mutable = 1 as ReactiveFlags;
const Watching = 2 as ReactiveFlags;
const RecursedCheck = 4 as ReactiveFlags;
const Recursed = 8 as ReactiveFlags;
const Dirty = 16 as ReactiveFlags;
const Pending = 32 as ReactiveFlags;

export function createAlienDerivedRuntime(): AlienDerivedGraphRuntime {
const NO_OWNER_ARGUMENT = Symbol("no graph callback argument");
const runtimeToken = {};
let renderAdapter: RenderAdapterForCore | undefined;
let activeRenderAttempt: RenderAttempt | undefined;

let activeSub: RuntimeNode | undefined;
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let flushIndex = 0;
let queuedLength = 0;
const queue: Array<RuntimeNode | undefined> = [];

const system = createReactiveSystem({
  update(rawNode: ReactiveNode) {
    const node = rawNode as RuntimeNode;
    if (node.kind === "external") {
      node.pendingRevision = node.protocol!.getRevision();
      const changed = node.revision !== node.pendingRevision;
      node.revision = node.pendingRevision;
      node.flags = Mutable;
      return changed;
    }
    if (node.kind === "computed") return updateComputed(node as RuntimeComputed);
    if (node.kind === "source") return updateSource(node);
    node.flags = Mutable;
    return true;
  },
  notify(rawEffect: ReactiveNode) {
    let current: RuntimeNode | undefined = rawEffect as RuntimeNode;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      const effect = current!;
      queue[insertIndex++] = effect;
      effect.flags &= ~Watching;
      current = effect.subs?.sub as RuntimeNode | undefined;
      if (current === undefined || !(current.flags & Watching)) break;
    // This queue walk intentionally advances until its linked-list sentinel.
    // oxlint-disable-next-line no-constant-condition
    } while (true);
    queuedLength = insertIndex;
    let leftIndex = firstInsertedIndex;
    while (leftIndex < --insertIndex) {
      const left = queue[leftIndex]!;
      queue[leftIndex++] = queue[insertIndex]!;
      queue[insertIndex] = left;
    }
  },
  unwatched(rawNode: ReactiveNode) {
    const node = rawNode as RuntimeNode;
    if (node.kind === "external") {
      node.unsubscribe?.();
      node.unsubscribe = undefined;
    } else if (node.kind === "computed") {
      if (node.depsTail !== undefined) {
        node.flags = Mutable | Dirty;
        disposeDeps(node);
      }
    } else if (node.kind === "effect") {
      disposeEffect(node as RuntimeEffect);
    }
  },
});
const { link: alienLink, unlink: alienUnlink, propagate, checkDirty, shallowPropagate } = system;

function linkNode(dependency: RuntimeNode, subscriber: RuntimeNode, version: number): void {
  alienLink(dependency as unknown as ReactiveNode, subscriber as unknown as ReactiveNode, version);
}

function unlinkNode(linkage: Link, subscriber: RuntimeNode): Link | undefined {
  return alienUnlink(linkage, subscriber as unknown as ReactiveNode);
}

function makeNode(kind: RuntimeNode["kind"], flags: number, fields: Partial<RuntimeNode> = {}): RuntimeNode {
  return { kind, flags: flags as ReactiveFlags, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, renderRevision: 0, ...fields } as RuntimeNode;
}

const foreignAdapter = createForeignReadableAdapter({
  runtimeToken,
  makeNode,
  mutableFlag: Mutable,
  dirtyFlag: Dirty,
  getActiveSubscriber: () => activeSub,
  link: (node: RuntimeNode, subscriber: RuntimeNode) => linkNode(node, subscriber, cycle),
  propagate,
  flush: () => flush(),
  isRunning: () => !!runDepth,
  isBatching: () => !!batchDepth,
  effect: (callback: () => unknown) => effect(callback),
});
const renderDependencies = new WeakMap<object, RuntimeNode>();
const deepSignalNodes = new WeakSet<RuntimeNode>();
const deepWatchedNodes = new WeakSet<RuntimeNode>();

function getRenderDependency(readable: { value: unknown }, node: RuntimeNode) {
  if (!renderDependencies.has(readable)) {
    node.getRenderVersion = () => foreignAdapter.observeRevision(node);
    node.subscribeRender = (listener: () => void) => {
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
  return renderDependencies.get(readable)!;
}

function readSource(source: RuntimeNode): unknown {
  if (source.flags & Dirty && updateSource(source)) {
    if (source.subs !== undefined) shallowPropagate(source.subs);
  }
  if (activeSub !== undefined) linkNode(source, activeSub, cycle);
  return source.currentValue;
}

const attachProtocol = foreignAdapter.attachProtocol;
const ensureForeignNode = foreignAdapter.ensureForeignNode;
const graphOwner = foreignAdapter.graphOwner;
function withGraphOwner<T>(callback: (this: unknown, arg?: unknown) => T, argument: unknown | typeof NO_OWNER_ARGUMENT = NO_OWNER_ARGUMENT, thisArg: unknown = undefined): T {
  const owner = executionContext.owner;
  const previousAttempt = activeRenderAttempt;
  const alreadyOwned = isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken;
  if (previousAttempt === undefined && alreadyOwned) {
    return argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument);
  }
  activeRenderAttempt = undefined;
  if (!alreadyOwned) executionContext.owner = graphOwner;
  try { return argument === NO_OWNER_ARGUMENT ? callback() : callback.call(thisArg, argument); }
  finally {
    if (!alreadyOwned) executionContext.owner = owner;
    activeRenderAttempt = previousAttempt;
  }
}

function configureRenderAdapter(adapter: RenderAdapterForCore): void {
  renderAdapter = adapter;
}

function withRenderAttempt<T>(attempt: RenderAttempt | undefined, callback: () => T): T {
  const restore = pushRenderAttempt(attempt);
  try { return callback(); }
  finally { restore(); }
}

function pushRenderAttempt(attempt: RenderAttempt | undefined): () => void {
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
function isComputedClean(node: RuntimeNode): boolean {
  return node.initialized === true && !(node.flags & (Dirty | Pending));
}

function promoteComputed(readable: object, node: RuntimeNode, entry: SpeculativeComputedEntry): boolean {
  if (node.initialized) return true;
  const computed = node as RuntimeComputed;
  const hadForeignDependencies = computed.foreignDependent;
  const dependencies: RuntimeNode[] = [];
  for (const [dependency, revision] of entry.dependencies) {
    if (getReadableRevision(dependency) !== revision) return false;
    const dependencyNode = foreignAdapter.getNodeForReadable(dependency);
    if (dependencyNode !== undefined) dependencies.push(dependencyNode);
    else {
      const protocolValue: unknown = Reflect.get(dependency, Symbol.for("react-fine-grained-signals.readable-interop.v1"));
      const protocol = typeof protocolValue === "object" && protocolValue !== null
        && Reflect.get(protocolValue, "version") === 1
        && typeof Reflect.get(protocolValue, "getRevision") === "function"
        && typeof Reflect.get(protocolValue, "subscribe") === "function"
        ? protocolValue as import("./execution-owner.js").ReadableProtocolV1
        : undefined;
      if (protocol === undefined) return false;
      dependencies.push(ensureForeignNode(protocol, revision));
    }
  }
  disposeDeps(computed);
  computed.depsTail = undefined;
  const previousSub = activeSub;
  activeSub = computed;
  cycle += 1;
  try {
    for (const dependency of dependencies) linkNode(dependency, computed, cycle);
  } finally { activeSub = previousSub; }
  recomputeForeignDependencies(computed);
  if (hadForeignDependencies !== computed.foreignDependent) updateForeignDependencyAncestors(computed);
  computed.value = entry.value;
  computed.error = entry.error;
  computed.hasError = entry.hasError;
  computed.initialized = true;
  computed.flags = Mutable;
  return true;
}

function hasSubscribers(readable: object): boolean {
  return foreignAdapter.getNodeForReadable(readable)?.subs !== undefined;
}
function hasActiveSubscriber(): boolean { return activeSub !== undefined; }
function getBatchDepth(): number { return batchDepth; }

function updateSource(source: RuntimeNode): boolean {
  source.flags = Mutable;
  const changed = !Object.is(source.currentValue, source.currentValue = source.pendingValue);
  return changed;
}

function readComputed(computed: RuntimeComputed): unknown {
  if (computed.foreignDependent && computed.subs === undefined) {
    refreshColdForeignDependencies(computed, new Set());
  }
  if (activeSub === computed && computed.flags & RecursedCheck) {
    throw new Error("Computed cycle detected");
  }
  const flags = computed.flags;
  if (flags & Dirty || (flags & Pending && ((computed.deps !== undefined && checkDirty(computed.deps, computed as unknown as ReactiveNode)) || (computed.flags = flags & ~Pending, false)))) {
    if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
  } else if (!flags) {
    updateComputed(computed);
  }
  if (activeSub !== undefined) {
    linkNode(computed, activeSub, cycle);
    if (activeSub.kind === "computed" && computed.foreignDependent) activeSub.foreignDependent = true;
    if (activeSub.kind === "effect" && computed.foreignDependent) activateForeignDependencies(computed, new Set());
  }
  if (computed.hasError) throw computed.error;
  return computed.value;
}

function refreshColdForeignDependencies(node: RuntimeComputed, visited: Set<RuntimeNode>): boolean {
  if (visited.has(node)) return false;
  visited.add(node);
  let changed = false;
  let dependency = node.deps;
  while (dependency !== undefined) {
    const dep = dependency.dep as RuntimeNode;
    if (dep.kind === "external") {
      const revision = dep.protocol!.getRevision();
      if (revision !== dep.revision) {
        dep.pendingRevision = revision;
        dep.flags = Mutable | Dirty;
        changed = true;
      }
    } else if (dep.kind === "computed" && dep.foreignDependent) {
      if (refreshColdForeignDependencies(dep as RuntimeComputed, visited)) changed = true;
    }
    dependency = dependency.nextDep;
  }
  if (changed) node.flags |= Dirty;
  return changed;
}

function activateForeignDependencies(node: RuntimeComputed, visited: Set<RuntimeNode>): void {
  if (visited.has(node)) return;
  visited.add(node);
  let dependency = node.deps;
  while (dependency !== undefined) {
    const dep = dependency.dep as RuntimeNode;
    if (dep.kind === "external") foreignAdapter.activateForeignNode(dep);
    else if (dep.kind === "computed") activateForeignDependencies(dep as RuntimeComputed, visited);
    dependency = dependency.nextDep;
  }
}

function updateComputed(computed: RuntimeComputed): boolean {
  computed.depsTail = undefined;
  computed.flags = Mutable | RecursedCheck;
  const previous = activeSub;
  activeSub = computed;
  let changed = !computed.initialized;
  const hadError = computed.hasError;
  const hadForeignDependencies = computed.foreignDependent;
  const previousValue = computed.value;
  computed.foreignDependent = false;
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
    recomputeForeignDependencies(computed);
    if (hadForeignDependencies !== computed.foreignDependent) updateForeignDependencyAncestors(computed);
  }
}

function recomputeForeignDependencies(computed: RuntimeComputed): void {
  let dependency = computed.deps;
  let foreignDependent = false;
  while (dependency !== undefined) {
    const dep = dependency.dep as RuntimeNode;
    if (dep.kind === "external" || (dep.kind === "computed" && (dep as RuntimeComputed).foreignDependent)) {
      foreignDependent = true;
      break;
    }
    dependency = dependency.nextDep;
  }
  computed.foreignDependent = foreignDependent;
}

function updateForeignDependencyAncestors(computed: RuntimeComputed): void {
  let link = computed.subs;
  while (link !== undefined) {
    const subscriber = link.sub as RuntimeNode;
    if (subscriber.kind === "computed") {
      const computedSubscriber = subscriber as RuntimeComputed;
      const wasForeignDependent = computedSubscriber.foreignDependent;
      recomputeForeignDependencies(computedSubscriber);
      if (wasForeignDependent !== computedSubscriber.foreignDependent) updateForeignDependencyAncestors(computedSubscriber);
    }
    link = link.nextSub;
  }
}

function runEffect(effect: RuntimeEffect): void {
  const flags = effect.flags;
  if (flags & Dirty || (flags & Pending && effect.deps !== undefined && checkDirty(effect.deps, effect as unknown as ReactiveNode))) {
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
      const cleanup: unknown = withGraphOwner(effect.fn);
      effect.cleanup = typeof cleanup === "function" ? cleanup as () => unknown : undefined;
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
      const effect = queue[flushIndex]!;
      queue[flushIndex++] = undefined;
      try {
      runEffect(effect as RuntimeEffect);
      } catch (error) {
        reportFailure(error);
      }
    }
  } finally {
    while (flushIndex < queuedLength) {
      const effect = queue[flushIndex]!;
      queue[flushIndex++] = undefined;
      effect!.flags |= Watching | Recursed;
    }
    flushIndex = 0;
    queuedLength = 0;
  }
}

function reportFailure(error: unknown): void {
  try {
    console.error("react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.", { cause: error });
  } catch { /* Reporting must not interrupt scheduler progress. */ }
  try {
    const report = globalThis.reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch { /* Keep a failing host reporter from escaping the runtime. */ }
}

function disposeDeps(sub: RuntimeNode): void {
  let depLink = sub.depsTail;
  while (depLink !== undefined) {
    const previous = depLink.prevDep;
    unlinkNode(depLink, sub);
    depLink = previous;
  }
}

function purgeDeps(sub: RuntimeNode): void {
  const tail = sub.depsTail;
  let depLink = tail === undefined ? sub.deps : tail.nextDep;
  while (depLink !== undefined) depLink = unlinkNode(depLink, sub);
}

function runCleanup(effect: RuntimeEffect): unknown {
  const cleanup = effect.cleanup;
  effect.cleanup = undefined;
  const previous = activeSub;
  activeSub = undefined;
  try {
    return withSynchronousExecutionOwner(UNTRACKED_OWNER, cleanup!);
  } finally { activeSub = previous; }
}

function disposeEffect(effect: RuntimeEffect): void {
  effect.flags = None;
  disposeDeps(effect);
  if (effect.cleanup !== undefined) {
    try { runCleanup(effect); }
    catch (error) { reportFailure(error); }
  }
}

function effect(fn: () => unknown): () => void {
  const node = makeNode("effect", Watching | RecursedCheck, { fn, cleanup: undefined });
  const previous = activeSub;
  try {
    activeSub = node;
    runDepth += 1;
    try {
      const cleanup: unknown = withGraphOwner(fn);
      node.cleanup = typeof cleanup === "function" ? cleanup as () => unknown : undefined;
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
    if (node.flags & (Dirty | Pending)) runEffect(node as RuntimeEffect);
    if (queuedLength) flush();
  }
  return () => disposeEffect(node as RuntimeEffect);
}

function batch<T>(fn: () => T): T {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (!batchDepth) flush();
  }
}

function untracked<T>(fn: () => T): T {
  const previous = activeSub;
  const previousAttempt = activeRenderAttempt;
  activeSub = undefined;
  activeRenderAttempt = undefined;
  try { return withSynchronousExecutionOwner(UNTRACKED_OWNER, fn); }
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
function registerHelperBrand(value: object): void {
  Object.defineProperty(value, SIGNAL_BRAND, brandDescriptor());
}

function inlineWrite(node: RuntimeSource, value: unknown): void {
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

function inlineDeepSignalWrite(node: RuntimeSource, value: unknown): void {
  // DeepSignal version sources use this specialized entry point so liveness
  // bookkeeping stays exact without classifying every ordinary source write.
  deepWatchedNodes.delete(node);
  inlineWrite(node, value);
}

class HelperBrandSignal<T = unknown> {
  #node: RuntimeSource;
  constructor(node: RuntimeSource, branded = true) { this.#node = node; if (branded) registerHelperBrand(this); attachProtocol(this, node); }
  get value(): T {
    const node = this.#node;
    const currentOwner = executionContext.owner;
    // A render attempt is installed with its render owner. Ordinary owner-free
    // reads can skip speculative-render dispatch while preserving collection.
    if (currentOwner === undefined) {
      const value = readSource(node);
      const collector = activeRenderCollector;
      if (collector !== undefined) {
        trackRenderDependency(getRenderDependency(this, node) as import("./alien-derived-types.js").RenderReadableDependency);
      }
      return value as T;
    }
    const attempt = activeRenderAttempt;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      foreignAdapter.observeRevision(node);
      return renderAdapter.readSource(this, node, attempt) as T;
    }
    const value = readSource(node);
    if ((isGraphExecutionOwner(currentOwner) || isRenderExecutionOwner(currentOwner)) && currentOwner.runtimeToken !== runtimeToken) {
      foreignAdapter.publishForeignReadable(this, node, currentOwner);
    }
    return value as T;
  }
  set value(value: T) { inlineWrite(this.#node, value); }
  peek(): T { return this.#node.pendingValue as T; }
}

/** Internal DeepSignal root and per-property version sources have a distinct
 * write entry point because their liveness markers must be cleared before any
 * write, including an Object.is-equal write. Ordinary branded signals never
 * pay that bookkeeping cost. */
class DeepSignalRuntimeSource<T = unknown> {
  #node: RuntimeSource;
  constructor(node: RuntimeSource) { this.#node = node; attachProtocol(this, node); }
  get value(): T {
    const node = this.#node;
    const currentOwner = executionContext.owner;
    if (currentOwner === undefined) {
      const value = readSource(node);
      const collector = activeRenderCollector;
      if (collector !== undefined) {
        trackRenderDependency(getRenderDependency(this, node) as import("./alien-derived-types.js").RenderReadableDependency);
      }
      return value as T;
    }
    const attempt = activeRenderAttempt;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      foreignAdapter.observeRevision(node);
      return renderAdapter.readSource(this, node, attempt) as T;
    }
    const value = readSource(node);
    if ((isGraphExecutionOwner(currentOwner) || isRenderExecutionOwner(currentOwner)) && currentOwner.runtimeToken !== runtimeToken) {
      foreignAdapter.publishForeignReadable(this, node, currentOwner);
    }
    return value as T;
  }
  set value(value: T) { inlineDeepSignalWrite(this.#node, value); }
  peek(): T { return this.#node.pendingValue as T; }
}
function createBrandedSignal<T>(makeReadable: new (node: RuntimeSource) => RuntimeWritable<T>, initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  return new makeReadable(node as RuntimeSource);
}
const signalClassBrandHelper = <T,>(initialValue: T): RuntimeWritable<T> => createBrandedSignal(HelperBrandSignal<T>, initialValue);

class HelperBrandComputed<T = unknown> {
  #node: RuntimeComputed;
  constructor(node: RuntimeComputed, branded = true) { this.#node = node; if (branded) registerHelperBrand(this); attachProtocol(this, node); }
  get value(): T {
    const node = this.#node;
    const attempt = activeRenderAttempt;
    const currentOwner = executionContext.owner;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      foreignAdapter.observeRevision(node);
      return renderAdapter.readComputed(this, node, attempt) as T;
    }
    const owner = currentOwner;
    try {
      return readComputed(node) as T;
    } finally {
      if (owner === undefined) {
        if (activeRenderCollector !== undefined) trackRenderDependency(getRenderDependency(this, node) as import("./alien-derived-types.js").RenderReadableDependency);
      } else if ((isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken !== runtimeToken) {
        foreignAdapter.publishForeignReadable(this, node, owner);
      }
    }
  }
  peek(): T { return untracked(() => readComputed(this.#node) as T); }
}
function createBrandedComputed<T>(makeReadable: new (node: RuntimeComputed) => RuntimeReadable<T>, getter: () => T): RuntimeReadable<T> {
  const node = makeNode("computed", None, { getter, value: undefined, error: undefined, hasError: false, initialized: false });
  return new makeReadable(node as RuntimeComputed);
}
const computedClassBrandHelper = <T,>(getter: () => T): RuntimeReadable<T> => createBrandedComputed(HelperBrandComputed<T>, getter);

function hasBrandAndPeek(value: unknown): value is { peek(): unknown } & object {
  if (typeof value !== "object" || value === null) return false;
  const version = Reflect.get(value, SIGNAL_BRAND);
  return typeof version === "number" && version >= MIN_BRAND_VERSION && typeof Reflect.get(value, "peek") === "function";
}
const isSignalBrandHelper = hasBrandAndPeek;
function createDeepSignal<T>(initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  const readable = new DeepSignalRuntimeSource<T>(node as RuntimeSource);
  deepSignalNodes.add(node);
  return readable;
}
function createDeepSignalVersion<T>(initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable, { currentValue: initialValue, pendingValue: initialValue });
  const readable = new DeepSignalRuntimeSource<T>(node as RuntimeSource);
  deepSignalNodes.add(node);
  return readable;
}
function markDeepSignalWatched(readable: object): void {
    const node = foreignAdapter.getNodeForReadable(readable);
    if (node !== undefined) deepWatchedNodes.add(node);
  }
function hasDeepSignalSubscribers(readable: object): boolean {
    const node = foreignAdapter.getNodeForReadable(readable);
    return node !== undefined && (
      deepWatchedNodes.has(node) || (deepSignalNodes.has(node) && hasSubscribers(readable))
    );
  }
function getRenderVersion(readable: object): number {
    return foreignAdapter.getReadableRevision(readable);
  }
function subscribeReadables(readables: readonly RuntimeReadable[], notify: () => void): () => void {
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
    createDeepSignal, createDeepSignalVersion, markDeepSignalWatched, hasDeepSignalSubscribers,
    getRenderVersion, subscribeReadables,
  };
}
