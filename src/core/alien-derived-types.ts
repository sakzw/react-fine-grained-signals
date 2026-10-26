import type { Link, ReactiveNode } from "alien-signals/system";
import type { GraphExecutionOwnerV2 } from "./execution-owner.js";

export type RuntimeNodeKind = "source" | "computed" | "effect";

/** RFSG metadata layered onto one Alien Signals graph node. */
export interface RuntimeNode extends Omit<ReactiveNode, "deps" | "depsTail" | "subs" | "subsTail" | "flags"> {
  kind: RuntimeNodeKind;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
  flags: number;
  renderRevision: number;
  currentValue?: unknown | undefined;
  pendingValue?: unknown | undefined;
  getter?: (() => unknown) | undefined;
  value?: unknown | undefined;
  error?: unknown | undefined;
  hasError?: boolean | undefined;
  initialized?: boolean | undefined;
  fn?: (() => unknown) | undefined;
  cleanup?: (() => unknown) | undefined;
  getRenderVersion?: (() => number) | undefined;
  subscribeRender?: ((listener: () => void) => () => void) | undefined;
}

export interface RuntimeSource extends RuntimeNode {
  kind: "source";
  currentValue: unknown;
  pendingValue: unknown;
}

export interface RuntimeComputed extends RuntimeNode {
  kind: "computed";
  getter: () => unknown;
  value: unknown;
  error: unknown;
  hasError: boolean;
  initialized: boolean;
}

export interface RuntimeEffect extends RuntimeNode {
  kind: "effect";
  fn: () => unknown;
  cleanup: (() => unknown) | undefined;
}

export type RuntimeLink = Link;

export interface SpeculativeComputedEntry {
  readonly dependencies: Map<object, number>;
  value: unknown;
  error: unknown;
  hasError: boolean;
  canPromote: boolean;
}

export interface RenderAttempt {
  readonly dependencies: Map<object, number>;
  readonly computedCache: Map<RuntimeNode, SpeculativeComputedEntry>;
  speculativeDeepReadEpoch: number;
  restoreScope?: (() => void) | undefined;
  add(dependency: object, revision: number): void;
  markSpeculativeDeepRead(): void;
}

export interface RenderAdapterForCore {
  readSource(readable: object, node: RuntimeSource, attempt: RenderAttempt): unknown;
  readComputed(readable: object, node: RuntimeComputed, attempt: RenderAttempt): unknown;
}

export interface AlienDerivedRenderAdapter {
  createRenderAttempt(): RenderAttempt;
  createRenderOwner(attempt: RenderAttempt, scopePolicy?: "managed" | "bare"): object;
  pushRenderScope(attempt: RenderAttempt, scopePolicy?: "managed" | "bare", suspendParent?: boolean): () => void;
  withRenderScope<T>(attempt: RenderAttempt, callback: () => T, scopePolicy?: "managed" | "bare", suspendParent?: boolean): T;
  promoteRenderAttempt(attempt: RenderAttempt): boolean;
  settleRenderAttempt(attempt: RenderAttempt): boolean;
  isRenderAttemptCurrent(attempt: RenderAttempt): boolean;
  getRenderVersion(readable: object): number;
  hasActiveRenderOwner(): boolean;
  isSpeculative(): boolean;
  markSpeculativeDeepRead(): void;
  subscribeReadables(readables: readonly object[], notify: () => void): () => void;
  getExecutionOwner(): unknown;
}

export interface RuntimeReadable<T = unknown> {
  readonly value: T;
  peek(): T;
}

export interface RuntimeWritable<T = unknown> extends RuntimeReadable<T> {
  value: T;
}

export interface AlienDerivedGraphRuntime {
  readonly runtimeToken: object;
  readonly graphOwner: GraphExecutionOwnerV2;
  readonly signal: <T>(initialValue: T) => RuntimeWritable<T>;
  readonly computed: <T>(getter: () => T) => RuntimeReadable<T>;
  readonly effect: (callback: () => unknown) => () => void;
  /** An effect that is never owned by the effect/computed running when it is created. */
  readonly detachedEffect: (callback: () => unknown) => () => void;
  readonly batch: <T>(callback: () => T) => T;
  readonly untracked: <T>(callback: () => T) => T;
  readonly getNodeForReadable: (readable: object) => RuntimeNode | undefined;
  readonly getReadableRevision: (readable: object) => number;
  readonly isComputedClean: (node: RuntimeNode) => boolean;
  readonly promoteComputed: (readable: object, node: RuntimeNode, entry: SpeculativeComputedEntry) => boolean;
  /** Runs a computed's getter for a render attempt; true when it created effects. */
  readonly evaluateSpeculatively: (node: RuntimeComputed, entry: SpeculativeComputedEntry) => boolean;
  /** Owns an effect for the running subscriber or speculative getter. */
  readonly adopt: (dispose: () => void) => void;
  readonly hasSubscribers: (readable: object) => boolean;
  readonly hasActiveSubscriber: () => boolean;
  readonly getBatchDepth: () => number;
  readonly createDeepSignal: <T>(initialValue: T) => RuntimeWritable<T>;
  /** Creates an internal per-key DeepSignal version source with liveness-aware writes. */
  readonly createDeepSignalVersion: <T>(initialValue: T) => RuntimeWritable<T>;
  /** Registers an internal cleanup callback for the final graph subscriber. */
  readonly onDeepSignalUnwatched: (readable: object, callback: () => void) => void;
  readonly markDeepSignalWatched: (readable: object) => void;
  readonly hasDeepSignalSubscribers: (readable: object) => boolean;
  configureRenderAdapter(adapter: RenderAdapterForCore): void;
  pushRenderAttempt(attempt: RenderAttempt | undefined): () => void;
  getActiveRenderAttempt(): RenderAttempt | undefined;
}

export interface RenderReadableDependency {
  getRenderVersion(): number;
  subscribeRender(listener: () => void): () => void;
}
