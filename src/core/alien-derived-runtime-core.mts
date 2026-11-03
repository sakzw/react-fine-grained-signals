/* Production-shaped Alien-derived graph, adapted from Alien Signals 3.2.1.
 * Source: https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee
 * Copyright (c) 2024-present Johnson Chu. See the repository license notice.
 * Imports only alien-signals/system; RFSG APIs and adapters remain local.
 */
import { createReactiveSystem } from "alien-signals/system";
import type { Link, ReactiveFlags, ReactiveNode } from "alien-signals/system";
import {
  UNTRACKED_OWNER,
  executionContext,
  isGraphExecutionOwner,
  isRenderExecutionOwner,
  multipleCopiesError,
  withSynchronousExecutionOwner,
} from "./execution-owner.js";
import type { ExecutionContextOwner, ExecutionOwner, GraphExecutionOwner } from "./execution-owner.js";
import { activeRenderCollector, subscribeToReads, trackRenderDependency } from "./render-tracking.js";
import { stampSignalBrand } from "./signal-brand.js";
import type {
  AlienDerivedGraphRuntime,
  RenderAdapterForCore,
  RenderAttempt,
  RuntimeNode,
  RuntimeSource,
  RuntimeComputed,
  RuntimeEffect,
  RuntimeReadable,
  RuntimeWritable,
  SpeculativeComputedEntry,
} from "./alien-derived-types.js";

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
// RFSG's own: a computed with no subscriber. Alien's linked-list graph never
// sees one, because it holds no links: it records what it read in `snapshot`
// and proves its cached value current by comparing revisions on the next read
// (as Vue 3.5 and Preact do for a computed nothing subscribes to). Linking it
// into its sources' subscriber lists instead would keep its node and getter
// closure reachable from every long-lived source it ever read.
const Detached = 128 as ReactiveFlags;

export function createAlienDerivedRuntime(): AlienDerivedGraphRuntime {
  const runtimeToken = {};
  let renderAdapter: RenderAdapterForCore | undefined;
  let activeRenderAttempt: RenderAttempt | undefined;

  let activeSub: RuntimeNode | undefined;
  // Disposers of effects created by the speculative getter now running.
  let speculativeChildren: Array<() => void> | undefined;
  let cycle = 0;
  // Advances on every value-changing source write: a detached computed checked
  // at the current version needs no revision walk.
  let writeVersion = 0;
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
        detachComputed(node as RuntimeComputed);
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
    return {
      kind,
      flags: flags as ReactiveFlags,
      deps: undefined,
      depsTail: undefined,
      subs: undefined,
      subsTail: undefined,
      renderRevision: 0,
    } as RuntimeNode;
  }

  // Every readable this copy creates, keyed by the public object. Reads and
  // subscriptions resolve their graph node here.
  const readableNodes = new WeakMap<object, RuntimeNode>();
  function registerReadable(readable: object, node: RuntimeNode): void {
    readableNodes.set(readable, node);
  }
  function getNodeForReadable(readable: object): RuntimeNode | undefined {
    return readableNodes.get(readable);
  }
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
        let version = node.renderRevision;
        let changed = false;
        return subscribeToReads(
          detachedEffect,
          () => {
            try {
              readable.value;
            } finally {
              changed = node.renderRevision !== version;
              version = node.renderRevision;
            }
          },
          () => {
            if (changed) listener();
          },
        );
      };
      renderDependencies.set(readable, node);
    }
    return renderDependencies.get(readable)!;
  }

  function readSource(source: RuntimeNode): unknown {
    const value = readSourceUntracked(source);
    if (activeSub !== undefined) trackRead(source, activeSub);
    return value;
  }

  // A detached computed's evaluation records the read; any other subscriber
  // links to it. Repeating the previous read is not recorded twice.
  function trackRead(dependency: RuntimeNode, subscriber: RuntimeNode): void {
    if (subscriber.flags & Detached) {
      const snapshot = subscriber.snapshot!;
      const length = snapshot.length;
      if (length === 0 || snapshot[length - 2] !== dependency) snapshot.push(dependency, dependency.renderRevision);
    } else {
      linkNode(dependency, subscriber, cycle);
    }
  }

  // The read half of `readSource` without linking: a read under
  // UNTRACKED_OWNER must not link to whichever subscriber is running.
  function readSourceUntracked(source: RuntimeNode): unknown {
    if (source.flags & Dirty && updateSource(source)) {
      if (source.subs !== undefined) shallowPropagate(source.subs);
    }
    return source.currentValue;
  }

  // Another copy's graph or render owner is reading. Copies of this package do
  // not interoperate, so a getter that finds one throws instead of reading.
  function isForeignOwner(owner: ExecutionContextOwner | undefined): owner is ExecutionOwner {
    return (isGraphExecutionOwner(owner) || isRenderExecutionOwner(owner)) && owner.runtimeToken !== runtimeToken;
  }

  const graphOwner: GraphExecutionOwner = { kind: "graph", runtimeToken };
  // User callbacks (computed getters, effect bodies) are called as `() => T`:
  // no arguments and no `this`, as in v0.1.1.
  function withGraphOwner<T>(callback: () => T): T {
    const owner = executionContext.owner;
    const previousAttempt = activeRenderAttempt;
    const alreadyOwned = isGraphExecutionOwner(owner) && owner.runtimeToken === runtimeToken;
    if (previousAttempt === undefined && alreadyOwned) return callback();
    activeRenderAttempt = undefined;
    if (!alreadyOwned) executionContext.owner = graphOwner;
    try {
      return callback();
    } finally {
      if (!alreadyOwned) executionContext.owner = owner;
      activeRenderAttempt = previousAttempt;
    }
  }

  function configureRenderAdapter(adapter: RenderAdapterForCore): void {
    renderAdapter = adapter;
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

  function getActiveRenderAttempt() {
    return activeRenderAttempt;
  }
  /** A value change a render that read `node` must see (see `isNodeCurrent`). */
  function bumpRevision(node: RuntimeNode): void {
    node.renderRevision = (node.renderRevision + 1) | 0;
  }

  /**
   * Whether a computed's cached value is current, without running anything. A
   * linked computed is current unless a write marked it; a detached one when
   * every recorded read is still current (see `detachedIsCurrent`, which may
   * re-evaluate dependencies instead).
   */
  function isComputedClean(node: RuntimeNode): boolean {
    if (node.initialized !== true) return false;
    const flags = node.flags;
    if (!(flags & Detached)) return !(flags & (Dirty | Pending));
    if (flags & Dirty) return false;
    if (node.checkedAt === writeVersion) return true;
    const snapshot = node.snapshot!;
    for (let index = 0; index < snapshot.length; index += 2) {
      if (!isNodeCurrent(snapshot[index] as RuntimeNode, snapshot[index + 1] as number)) return false;
    }
    node.checkedAt = writeVersion;
    return true;
  }

  /**
   * Whether a dependency a render or speculative read recorded at `revision`
   * is still what it read. Sources bump their revision on every value-changing
   * write. A computed's revision only moves when it re-evaluates, so it also
   * has to be clean: a write upstream marks a linked computed dirty or pending,
   * and a detached one fails its revision check.
   */
  function isNodeCurrent(node: RuntimeNode, revision: number): boolean {
    return node.renderRevision === revision && (node.kind !== "computed" || isComputedClean(node));
  }

  function promoteComputed(readable: object, node: RuntimeNode, entry: SpeculativeComputedEntry): boolean {
    // Already initialized, by a real read or another attempt's promotion: both
    // advance `renderRevision`, so `settleRenderAttempt` compares this attempt's
    // value with the node's rather than trusting the revision it recorded.
    if (node.initialized) return true;
    // Never evaluated, so detached: the promoted value is cached through the
    // revisions the speculative read saw, and links only when subscribed
    // (`attachComputed`, which also settles the sources it links).
    const computed = node as RuntimeComputed;
    const snapshot: Array<RuntimeNode | number> = [];
    for (const [dependency, revision] of entry.dependencies) {
      const dependencyNode = readableNodes.get(dependency);
      if (dependencyNode === undefined) throw new TypeError("Unknown candidate readable");
      // Keep a dependency only in the state the speculative read observed, the
      // same test as cache reuse (`isEntryCurrent`).
      if (!isNodeCurrent(dependencyNode, revision)) return false;
      snapshot.push(dependencyNode, revision);
    }
    computed.snapshot = snapshot;
    computed.checkedAt = writeVersion;
    computed.value = entry.value;
    computed.error = entry.error;
    computed.hasError = entry.hasError;
    computed.initialized = true;
    computed.flags = Mutable | Detached;
    // Initialization is a value change, as in `updateComputed`, so any other
    // attempt that read this computed before it existed re-checks its value.
    bumpRevision(computed);
    return true;
  }

  function hasSubscribers(readable: object): boolean {
    return readableNodes.get(readable)?.subs !== undefined;
  }
  function hasActiveSubscriber(): boolean {
    return activeSub !== undefined;
  }
  function getBatchDepth(): number {
    return batchDepth;
  }

  function updateSource(source: RuntimeNode): boolean {
    source.flags = Mutable;
    const changed = !Object.is(source.currentValue, (source.currentValue = source.pendingValue));
    return changed;
  }

  function readComputed(computed: RuntimeComputed, track = true): unknown {
    // RecursedCheck is set on a computed only while its own getter runs, so a
    // read of it from inside that run -- directly, or through computeds the run
    // evaluates -- is a cycle and throws here. A cycle that only forms after a
    // write (a branch starts reading a computed that already depends on this
    // one) is not always caught: a computed on it whose cached value still
    // passes its check returns that value instead of re-entering a getter, so
    // the read sees a stale intermediate value rather than this error.
    const flags = computed.flags;
    if (flags & RecursedCheck) {
      throw new Error("Computed cycle detected");
    }
    const subscriber = track ? activeSub : undefined;
    if (subscriber === undefined) {
      // The hot cases (nothing written since the last check, or a clean
      // linked computed) stay inline.
      if (flags & Detached) {
        if ((flags & Dirty || computed.checkedAt !== writeVersion) && !detachedIsCurrent(computed)) {
          updateComputed(computed);
        }
      } else {
        if (flags & (Dirty | Pending)) refreshLinkedComputed(computed);
        // A linked computed whose last subscriber left while it was running.
        if (computed.subs === undefined) detachComputed(computed);
      }
    } else if (subscriber.flags & Detached) {
      refreshComputed(computed);
      trackRead(computed, subscriber);
    } else {
      // Gaining a subscriber: a detached computed links in its current state.
      if (flags & Detached) {
        if (detachedIsCurrent(computed)) attachComputed(computed);
        else {
          computed.snapshot = undefined;
          computed.flags = Mutable | Dirty;
        }
      }
      refreshLinkedComputed(computed);
      linkNode(computed, subscriber, cycle);
    }
    if (computed.hasError) throw computed.error;
    return computed.value;
  }

  /** Brings a computed's cached value up to date without linking it to anything. */
  function refreshComputed(computed: RuntimeComputed): void {
    if (!(computed.flags & Detached)) refreshLinkedComputed(computed);
    else if (!detachedIsCurrent(computed)) updateComputed(computed);
  }

  function refreshLinkedComputed(computed: RuntimeComputed): void {
    const flags = computed.flags;
    if (
      flags & Dirty ||
      (flags & Pending &&
        ((computed.deps !== undefined && checkDirty(computed.deps, computed as unknown as ReactiveNode)) ||
          ((computed.flags = flags & ~Pending), false)))
    ) {
      if (updateComputed(computed) && computed.subs !== undefined) shallowPropagate(computed.subs);
    }
  }

  /**
   * Whether a detached computed's cached value is current: nothing was written
   * since it was last checked, or every read it recorded still has the
   * revision it saw, in read order, after bringing a computed one up to date
   * first (so a branch the getter no longer takes is never evaluated).
   */
  function detachedIsCurrent(computed: RuntimeComputed): boolean {
    if (computed.flags & Dirty) return false;
    const version = writeVersion;
    if (computed.checkedAt === version) return true;
    const snapshot = computed.snapshot!;
    for (let index = 0; index < snapshot.length; index += 2) {
      const dependency = snapshot[index] as RuntimeNode;
      if (dependency.kind === "computed" && !(dependency.flags & RecursedCheck)) {
        refreshComputed(dependency as RuntimeComputed);
      }
      if (dependency.renderRevision !== snapshot[index + 1]) return false;
    }
    computed.checkedAt = version;
    return true;
  }

  /**
   * Links a current detached computed to what it recorded, linking any
   * detached computed among those first, so a write reaches its new
   * subscriber. A source is settled before linking, as Alien's own signal read
   * does: a promoted computed may have seen its pending value only, and a later
   * write back to the stale committed value would compare equal and stop.
   */
  function attachComputed(computed: RuntimeComputed): void {
    const snapshot = computed.snapshot!;
    computed.snapshot = undefined;
    computed.flags = Mutable;
    computed.depsTail = undefined;
    cycle += 1;
    const version = cycle;
    for (let index = 0; index < snapshot.length; index += 2) {
      const dependency = snapshot[index] as RuntimeNode;
      if (dependency.kind === "source") readSourceUntracked(dependency);
      else if (dependency.flags & Detached) {
        const dependencyComputed = dependency as RuntimeComputed;
        if (detachedIsCurrent(dependencyComputed)) attachComputed(dependencyComputed);
        else {
          // Not expected (a current computed's reads are current), but stay
          // correct: link it dirty, and check through it on the next read.
          dependencyComputed.snapshot = undefined;
          dependencyComputed.flags = Mutable | Dirty;
          computed.flags = Mutable | Pending;
        }
      }
      linkNode(dependency, computed, version);
    }
  }

  /**
   * The last subscriber left (Alien's `unwatched`), or a read found none: drop
   * every link, keeping the reads as revisions when the cached value is
   * current. Child effects are disposed with their links. Each dependency
   * left with no subscriber detaches in turn.
   */
  function detachComputed(computed: RuntimeComputed): void {
    const flags = computed.flags;
    // Still running: its run finishes linked and dirty, and the next read
    // without a subscriber detaches it.
    if (flags & RecursedCheck) {
      computed.flags = flags | Dirty;
      return;
    }
    let snapshot: Array<RuntimeNode | number> | undefined;
    if (computed.initialized && !(flags & (Dirty | Pending))) {
      snapshot = [];
      for (let link = computed.deps; link !== undefined; link = link.nextDep) {
        const dependency = link.dep as RuntimeNode;
        if (dependency.kind !== "effect") snapshot.push(dependency, dependency.renderRevision);
      }
    }
    computed.snapshot = snapshot;
    computed.checkedAt = writeVersion;
    computed.flags = snapshot === undefined ? Mutable | Detached | Dirty : Mutable | Detached;
    computed.depsTail = undefined;
    purgeDeps(computed);
  }

  function updateComputed(computed: RuntimeComputed): boolean {
    const detached = computed.flags & Detached;
    if (computed.flags & HasChildEffect) disposeChildEffects(computed);
    computed.depsTail = undefined;
    computed.flags = Mutable | RecursedCheck | detached;
    // A detached run records its reads afresh; a write the getter itself makes
    // leaves it unchecked at the version that follows.
    const version = writeVersion;
    // A fresh array: truncating the previous one measured about twice as slow.
    if (detached) computed.snapshot = [];
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
      if (changed) bumpRevision(computed);
      return changed;
    } finally {
      activeSub = previous;
      computed.flags &= ~RecursedCheck;
      if (detached) {
        // Its only links are effects the getter created: with no subscriber
        // to own them they are disposed now, as an unwatched computed's are.
        computed.flags &= ~HasChildEffect;
        computed.checkedAt = version;
        computed.depsTail = undefined;
      }
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
    if (
      flags & Dirty ||
      (flags & Pending && effect.deps !== undefined && checkDirty(effect.deps, effect as unknown as ReactiveNode))
    ) {
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
      runEffectBody(effect);
    } else if (effect.deps !== undefined) {
      effect.flags = Watching | (flags & HasChildEffect);
    }
  }

  /**
   * One run of an effect's body, the first (`effect()`) and every later one
   * (`runEffect`) alike: the body is this effect's subscriber scope, its
   * returned cleanup is kept, and the dependencies settle afterwards. An
   * effect the body disposed (its own disposer, or an owner's) runs that
   * cleanup now, since nothing will dispose it again.
   */
  function runEffectBody(effect: RuntimeEffect): void {
    const previous = activeSub;
    activeSub = effect;
    try {
      cycle += 1;
      runDepth += 1;
      const cleanup: unknown = withGraphOwner(effect.fn);
      effect.cleanup = typeof cleanup === "function" ? (cleanup as () => unknown) : undefined;
      if (!effect.flags && effect.cleanup !== undefined) runCleanup(effect);
    } finally {
      runDepth -= 1;
      activeSub = previous;
      effect.flags &= ~RecursedCheck;
      settleDeps(effect);
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
      console.error(
        "react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish.",
        { cause: error },
      );
    } catch {
      /* Reporting must not interrupt scheduler progress. */
    }
    try {
      const report = globalThis.reportError;
      if (typeof report === "function") report.call(globalThis, error);
    } catch {
      /* Keep a failing host reporter from escaping the runtime. */
    }
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
    const cleanup = effect.cleanup!;
    effect.cleanup = undefined;
    return untracked(cleanup);
  }

  function disposeEffect(effect: RuntimeEffect): void {
    effect.flags = None;
    disposeDeps(effect);
    // An owned child also leaves its parent's dependency list, so the parent
    // stops holding a link to a disposed effect.
    const ownerLink = effect.subs;
    if (ownerLink !== undefined) unlinkNode(ownerLink, ownerLink.sub as RuntimeNode);
    if (effect.cleanup !== undefined) {
      try {
        runCleanup(effect);
      } catch (error) {
        reportFailure(error);
      }
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
    // As in Alien 3.2.1 (and v0.1.x, which used it), an effect created while
    // another effect or computed runs (the only kinds that become `activeSub`)
    // is owned by it: the owner's next run or its disposal disposes the child.
    // A speculative getter has no owner (see `adopt`).
    if (!detached) adopt(dispose, node);
    try {
      runEffectBody(node as RuntimeEffect);
    } catch (error) {
      // A throwing first run is reported here, not by a flush; the effect
      // stays subscribed to what it read before throwing.
      node.cleanup = undefined;
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

  /**
   * `batch(() => untracked(fn))` in one frame: a write made on the caller's
   * behalf (a writable computed's setter, a deep-signal mutation) that must
   * neither subscribe the running effect nor flush before it is complete.
   */
  function batchUntracked<T>(fn: () => T): T {
    batchDepth += 1;
    try {
      return untracked(fn);
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
    try {
      return withSynchronousExecutionOwner(UNTRACKED_OWNER, fn);
    } finally {
      activeRenderAttempt = previousAttempt;
      activeSub = previous;
    }
  }

  // Public API/brand candidates. Each public object is the readable class
  // instance itself; no outer wrapper or per-instance methods.
  const registerHelperBrand = stampSignalBrand;

  function inlineWrite(node: RuntimeSource, value: unknown): void {
    if (!Object.is(node.pendingValue, (node.pendingValue = value))) {
      bumpRevision(node);
      writeVersion += 1;
      node.flags = Mutable | Dirty;
      const subscribers = node.subs;
      if (subscribers !== undefined) {
        propagate(subscribers, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }

  function collectRenderRead(readable: object, node: RuntimeNode): void {
    trackRenderDependency(
      getRenderDependency(
        readable as { value: unknown },
        node,
      ) as import("./alien-derived-types.js").RenderReadableDependency,
    );
  }

  /**
   * The `.value` read of a public signal or computed by any reader other than
   * the two hot cases each getter handles itself (no owner, and this copy's
   * own effects and computeds). Both getters share it, so the render-attempt,
   * untracked and other-copy rules cannot drift between them; only the read
   * itself (`readSource` or `readComputed`) differs. Kept out of the getters
   * so they stay small enough to inline: one shared getter body measured up
   * to 20% slower on the hot cases.
   */
  function readOwned(
    readable: object,
    node: RuntimeSource | RuntimeComputed,
    currentOwner: ExecutionContextOwner,
    computed: boolean,
  ): unknown {
    const attempt = activeRenderAttempt;
    if (
      attempt !== undefined &&
      isRenderExecutionOwner(currentOwner) &&
      currentOwner.runtimeToken === runtimeToken &&
      renderAdapter !== undefined
    ) {
      return computed
        ? renderAdapter.readComputed(readable as never, node as RuntimeComputed, attempt)
        : renderAdapter.readSource(readable as never, node as RuntimeSource, attempt);
    }
    if (currentOwner === UNTRACKED_OWNER) {
      return computed ? readComputed(node as RuntimeComputed, false) : readSourceUntracked(node);
    }
    if (isForeignOwner(currentOwner)) throw multipleCopiesError();
    return computed ? readComputed(node as RuntimeComputed) : readSource(node);
  }

  class HelperBrandSignal<T = unknown> {
    #node: RuntimeSource;
    // A deep-signal source is unbranded, and every write first clears its
    // watched flag so liveness bookkeeping stays exact (even for an equal write).
    readonly #deep: boolean;
    constructor(node: RuntimeSource, branded = true, deep = false) {
      this.#node = node;
      this.#deep = deep;
      if (branded) registerHelperBrand(this);
      registerReadable(this, node);
    }
    get value(): T {
      const node = this.#node;
      const currentOwner = executionContext.owner;
      // A render attempt is installed with its render owner. Ordinary owner-free
      // reads can skip speculative-render dispatch while preserving collection.
      if (currentOwner === undefined) {
        const value = readSource(node);
        if (activeRenderCollector !== undefined) collectRenderRead(this, node);
        return value as T;
      }
      // Reads inside this copy's own effects and computeds: no render attempt is
      // installed (`withGraphOwner` clears it), nothing is untracked or foreign.
      if (currentOwner === graphOwner) return readSource(node) as T;
      return readOwned(this, node, currentOwner, false) as T;
    }
    set value(value: T) {
      if (this.#deep) deepWatchedNodes.delete(this.#node);
      inlineWrite(this.#node, value);
    }
    peek(): T {
      return this.#node.pendingValue as T;
    }
  }

  function createBrandedSignal<T>(
    makeReadable: new (node: RuntimeSource) => RuntimeWritable<T>,
    initialValue: T,
  ): RuntimeWritable<T> {
    const node = makeNode("source", Mutable);
    node.currentValue = initialValue;
    node.pendingValue = initialValue;
    return new makeReadable(node as RuntimeSource);
  }
  const signalClassBrandHelper = <T,>(initialValue: T): RuntimeWritable<T> =>
    createBrandedSignal(HelperBrandSignal<T>, initialValue);

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
      // See the source getter. A computed that throws is still collected, so
      // its component re-renders when it recovers.
      if (currentOwner === undefined) {
        try {
          return readComputed(node) as T;
        } finally {
          if (activeRenderCollector !== undefined) collectRenderRead(this, node);
        }
      }
      if (currentOwner === graphOwner) return readComputed(node) as T;
      return readOwned(this, node, currentOwner, true) as T;
    }
    peek(): T {
      return untracked(() => readComputed(this.#node) as T);
    }
  }

  class WritableHelperBrandComputed<T = unknown> extends HelperBrandComputed<T> {
    #setter: (value: T) => void;
    constructor(node: RuntimeComputed, setter: (value: T) => void) {
      super(node);
      this.#setter = setter;
    }
    get value(): T {
      return super.value;
    }
    set value(value: T) {
      batchUntracked(() => this.#setter!(value));
    }
  }
  function createBrandedComputed<T>(getter: () => T, setter?: (value: T) => void): RuntimeReadable<T> {
    // Detached until something subscribes, and dirty until first evaluated.
    const node = makeNode("computed", Mutable | Detached | Dirty);
    node.getter = getter;
    node.value = undefined;
    node.error = undefined;
    node.hasError = false;
    node.initialized = false;
    node.snapshot = undefined;
    node.checkedAt = -1;
    return setter === undefined
      ? new HelperBrandComputed<T>(node as RuntimeComputed)
      : new WritableHelperBrandComputed<T>(node as RuntimeComputed, setter);
  }
  const computedClassBrandHelper = <T,>(getter: () => T, setter?: (value: T) => void): RuntimeReadable<T> =>
    createBrandedComputed(getter, setter);

  function createDeepSignal<T>(initialValue: T): RuntimeWritable<T> {
    const node = makeNode("source", Mutable);
    node.currentValue = initialValue;
    node.pendingValue = initialValue;
    const readable = new HelperBrandSignal<T>(node as RuntimeSource, false, true);
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
    return (
      node !== undefined && (deepWatchedNodes.has(node) || (deepSignalNodes.has(node) && hasSubscribers(readable)))
    );
  }

  return {
    runtimeToken,
    graphOwner,
    configureRenderAdapter,
    pushRenderAttempt,
    getActiveRenderAttempt,
    getNodeForReadable,
    getReadableRevision,
    isComputedClean,
    isNodeCurrent,
    promoteComputed,
    evaluateSpeculatively,
    hasSubscribers,
    hasActiveSubscriber,
    getBatchDepth,
    signal: signalClassBrandHelper,
    computed: computedClassBrandHelper,
    effect,
    detachedEffect,
    batch,
    batchUntracked,
    untracked,
    createDeepSignal,
    createDeepSignalVersion: createDeepSignal,
    onDeepSignalUnwatched,
    markDeepSignalWatched,
    hasDeepSignalSubscribers,
  };
}
