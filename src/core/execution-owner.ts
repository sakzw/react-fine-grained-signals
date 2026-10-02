declare const untrackedOwnerBrand: unique symbol;
export const UNTRACKED_OWNER = Symbol.for(
  "react-fine-grained-signals.untracked-owner.v2",
) as typeof untrackedOwnerBrand;

/** Shared lexical owner for graph, render, and explicitly untracked reads. */
export type ExecutionOwnerV2 =
  | GraphExecutionOwnerV2
  | RenderExecutionOwnerV2;

export type ExecutionContextOwnerV2 = ExecutionOwnerV2 | typeof UNTRACKED_OWNER;

export interface GraphExecutionOwnerV2 {
  readonly version: 2;
  readonly kind: "graph";
  readonly runtimeToken: object;
  add(protocol: ReadableProtocolV1, revision: number): void;
  /**
   * Adopts an effect another copy created while this owner's effect or
   * computed runs: `dispose` is called when that owner next re-runs or is
   * disposed. Optional so an owner without it leaves the effect unowned.
   */
  own?(dispose: () => void): void;
}

export interface RenderExecutionOwnerV2 {
  readonly version: 2;
  readonly kind: "render";
  readonly scopePolicy?: "managed" | "bare";
  readonly runtimeToken: object;
  closeScope?(): void;
  add(protocol: ReadableProtocolV1, revision: number): void;
  isSpeculative?(): boolean;
  markSpeculativeDeepRead?(): void;
  /** As on the graph owner: adopts an effect created by a speculative getter. */
  own?(dispose: () => void): void;
}

export interface ReadableProtocolV1 {
  readonly version: 1;
  readonly runtimeToken: object;
  getRevision(): number;
  subscribe(listener: (revision: number) => void): {
    unsubscribe(): void;
    revision: number;
  };
}

export function isGraphExecutionOwner(
  owner: ExecutionContextOwnerV2 | undefined,
): owner is GraphExecutionOwnerV2 {
  return typeof owner === "object" && owner !== null && owner.kind === "graph";
}

export function isRenderExecutionOwner(
  owner: ExecutionContextOwnerV2 | undefined,
): owner is RenderExecutionOwnerV2 {
  return typeof owner === "object" && owner !== null && owner.kind === "render";
}

interface ExecutionContextV2 {
  readonly version: 2;
  owner: ExecutionContextOwnerV2 | undefined;
  frames: Array<{ owner: ExecutionOwnerV2; active: boolean }>;
}

const CONTEXT_KEY = Symbol.for("react-fine-grained-signals.shared-execution-owner.v2");

const globalObject = globalThis as typeof globalThis & Record<symbol, unknown>;
const existing = globalObject[CONTEXT_KEY] as ExecutionContextV2 | undefined;
if (existing !== undefined && existing.version !== 2) {
  throw new Error("Incompatible RFSG shared execution owner");
}

export const executionContext: ExecutionContextV2 = existing ?? {
  version: 2,
  owner: undefined,
  frames: [],
};
executionContext.frames ??= [];
if (existing === undefined) {
  Object.defineProperty(globalObject, CONTEXT_KEY, {
    value: executionContext,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function withExecutionOwner<T>(owner: ExecutionOwnerV2, callback: () => T): T {
  const restore = pushExecutionOwner(owner);
  try {
    return callback();
  } finally {
    restore();
  }
}

/** Temporarily changes lexical ownership inside one synchronous call. */
export function withSynchronousExecutionOwner<T>(
  owner: ExecutionContextOwnerV2,
  callback: () => T,
): T {
  const previous = executionContext.owner;
  executionContext.owner = owner;
  try {
    return callback();
  } finally {
    executionContext.owner = previous;
  }
}

export function pushExecutionOwner(owner: ExecutionOwnerV2): () => void {
  const frame = { owner, active: true };
  executionContext.frames.push(frame);
  executionContext.owner = owner;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    frame.active = false;
    while (executionContext.frames.at(-1)?.active === false) executionContext.frames.pop();
    executionContext.owner = executionContext.frames.at(-1)?.owner;
  };
}
