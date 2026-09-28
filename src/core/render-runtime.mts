/* Attempt-local render and speculative adapter for the production graph. */
import { executionContext, isGraphExecutionOwner, isRenderExecutionOwner, pushExecutionOwner, UNTRACKED_OWNER } from "./execution-owner.js";
import type { RenderExecutionOwnerV2 } from "./execution-owner.js";
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

function createRenderOwner(attempt: RenderAttempt, scopePolicy: "managed" | "bare" = "managed"): RenderExecutionOwnerV2 {
  return {
    version: 2 as const,
    kind: "render" as const,
    scopePolicy,
    runtimeToken: core.runtimeToken,
    add(protocol, revision) { addDependency(attempt, protocol, revision); },
    isSpeculative() { return activeSpeculativeComputed !== undefined; },
    markSpeculativeDeepRead() { attempt.markSpeculativeDeepRead(); },
  };
}

function pushRenderScope(attempt: RenderAttempt, scopePolicy: "managed" | "bare" = "managed"): () => void {
  const parent = executionContext.owner;
  if (isRenderExecutionOwner(parent) && !(parent.scopePolicy === "managed" && scopePolicy === "managed")) {
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

function withRenderScope<T>(attempt: RenderAttempt, callback: () => T, scopePolicy: "managed" | "bare" = "managed"): T {
  const restore = pushRenderScope(attempt, scopePolicy);
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

function getRenderVersion(readable: object): number {
  if (Reflect.get(readable, "version") === 1 && typeof Reflect.get(readable, "getRevision") === "function" &&
      typeof Reflect.get(readable, "subscribe") === "function") return (Reflect.get(readable, "getRevision") as () => number).call(readable);
  if (core.getNodeForReadable(readable) !== undefined || Reflect.get(readable, Symbol.for("react-fine-grained-signals.readable-interop.v1")) !== undefined) {
    return core.getReadableRevision(readable);
  }
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
  return core.effect(() => {
    for (const readable of readables) {
      try { readable.value; } catch { /* Keep errored computed boundaries observed. */ }
    }
    if (initial) initial = false;
    else notify();
  });
}

function captureRenderSnapshot(readable: RuntimeReadable): { value: unknown; dependencies: Map<object, number>; attempt: RenderAttempt } {
  const attempt = createRenderAttempt();
  let value: unknown;
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
