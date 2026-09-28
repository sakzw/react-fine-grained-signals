declare const untrackedOwnerBrand: unique symbol;
export const UNTRACKED_OWNER = Symbol.for(
  "react-fine-grained-signals.untracked-owner.v2",
) as typeof untrackedOwnerBrand;

/** Shared lexical owner for graph, render, and explicitly untracked reads. */
export type ExecutionOwnerV2 =
  | GraphExecutionOwnerV2
  | RenderExecutionOwnerV2
  | typeof UNTRACKED_OWNER;

export interface GraphExecutionOwnerV2 {
  readonly version: 2;
  readonly kind: "graph";
  readonly runtimeToken: object;
  add(protocol: ReadableProtocolV1, revision: number): void;
}

export interface RenderExecutionOwnerV2 {
  readonly version: 2;
  readonly kind: "render";
  readonly runtimeToken: object;
  add(protocol: ReadableProtocolV1, revision: number): void;
  isSpeculative?(): boolean;
  markSpeculativeDeepRead?(): void;
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

interface ExecutionContextV2 {
  readonly version: 2;
  owner: ExecutionOwnerV2 | undefined;
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
