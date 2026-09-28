import * as core from "./alien-derived-runtime-owner-core.mjs";
import { executionContext, pushExecutionOwner } from "./alien-derived-runtime-execution-owner.mjs";

let activeSpeculativeComputed;
const readablesByNode = new WeakMap();

function addDependency(attempt, dependency, revision) {
  const node = core.getNodeForReadable(dependency);
  if (node !== undefined) readablesByNode.set(node, dependency);
  if (activeSpeculativeComputed !== undefined) {
    activeSpeculativeComputed.dependencies.set(dependency, revision);
  } else {
    attempt.add(dependency, revision);
  }
}

function readSource(readable, node, attempt) {
  addDependency(attempt, readable, node.renderRevision);
  return node.pendingValue;
}

function readComputed(readable, node, attempt) {
  if (activeSpeculativeComputed !== undefined && activeSpeculativeComputed !== node) {
    const restoreAttempt = core.pushRenderAttempt(undefined);
    try { return readable.value; }
    finally {
      addDependency(attempt, readable, node.renderRevision);
      restoreAttempt();
    }
  }
  addDependency(attempt, readable, node.renderRevision);
  const cache = attempt.computedCache;
  let entry = cache.get(node);
  if (entry !== undefined) {
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
  try {
    entry.value = node.getter(node.value);
  } catch (error) {
    entry.error = error;
    entry.hasError = true;
  } finally {
    activeSpeculativeComputed = previous;
    entry.canPromote = deepReadEpoch === attempt.speculativeDeepReadEpoch;
  }
  if (entry.hasError) throw entry.error;
  return entry.value;
}

core.configureRenderAdapter({ readSource, readComputed });

export function createRenderAttempt() {
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

export function createRenderOwner(attempt) {
  return {
    kind: "render",
    runtimeToken: core.runtimeToken,
    add(protocol, revision) { addDependency(attempt, protocol, revision); },
    isSpeculative() { return activeSpeculativeComputed !== undefined; },
    markSpeculativeDeepRead() { attempt.markSpeculativeDeepRead(); },
  };
}

export function pushRenderScope(attempt) {
  const restoreAttempt = core.pushRenderAttempt(attempt);
  const owner = createRenderOwner(attempt);
  const restoreOwner = pushExecutionOwner(owner);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    restoreAttempt();
    restoreOwner();
  };
}

export function withRenderScope(attempt, callback) {
  const restore = pushRenderScope(attempt);
  try { return callback(); }
  finally { restore(); }
}

export function promoteRenderAttempt(attempt) {
  for (const [node, entry] of attempt.computedCache) {
    if (!entry.canPromote) continue;
    const readable = readablesByNode.get(node);
    if (readable === undefined || !core.promoteComputed(readable, node, entry)) return false;
  }
  return true;
}

export function getRenderVersion(readable) { return core.getReadableRevision(readable); }
export function hasActiveRenderOwner() { return executionContext.owner?.kind === "render"; }
export function isSpeculative() {
  const owner = executionContext.owner;
  if (owner?.kind === "graph" || owner?.kind === "untracked") return false;
  return owner?.kind === "render"
    && (owner.isSpeculative?.() === true || activeSpeculativeComputed !== undefined);
}
export function markSpeculativeDeepRead() {
  const attempt = core.getActiveRenderAttempt();
  if (attempt !== undefined) attempt.markSpeculativeDeepRead();
  else executionContext.owner?.markSpeculativeDeepRead?.();
}

export function subscribeReadables(readables, notify) {
  let initial = true;
  return core.effect(() => {
    for (const readable of readables) {
      try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
    }
    if (initial) initial = false;
    else notify();
  });
}

export function captureRenderSnapshot(readable) {
  const attempt = createRenderAttempt();
  let value;
  withRenderScope(attempt, () => { value = readable.value; });
  return { value, dependencies: attempt.dependencies, attempt };
}

export function getExecutionOwner() { return executionContext.owner; }
