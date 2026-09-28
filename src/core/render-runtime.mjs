/* Attempt-local render and speculative adapter for the production graph. */
import { executionContext, pushExecutionOwner } from "./execution-owner.js";
import { activeRenderCollector, setActiveRenderCollector } from "./render-tracking.js";

export function createAlienDerivedRenderAdapter(core) {let activeSpeculativeComputed;
const readablesByNode = new WeakMap();
const collectorFrames = [];
let baseRenderCollector;

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

function createRenderAttempt() {
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

function createRenderOwner(attempt) {
  return {
    version: 2,
    kind: "render",
    runtimeToken: core.runtimeToken,
    add(protocol, revision) { addDependency(attempt, protocol, revision); },
    isSpeculative() { return activeSpeculativeComputed !== undefined; },
    markSpeculativeDeepRead() { attempt.markSpeculativeDeepRead(); },
  };
}

function pushRenderScope(attempt) {
  const restoreAttempt = core.pushRenderAttempt(attempt);
  const owner = createRenderOwner(attempt);
  const restoreOwner = pushExecutionOwner(owner);
  const collector = { add(dependency, revision) { addDependency(attempt, dependency, revision); } };
  if (collectorFrames.length === 0) baseRenderCollector = activeRenderCollector;
  const frame = { collector, active: true };
  collectorFrames.push(frame);
  setActiveRenderCollector(collector);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    frame.active = false;
    while (collectorFrames.at(-1)?.active === false) collectorFrames.pop();
    setActiveRenderCollector(collectorFrames.at(-1)?.collector ?? baseRenderCollector);
    if (collectorFrames.length === 0) baseRenderCollector = undefined;
    restoreAttempt();
    restoreOwner();
  };
}

function withRenderScope(attempt, callback) {
  const restore = pushRenderScope(attempt);
  try { return callback(); }
  finally { restore(); }
}

function promoteRenderAttempt(attempt) {
  for (const [node, entry] of attempt.computedCache) {
    if (!entry.canPromote) continue;
    const readable = readablesByNode.get(node);
    if (readable === undefined || !core.promoteComputed(readable, node, entry)) return false;
  }
  return true;
}

function settleRenderAttempt(attempt) {
  let stable = true;
  for (const [dependency, revision] of attempt.dependencies) {
    const currentRevision = getRenderVersion(dependency);
    if (currentRevision === revision) continue;
    const node = core.getNodeForReadable(dependency);
    const entry = node === undefined ? undefined : attempt.computedCache.get(node);
    if (entry === undefined || !node.initialized || entry.hasError !== node.hasError ||
        (!entry.hasError && !Object.is(entry.value, node.value))) {
      stable = false;
      continue;
    }
    attempt.dependencies.set(dependency, currentRevision);
  }
  return stable;
}

function getRenderVersion(readable) {
  if (readable?.version === 1 && typeof readable.getRevision === "function" &&
      typeof readable.subscribe === "function") return readable.getRevision();
  if (core.getNodeForReadable(readable) !== undefined || readable?.[Symbol.for("react-fine-grained-signals.readable-interop.v1")] !== undefined) {
    return core.getReadableRevision(readable);
  }
  if (typeof readable?.getRenderVersion === "function") return readable.getRenderVersion();
  throw new TypeError("Unknown render dependency");
}
function hasActiveRenderOwner() { return executionContext.owner?.kind === "render"; }
function isSpeculative() {
  const owner = executionContext.owner;
  if (owner?.kind === "graph" || owner?.kind === "untracked") return false;
  return owner?.kind === "render"
    && (owner.isSpeculative?.() === true || activeSpeculativeComputed !== undefined);
}
function markSpeculativeDeepRead() {
  const attempt = core.getActiveRenderAttempt();
  if (attempt !== undefined) attempt.markSpeculativeDeepRead();
  else executionContext.owner?.markSpeculativeDeepRead?.();
}

function subscribeReadables(readables, notify) {
  let initial = true;
  return core.effect(() => {
    for (const readable of readables) {
      try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
    }
    if (initial) initial = false;
    else notify();
  });
}

function captureRenderSnapshot(readable) {
  const attempt = createRenderAttempt();
  let value;
  withRenderScope(attempt, () => { value = readable.value; });
  return { value, dependencies: attempt.dependencies, attempt };
}

function getExecutionOwner() { return executionContext.owner; }
  return {
    createRenderAttempt, createRenderOwner, pushRenderScope, withRenderScope,
    promoteRenderAttempt, settleRenderAttempt, getRenderVersion, hasActiveRenderOwner, isSpeculative,
    markSpeculativeDeepRead, subscribeReadables, captureRenderSnapshot,
    getExecutionOwner,
  };
}
