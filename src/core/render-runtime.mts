/* Attempt-local render and speculative adapter for the production graph. */
import { executionContext, isGraphExecutionOwner, isRenderExecutionOwner, pushExecutionOwner, UNTRACKED_OWNER } from "./execution-owner.js";
import type { RenderExecutionOwner } from "./execution-owner.js";
import { activeRenderCollector, setActiveRenderCollector } from "./render-tracking.js";
import type { RenderCollector } from "./render-tracking.js";
import type { AlienDerivedGraphRuntime, RenderAttempt, RenderReadableDependency, RuntimeComputed, RuntimeNode, RuntimeReadable, RuntimeSource, SpeculativeComputedEntry } from "./alien-derived-types.js";

export function createAlienDerivedRenderAdapter(core: AlienDerivedGraphRuntime) {
let activeSpeculativeComputed: SpeculativeComputedEntry | undefined;
const readablesByNode = new WeakMap<RuntimeNode, object>();
const collectorFrames: Array<{ collector: RenderCollector; active: boolean }> = [];
let baseRenderCollector: RenderCollector | undefined;

function addDependency(attempt: RenderAttempt, dependency: object, revision: number): void {
  const node = core.getNodeForReadable(dependency);
  if (node !== undefined) readablesByNode.set(node, dependency);
  if (activeSpeculativeComputed !== undefined) {
    activeSpeculativeComputed.dependencies.set(dependency, revision);
  } else {
    attempt.add(dependency, revision);
  }
}

function readSource(readable: object, node: RuntimeSource, attempt: RenderAttempt): unknown {
  addDependency(attempt, readable, node.renderRevision);
  return node.pendingValue;
}

function readComputed(readable: object, node: RuntimeComputed, attempt: RenderAttempt): unknown {
  if (activeSpeculativeComputed !== undefined) {
    const restoreAttempt = core.pushRenderAttempt(undefined);
    try { return (readable as RuntimeReadable).value; }
    finally {
      addDependency(attempt, readable, node.renderRevision);
      restoreAttempt();
    }
  }
  addDependency(attempt, readable, node.renderRevision);
  const cache = attempt.computedCache;
  let entry = cache.get(node);
  // A speculative result is only reusable while every dependency it read is
  // still at the revision it saw. An attempt can outlive its render (a bare
  // scope stays open until commit or a microtask, and on the server nothing
  // ever commits), so this is what keeps "read, write, read again" from
  // returning the old value. Checked here, on reuse, so writes pay nothing.
  if (entry !== undefined && isEntryCurrent(entry)) {
    if (entry.hasError) throw entry.error;
    return entry.value;
  }
  if (core.isComputedClean(node)) {
    if (node.hasError) throw node.error;
    return node.value;
  }

  entry = {
    dependencies: new Map(),
    value: undefined,
    error: undefined,
    hasError: false,
    canPromote: false,
  };
  cache.set(node, entry);
  const previous = activeSpeculativeComputed;
  activeSpeculativeComputed = entry;
  const deepReadEpoch = attempt.speculativeDeepReadEpoch;
  let createdEffects = false;
  try {
    createdEffects = core.evaluateSpeculatively(node, entry);
  } finally {
    activeSpeculativeComputed = previous;
    entry.canPromote = !createdEffects && deepReadEpoch === attempt.speculativeDeepReadEpoch;
  }
  if (entry.hasError) throw entry.error;
  return entry.value;
}

// Sources bump their revision on every value-changing write. A computed's
// revision only moves when it re-evaluates, so it also has to be clean (a
// write upstream marks even an unwatched computed dirty or pending, since
// computeds stay linked to their sources).
function isEntryCurrent(entry: SpeculativeComputedEntry): boolean {
  for (const [dependency, revision] of entry.dependencies) {
    const node = core.getNodeForReadable(dependency);
    if (node === undefined) {
      if (getRenderVersion(dependency) !== revision) return false;
    } else if (node.renderRevision !== revision || (node.kind === "computed" && !core.isComputedClean(node))) {
      return false;
    }
  }
  return true;
}

core.configureRenderAdapter({ readSource, readComputed });

function createRenderAttempt(): RenderAttempt {
  return {
    dependencies: new Map(),
    computedCache: new Map(),
    speculativeDeepReadEpoch: 0,
    add(dependency, revision) {
      if (!this.dependencies.has(dependency)) this.dependencies.set(dependency, revision);
    },
    markSpeculativeDeepRead() { this.speculativeDeepReadEpoch += 1; },
  };
}

function createRenderOwner(attempt: RenderAttempt, scopePolicy: "managed" | "bare" = "managed"): RenderExecutionOwner {
  return {
    kind: "render" as const,
    scopePolicy,
    runtimeToken: core.runtimeToken,
    isSpeculative() { return activeSpeculativeComputed !== undefined; },
    markSpeculativeDeepRead() { attempt.markSpeculativeDeepRead(); },
    own: core.adopt,
  };
}

// `suspendParent` is set by a caller that has proved the open parent is the
// calling component's own bare window: the new scope then sits on top of it and
// popping it hands collection back, instead of closing it. Without the proof
// the parent is a previous component's leftover and is closed.
function pushRenderScope(attempt: RenderAttempt, scopePolicy: "managed" | "bare" = "managed", suspendParent = false): () => void {
  const parent = executionContext.owner;
  if (!suspendParent && isRenderExecutionOwner(parent) && !(parent.scopePolicy === "managed" && scopePolicy === "managed")) {
    parent.closeScope?.();
  }
  const restoreAttempt = core.pushRenderAttempt(attempt);
  const owner = createRenderOwner(attempt, scopePolicy);
  const restoreOwner = pushExecutionOwner(owner);
  const collector: RenderCollector = { add(dependency: RenderReadableDependency, revision: number) { addDependency(attempt, dependency, revision); } };
  if (collectorFrames.length === 0) baseRenderCollector = activeRenderCollector;
  const frame = { collector, active: true };
  collectorFrames.push(frame);
  setActiveRenderCollector(collector);
  let active = true;
  const restoreScope = () => {
    if (!active) return;
    active = false;
    frame.active = false;
    while (collectorFrames.at(-1)?.active === false) collectorFrames.pop();
    setActiveRenderCollector(collectorFrames.at(-1)?.collector ?? baseRenderCollector);
    if (collectorFrames.length === 0) baseRenderCollector = undefined;
    restoreAttempt();
    restoreOwner();
  };
  owner.closeScope = restoreScope;
  return restoreScope;
}

function withRenderScope<T>(attempt: RenderAttempt, callback: () => T, scopePolicy: "managed" | "bare" = "managed", suspendParent = false): T {
  const restore = pushRenderScope(attempt, scopePolicy, suspendParent);
  try { return callback(); }
  finally { restore(); }
}

function promoteRenderAttempt(attempt: RenderAttempt): boolean {
  for (const [node, entry] of attempt.computedCache) {
    if (!entry.canPromote) continue;
    const readable = readablesByNode.get(node);
    if (readable === undefined || !core.promoteComputed(readable, node, entry)) return false;
  }
  return true;
}

function settleRenderAttempt(attempt: RenderAttempt): boolean {
  let stable = true;
  for (const [dependency, revision] of attempt.dependencies) {
    const currentRevision = getRenderVersion(dependency);
    if (currentRevision === revision) continue;
    const node = core.getNodeForReadable(dependency);
    const entry = node === undefined ? undefined : attempt.computedCache.get(node);
    if (node === undefined || entry === undefined || node.initialized !== true || entry.hasError !== node.hasError ||
        (!entry.hasError && !Object.is(entry.value, node.value))) {
      stable = false;
      continue;
    }
    attempt.dependencies.set(dependency, currentRevision);
  }
  return stable;
}

/**
 * Whether everything the attempt rendered from is still what it read, without
 * changing the attempt. A computed's revision only moves when it re-evaluates,
 * so one a later write left dirty would look unchanged by revision alone: its
 * speculative entry is checked through its sources instead, and a computed the
 * render read clean must still be clean. A computed that re-evaluated to an
 * equal value reads as changed here; `settleRenderAttempt` decides that case
 * at commit, so this can only ask for an extra render, never hide a change.
 */
function isRenderAttemptCurrent(attempt: RenderAttempt): boolean {
  for (const [dependency, revision] of attempt.dependencies) {
    if (getRenderVersion(dependency) !== revision) return false;
    const node = core.getNodeForReadable(dependency);
    if (node?.kind !== "computed") continue;
    const entry = attempt.computedCache.get(node);
    if (entry === undefined ? !core.isComputedClean(node) : !isEntryCurrent(entry)) return false;
  }
  return true;
}

function getRenderVersion(readable: object): number {
  if (core.getNodeForReadable(readable) !== undefined) return core.getReadableRevision(readable);
  const getVersion = Reflect.get(readable, "getRenderVersion");
  if (typeof getVersion === "function") return getVersion.call(readable) as number;
  throw new TypeError("Unknown render dependency");
}
function hasActiveRenderOwner(): boolean { return isRenderExecutionOwner(executionContext.owner); }
function isSpeculative() {
  const owner = executionContext.owner;
  if (isGraphExecutionOwner(owner) || owner === UNTRACKED_OWNER) return false;
  return isRenderExecutionOwner(owner)
    && (owner.isSpeculative?.() === true || activeSpeculativeComputed !== undefined);
}
function markSpeculativeDeepRead(): void {
  const attempt = core.getActiveRenderAttempt();
  if (attempt !== undefined) attempt.markSpeculativeDeepRead();
  else if (isRenderExecutionOwner(executionContext.owner)) executionContext.owner.markSpeculativeDeepRead?.();
}

function subscribeReadables(readables: readonly RuntimeReadable[], notify: () => void): () => void {
  let initial = true;
  return core.detachedEffect(() => {
    for (const readable of readables) {
      try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
    }
    if (initial) initial = false;
    else notify();
  });
}

function getExecutionOwner() { return executionContext.owner; }
  return {
    createRenderAttempt, createRenderOwner, pushRenderScope, withRenderScope,
    promoteRenderAttempt, settleRenderAttempt, isRenderAttemptCurrent, getRenderVersion, hasActiveRenderOwner, isSpeculative,
    markSpeculativeDeepRead, subscribeReadables,
    getExecutionOwner,
  };
}
