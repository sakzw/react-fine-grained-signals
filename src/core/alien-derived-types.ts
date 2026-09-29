import type { Link, ReactiveNode } from "alien-signals/system";
import type { ReadableProtocolV1 } from "./execution-owner.js";
import type { GraphExecutionOwnerV2 } from "./execution-owner.js";

export type RuntimeNodeKind = "source" | "computed" | "effect" | "external";

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
  getter?: ((previousValue: unknown) => unknown) | undefined;
  value?: unknown | undefined;
  error?: unknown | undefined;
  hasError?: boolean | undefined;
  initialized?: boolean | undefined;
  foreignDependent?: boolean | undefined;
  fn?: (() => unknown) | undefined;
  cleanup?: (() => unknown) | undefined;
  protocol?: ReadableProtocolV1 | undefined;
  readableProtocol?: ReadableProtocolV1 | undefined;
  revision?: number | undefined;
  pendingRevision?: number | undefined;
  unsubscribe?: (() => void) | undefined;
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
  getter: (previousValue: unknown) => unknown;
  value: unknown;
  error: unknown;
  hasError: boolean;
  initialized: boolean;
  foreignDependent: boolean;
}

export interface RuntimeEffect extends RuntimeNode {
  kind: "effect";
  fn: () => unknown;
  cleanup: (() => unknown) | undefined;
}

export interface RuntimeExternal extends RuntimeNode {
  kind: "external";
  protocol: ReadableProtocolV1;
  revision: number;
  pendingRevision: number;
  unsubscribe: (() => void) | undefined;
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
  pushRenderScope(attempt: RenderAttempt, scopePolicy?: "managed" | "bare"): () => void;
  withRenderScope<T>(attempt: RenderAttempt, callback: () => T, scopePolicy?: "managed" | "bare"): T;
  promoteRenderAttempt(attempt: RenderAttempt): boolean;
  settleRenderAttempt(attempt: RenderAttempt): boolean;
  getRenderVersion(readable: object): number;
  hasActiveRenderOwner(): boolean;
  isSpeculative(): boolean;
  markSpeculativeDeepRead(): void;
  subscribeReadables(readables: readonly object[], notify: () => void): () => void;
  captureRenderSnapshot(readable: object): { value: unknown; dependencies: Map<object, number>; attempt: RenderAttempt };
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
  readonly SIGNAL_BRAND: symbol;
  readonly signal: <T>(initialValue: T) => RuntimeWritable<T>;
  readonly computed: <T>(getter: () => T) => RuntimeReadable<T>;
  readonly effect: (callback: () => unknown) => () => void;
  readonly batch: <T>(callback: () => T) => T;
  readonly untracked: <T>(callback: () => T) => T;
  readonly getNodeForReadable: (readable: object) => RuntimeNode | undefined;
  readonly getReadableRevision: (readable: object) => number;
  readonly isComputedClean: (node: RuntimeNode) => boolean;
  readonly promoteComputed: (readable: object, node: RuntimeNode, entry: SpeculativeComputedEntry) => boolean;
  readonly hasSubscribers: (readable: object) => boolean;
  readonly hasActiveSubscriber: () => boolean;
  readonly getBatchDepth: () => number;
  readonly createDeepSignal: <T>(initialValue: T) => RuntimeWritable<T>;
  /** Creates an internal per-key DeepSignal version source with liveness-aware writes. */
  readonly createDeepSignalVersion: <T>(initialValue: T) => RuntimeWritable<T>;
  readonly markDeepSignalWatched: (readable: object) => void;
  readonly hasDeepSignalSubscribers: (readable: object) => boolean;
  readonly getRenderVersion: (readable: object) => number;
  readonly subscribeReadables: (readables: readonly RuntimeReadable[], notify: () => void) => () => void;
  readonly isSignal: (value: unknown) => boolean;
  configureRenderAdapter(adapter: RenderAdapterForCore): void;
  withRenderAttempt<T>(attempt: RenderAttempt | undefined, callback: () => T): T;
  pushRenderAttempt(attempt: RenderAttempt | undefined): () => void;
  getActiveRenderAttempt(): RenderAttempt | undefined;
}

export interface ForeignReadableAdapterOptions {
  readonly runtimeToken: object;
  readonly makeNode: (kind: RuntimeNodeKind, flags: number, fields?: Partial<RuntimeNode>) => RuntimeNode;
  readonly mutableFlag: number;
  readonly dirtyFlag: number;
  readonly getActiveSubscriber: () => RuntimeNode | undefined;
  readonly link: (node: RuntimeNode, subscriber: RuntimeNode) => void;
  readonly propagate: (link: Link, innerWrite: boolean) => void;
  readonly flush: () => void;
  readonly isRunning: () => boolean;
  readonly isBatching: () => boolean;
  readonly effect: (callback: () => unknown) => () => void;
}

export interface RenderReadableDependency {
  getRenderVersion(): number;
  subscribeRender(listener: () => void): () => void;
}
