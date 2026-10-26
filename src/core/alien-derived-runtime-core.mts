/* Production-shaped Alien-derived graph, adapted from Alien Signals 3.2.1.
 * Source: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See the repository license notice.
 * Imports only alien-signals/system; RFSG APIs and adapters remain local.
 */
import { createReactiveSystem } from "alien-signals/system";
import type { Link, ReactiveFlags, ReactiveNode } from "alien-signals/system";
import { UNTRACKED_OWNER, executionContext, isGraphExecutionOwner, isRenderExecutionOwner, multipleCopiesError, withSynchronousExecutionOwner } from "./execution-owner.js";
import type { ExecutionContextOwnerV2, ExecutionOwnerV2, GraphExecutionOwnerV2 } from "./execution-owner.js";
import { activeRenderCollector, trackRenderDependency } from "./render-tracking.js";
import { SIGNAL_BRAND, SIGNAL_BRAND_MIN_VERSION, SIGNAL_BRAND_VERSION } from "./signal-brand.js";
import type { AlienDerivedGraphRuntime, RenderAdapterForCore, RenderAttempt, RuntimeNode, RuntimeSource, RuntimeComputed, RuntimeEffect, RuntimeReadable, RuntimeWritable, SpeculativeComputedEntry } from "./alien-derived-types.js";

// These mirror `ReactiveFlags` in alien-signals/system 3.2.1 bit for bit; the
// exact dependency pin in package.json is what keeps them valid.
const None = 0 as ReactiveFlags;
const Mutable = 1 as ReactiveFlags;
const Watching = 2 as ReactiveFlags;
const RecursedCheck = 4 as ReactiveFlags;
const Recursed = 8 as ReactiveFlags;
const Dirty = 16 as ReactiveFlags;
const Pending = 32 as ReactiveFlags;
// Alien 3.2.1's high-level `HasChildEffect`: set on an effect or computed that
// created an effect while running, so its next run disposes those children.
const HasChildEffect = 64 as ReactiveFlags;

export function createAlienDerivedRuntime(): AlienDerivedGraphRuntime {
const runtimeToken = {};
let renderAdapter: RenderAdapterForCore | undefined;
let activeRenderAttempt: RenderAttempt | undefined;

let activeSub: RuntimeNode | undefined;
// Disposers of effects created by the speculative getter now running.
let speculativeChildren: Array<() => void> | undefined;
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let flushIndex = 0;
let queuedLength = 0;
const queue: Array<RuntimeNode | undefined> = [];

const system = createReactiveSystem({
  update(rawNode: ReactiveNode) {
    const node = rawNode as RuntimeNode;
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
    deepSignalUnwatched.get(node)?.();
    if (node.kind === "computed") {
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

function makeNode(kind: RuntimeNode["kind"], flags: number): RuntimeNode {
  return { kind, flags: flags as ReactiveFlags, deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined, renderRevision: 0 } as RuntimeNode;
}

// Every readable this copy creates, keyed by the public object. Reads and
// subscriptions resolve their graph node here.
const readableNodes = new WeakMap<object, RuntimeNode>();
function registerReadable(readable: object, node: RuntimeNode): void { readableNodes.set(readable, node); }
function getNodeForReadable(readable: object): RuntimeNode | undefined { return readableNodes.get(readable); }
function getReadableRevision(readable: object): number {
  const node = readableNodes.get(readable);
  if (node === undefined) throw new TypeError("Unknown candidate readable");
  return node.renderRevision;
}
const renderDependencies = new WeakMap<object, RuntimeNode>();
const deepSignalNodes = new WeakSet<RuntimeNode>();
const deepWatchedNodes = new WeakSet<RuntimeNode>();
// Do not add a callback slot to every graph node: only Deep Signal versions
// that have pruning work register here, and the weak key lets reclaimed
// version/metadata cycles collect together.
const deepSignalUnwatched = new WeakMap<RuntimeNode, () => void>();

function getRenderDependency(readable: { value: unknown }, node: RuntimeNode) {
  if (!renderDependencies.has(readable)) {
    node.getRenderVersion = () => node.renderRevision;
    node.subscribeRender = (listener: () => void) => {
      let initial = true;
      let version = node.renderRevision;
      return detachedEffect(() => {
        try { readable.value; } catch { /* Keep erroring boundaries subscribed. */ }
        const nextVersion = node.renderRevision;
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

// The read half of `readSource` without linking. Another copy's `untracked()`
// clears only its own subscriber, so a read under the shared UNTRACKED_OWNER
// must not link to whichever subscriber this copy happens to be running.
function readSourceUntracked(source: RuntimeNode): unknown {
  if (source.flags & Dirty && updateSource(source)) {
    if (source.subs !== undefined) shallowPropagate(source.subs);
  }
  return source.currentValue;
}

// Another copy's graph or render owner is reading. Copies of this package do
// not interoperate, so a getter that finds one throws instead of reading.
function isForeignOwner(owner: ExecutionContextOwnerV2 | undefined): owner is ExecutionOwnerV2 {
  return (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken !== runtimeToken;
}

const graphOwner: GraphExecutionOwnerV2 = {
  version: 2,
  kind: "graph",
  runtimeToken,
  add() { throw multipleCopiesError(); },
};
// User callbacks (computed getters, effect bodies) are called as `() => T`:
// no arguments and no `this`, as in v0.1.1.
function withGraphOwner<T>(callback: () => T): T {
  const owner = executionContext.owner;
  const previousAttempt = activeRenderAttempt;
  const alreadyOwned = isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken;
  if (previousAttempt === undefined && alreadyOwned) return callback();
  activeRenderAttempt = undefined;
  if (!alreadyOwned) executionContext.owner = graphOwner;
  try { return callback(); }
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
function isComputedClean(node: RuntimeNode): boolean {
  return node.initialized === true && !(node.flags & (Dirty | Pending));
}

function promoteComputed(readable: object, node: RuntimeNode, entry: SpeculativeComputedEntry): boolean {
  // Already initialized, by a real read or another attempt's promotion: both
  // advance `renderRevision`, so `settleRenderAttempt` compares this attempt's
  // value with the node's rather than trusting the revision it recorded.
  if (node.initialized) return true;
  const computed = node as RuntimeComputed;
  const dependencies: RuntimeNode[] = [];
  for (const [dependency, revision] of entry.dependencies) {
    if (getReadableRevision(dependency) !== revision) return false;
    const dependencyNode = readableNodes.get(dependency)!;
    // Link a dependency only in the state the speculative read observed. A
    // computed's revision moves only when it re-evaluates, so one a later
    // write left Dirty or Pending fails here, as it does on cache reuse.
    if (dependencyNode.kind === "computed" && !isComputedClean(dependencyNode)) return false;
    // The render read a source's pending value without settling it. Settle it
    // before linking, as Alien's own signal read does, or a later write back
    // to the stale committed value compares equal and never reaches us.
    if (dependencyNode.kind === "source") readSourceUntracked(dependencyNode);
    dependencies.push(dependencyNode);
  }
  disposeDeps(computed);
  computed.depsTail = undefined;
  const previousSub = activeSub;
  activeSub = computed;
  cycle += 1;
  try {
    for (const dependency of dependencies) linkNode(dependency, computed, cycle);
  } finally { activeSub = previousSub; }
  computed.value = entry.value;
  computed.error = entry.error;
  computed.hasError = entry.hasError;
  computed.initialized = true;
  computed.flags = Mutable;
  // Initialization is a value change, as in `updateComputed`, so any other
  // attempt that read this computed before it existed re-checks its value.
  computed.renderRevision = (computed.renderRevision + 1) | 0;
  return true;
}

function hasSubscribers(readable: object): boolean {
  return readableNodes.get(readable)?.subs !== undefined;
}
function hasActiveSubscriber(): boolean { return activeSub !== undefined; }
function getBatchDepth(): number { return batchDepth; }

function updateSource(source: RuntimeNode): boolean {
  source.flags = Mutable;
  const changed = !Object.is(source.currentValue, source.currentValue = source.pendingValue);
  return changed;
}

function readComputed(computed: RuntimeComputed, track = true): unknown {
  // RecursedCheck is only set on a computed while its own getter is on the
  // stack, so any read of it here -- direct or through other computeds -- is
  // a cycle that would otherwise silently return a stale intermediate value.
  if (computed.flags & RecursedCheck) {
    throw new Error("Computed cycle detected");
  }
  const flags = computed.flags;
  if (flags & Dirty || (flags & Pending && ((computed.deps !== undefined && checkDirty(computed.deps, computed as unknown as ReactiveNode)) || (computed.flags = flags & ~Pending, false)))) {
    if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
  } else if (!flags) {
    updateComputed(computed);
  }
  if (track && activeSub !== undefined) linkNode(computed, activeSub, cycle);
  if (computed.hasError) throw computed.error;
  return computed.value;
}

function updateComputed(computed: RuntimeComputed): boolean {
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
      computed.value = withGraphOwner(computed.getter);
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

// Alien 3.2.1's child-effect disposal: an effect created while `sub` ran is
// linked as one of `sub`'s dependencies; unlinking it before `sub` runs again
// leaves it with no subscriber, which disposes it through `unwatched`.
function disposeChildEffects(sub: RuntimeNode): void {
  let link = sub.depsTail;
  while (link !== undefined) {
    const previous = link.prevDep;
    if ((link.dep as RuntimeNode).kind === "effect") unlinkNode(link, sub);
    link = previous;
  }
}

function runEffect(effect: RuntimeEffect): void {
  const flags = effect.flags;
  if (flags & Dirty || (flags & Pending && effect.deps !== undefined && checkDirty(effect.deps, effect as unknown as ReactiveNode))) {
    if (flags & HasChildEffect) disposeChildEffects(effect);
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
      settleDeps(effect);
    }
  } else if (effect.deps !== undefined) {
    effect.flags = Watching | (flags & HasChildEffect);
  }
}

// After a run: drop the dependencies this run stopped reading. An effect that
// disposed itself mid-run has to drop every link instead -- both the previous
// run's (its disposer only saw this run's prefix, since a run starts from an
// empty `depsTail`) and any its reads after the disposer re-created -- rather
// than keep a dead closure subscribed for the lifetime of those sources.
function settleDeps(effect: RuntimeNode): void {
  // With no tail, `purgeDeps` drops every link from the head.
  if (effect.flags === None) effect.depsTail = undefined;
  purgeDeps(effect);
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
  // An owned child also leaves its parent's dependency list, so the parent
  // stops holding a link to a disposed effect.
  const ownerLink = effect.subs;
  if (ownerLink !== undefined) unlinkNode(ownerLink, ownerLink.sub as RuntimeNode);
  if (effect.cleanup !== undefined) {
    try { runCleanup(effect); }
    catch (error) { reportFailure(error); }
  }
}

// Library-internal subscriptions (render stores, direct DOM bindings) must never become owned by whichever user effect is
// running when React or another copy happens to create them synchronously.
function detachedEffect(fn: () => unknown): () => void {
  return effect(fn, true);
}

function effect(fn: () => unknown, detached?: boolean): () => void {
  const node = makeNode("effect", Watching | RecursedCheck);
  node.fn = fn;
  node.cleanup = undefined;
  const dispose = () => disposeEffect(node as RuntimeEffect);
  const previous = activeSub;
  // As in Alien 3.2.1 (and v0.1.x, which used it), an effect created while
  // another effect or computed runs (the only kinds that become `activeSub`)
  // is owned by it: the owner's next run or its disposal disposes the child.
  // A speculative getter has no owner (see `adopt`).
  if (!detached) adopt(dispose, node);
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
    // Library-internal subscriptions leave the queue to the flush that is
    // already due.
    if (queuedLength && !detached) flush();
  }
  return dispose;
}

// Makes an effect a child of the running effect or computed, whose next run or
// disposal unlinks it and so disposes it. With no running subscriber, a
// speculative getter's effects are collected for `evaluateSpeculatively` to
// dispose. A render owner hands this to speculative getters as `own`.
function adopt(disposeChild: () => void, child?: RuntimeNode): void {
  if (child === undefined) {
    child = makeNode("effect", Watching);
    child.cleanup = disposeChild;
  }
  if (activeSub !== undefined) {
    linkNode(child, activeSub, 0);
    activeSub.flags |= HasChildEffect;
  } else speculativeChildren?.push(disposeChild);
}

// A speculative render evaluation has no subscriber to own the effects its
// getter creates and may never be promoted, so they are disposed as soon as
// it returns. Returns whether there were any: such a result is not promoted,
// so the committed computed runs its getter (and creates them) for real.
function evaluateSpeculatively(computed: RuntimeComputed, entry: SpeculativeComputedEntry): boolean {
  const previousSub = activeSub;
  const previousChildren = speculativeChildren;
  const children: Array<() => void> = [];
  const getter = computed.getter;
  activeSub = undefined;
  speculativeChildren = children;
  try {
    entry.value = getter();
  } catch (error) {
    entry.error = error;
    entry.hasError = true;
  } finally {
    activeSub = previousSub;
    speculativeChildren = previousChildren;
    for (const disposeChild of children) disposeChild();
  }
  return children.length > 0;
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
// instance itself; no outer wrapper or per-instance methods.
const brandDescriptor = () => ({ value: SIGNAL_BRAND_VERSION, enumerable: false, writable: false, configurable: false });
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
  constructor(node: RuntimeSource, branded = true) { this.#node = node; if (branded) registerHelperBrand(this); registerReadable(this, node); }
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
    // Reads inside this copy's own effects and computeds: no render attempt is
    // installed (`withGraphOwner` clears it), nothing is untracked or foreign.
    if (currentOwner === graphOwner) return readSource(node) as T;
    const attempt = activeRenderAttempt;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      return renderAdapter.readSource(this, node, attempt) as T;
    }
    if (currentOwner === UNTRACKED_OWNER) return readSourceUntracked(node) as T;
    if (isForeignOwner(currentOwner)) throw multipleCopiesError();
    return readSource(node) as T;
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
  constructor(node: RuntimeSource) { this.#node = node; registerReadable(this, node); }
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
    // Reads inside this copy's own effects and computeds: no render attempt is
    // installed (`withGraphOwner` clears it), nothing is untracked or foreign.
    if (currentOwner === graphOwner) return readSource(node) as T;
    const attempt = activeRenderAttempt;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      return renderAdapter.readSource(this, node, attempt) as T;
    }
    if (currentOwner === UNTRACKED_OWNER) return readSourceUntracked(node) as T;
    if (isForeignOwner(currentOwner)) throw multipleCopiesError();
    return readSource(node) as T;
  }
  set value(value: T) { inlineDeepSignalWrite(this.#node, value); }
  peek(): T { return this.#node.pendingValue as T; }
}
function createBrandedSignal<T>(makeReadable: new (node: RuntimeSource) => RuntimeWritable<T>, initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable);
  node.currentValue = initialValue;
  node.pendingValue = initialValue;
  return new makeReadable(node as RuntimeSource);
}
const signalClassBrandHelper = <T,>(initialValue: T): RuntimeWritable<T> => createBrandedSignal(HelperBrandSignal<T>, initialValue);

class HelperBrandComputed<T = unknown> {
  #node: RuntimeComputed;
  constructor(node: RuntimeComputed, branded = true) {
    this.#node = node;
    if (branded) registerHelperBrand(this);
    registerReadable(this, node);
  }
  get value(): T {
    const node = this.#node;
    const currentOwner = executionContext.owner;
    // See the source getter: this copy's own graph scope needs no other check.
    if (currentOwner === graphOwner) return readComputed(node) as T;
    const attempt = activeRenderAttempt;
    if (attempt !== undefined && isRenderExecutionOwner(currentOwner) && currentOwner.runtimeToken === runtimeToken && renderAdapter !== undefined) {
      return renderAdapter.readComputed(this, node, attempt) as T;
    }
    const owner = currentOwner;
    if (owner !== undefined && isForeignOwner(owner)) throw multipleCopiesError();
    try {
      return readComputed(node, owner !== UNTRACKED_OWNER) as T;
    } finally {
      if (owner === undefined && activeRenderCollector !== undefined) {
        trackRenderDependency(getRenderDependency(this, node) as import("./alien-derived-types.js").RenderReadableDependency);
      }
    }
  }
  peek(): T { return untracked(() => readComputed(this.#node) as T); }
}

class WritableHelperBrandComputed<T = unknown> extends HelperBrandComputed<T> {
  #setter: (value: T) => void;
  constructor(node: RuntimeComputed, setter: (value: T) => void) {
    super(node);
    this.#setter = setter;
  }
  get value(): T { return super.value; }
  set value(value: T) {
    batch(() => untracked(() => this.#setter!(value)));
  }
}
function createBrandedComputed<T>(getter: () => T, setter?: (value: T) => void): RuntimeReadable<T> {
  const node = makeNode("computed", None);
  node.getter = getter;
  node.value = undefined;
  node.error = undefined;
  node.hasError = false;
  node.initialized = false;
  return setter === undefined
    ? new HelperBrandComputed<T>(node as RuntimeComputed)
    : new WritableHelperBrandComputed<T>(node as RuntimeComputed, setter);
}
const computedClassBrandHelper = <T,>(getter: () => T, setter?: (value: T) => void): RuntimeReadable<T> => createBrandedComputed(getter, setter);

function hasBrandAndPeek(value: unknown): value is { peek(): unknown } & object {
  if (typeof value !== "object" || value === null) return false;
  const version = Reflect.get(value, SIGNAL_BRAND);
  return typeof version === "number" && version >= SIGNAL_BRAND_MIN_VERSION && typeof Reflect.get(value, "peek") === "function";
}
const isSignalBrandHelper = hasBrandAndPeek;
function createDeepSignal<T>(initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable);
  node.currentValue = initialValue;
  node.pendingValue = initialValue;
  const readable = new DeepSignalRuntimeSource<T>(node as RuntimeSource);
  deepSignalNodes.add(node);
  return readable;
}
function createDeepSignalVersion<T>(initialValue: T): RuntimeWritable<T> {
  const node = makeNode("source", Mutable);
  node.currentValue = initialValue;
  node.pendingValue = initialValue;
  const readable = new DeepSignalRuntimeSource<T>(node as RuntimeSource);
  deepSignalNodes.add(node);
  return readable;
}
function onDeepSignalUnwatched(readable: object, callback: () => void): void {
  const node = readableNodes.get(readable);
  if (node !== undefined) deepSignalUnwatched.set(node, callback);
}
function markDeepSignalWatched(readable: object): void {
    const node = readableNodes.get(readable);
    if (node !== undefined) deepWatchedNodes.add(node);
  }
function hasDeepSignalSubscribers(readable: object): boolean {
    const node = readableNodes.get(readable);
    return node !== undefined && (
      deepWatchedNodes.has(node) || (deepSignalNodes.has(node) && hasSubscribers(readable))
    );
  }
function getRenderVersion(readable: object): number {
    return getReadableRevision(readable);
  }
function subscribeReadables(readables: readonly RuntimeReadable[], notify: () => void): () => void {
    let initial = true;
    return detachedEffect(() => {
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
    promoteComputed, evaluateSpeculatively, adopt, hasSubscribers, hasActiveSubscriber, getBatchDepth,
    signal: signalClassBrandHelper, computed: computedClassBrandHelper,
    effect, detachedEffect, batch, untracked, SIGNAL_BRAND, isSignal: isSignalBrandHelper,
    createDeepSignal, createDeepSignalVersion, onDeepSignalUnwatched,
    markDeepSignalWatched, hasDeepSignalSubscribers,
    getRenderVersion, subscribeReadables,
  };
}
