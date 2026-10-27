declare const untrackedOwnerBrand: unique symbol;
export const UNTRACKED_OWNER = Symbol.for("react-fine-grained-signals.untracked") as typeof untrackedOwnerBrand;

/** Shared lexical owner for graph, render, and explicitly untracked reads. */
export type ExecutionOwner = GraphExecutionOwner | RenderExecutionOwner;

export type ExecutionContextOwner = ExecutionOwner | typeof UNTRACKED_OWNER;

export interface GraphExecutionOwner {
  readonly kind: "graph";
  readonly runtimeToken: object;
}

export interface RenderExecutionOwner {
  readonly kind: "render";
  readonly scopePolicy?: "managed" | "bare";
  readonly runtimeToken: object;
  closeScope?(): void;
  isSpeculative?(): boolean;
  markSpeculativeDeepRead?(): void;
  /** Adopts an effect created by a speculative getter. */
  own?(dispose: () => void): void;
}

/**
 * Thrown when a read finds another copy of this package's owner. Copies share
 * one execution owner so that a mix can be detected, but their graphs do not
 * interoperate.
 */
export function multipleCopiesError(): Error {
  return new Error(
    "Multiple copies of react-fine-grained-signals are loaded; install a single copy " +
      "(for example by running your package manager's dedupe command or setting the bundler's dedupe option).",
  );
}

export function isGraphExecutionOwner(owner: ExecutionContextOwner | undefined): owner is GraphExecutionOwner {
  return typeof owner === "object" && owner !== null && owner.kind === "graph";
}

export function isRenderExecutionOwner(owner: ExecutionContextOwner | undefined): owner is RenderExecutionOwner {
  return typeof owner === "object" && owner !== null && owner.kind === "render";
}

interface ExecutionContext {
  owner: ExecutionContextOwner | undefined;
  frames: Array<{ owner: ExecutionOwner; active: boolean }>;
}

// Shared through the global symbol registry so that a second loaded copy finds
// this context, and a read under the other copy's owner throws. The key, this
// shape, and an owner's `kind` and `runtimeToken` must stay the same in every
// later release for a mix of releases to be detected.
const CONTEXT_KEY = Symbol.for("react-fine-grained-signals.execution-context");

const globalObject = globalThis as typeof globalThis & Record<symbol, unknown>;
const existing = globalObject[CONTEXT_KEY] as ExecutionContext | undefined;

export const executionContext: ExecutionContext = existing ?? {
  owner: undefined,
  frames: [],
};
if (existing === undefined) {
  Object.defineProperty(globalObject, CONTEXT_KEY, {
    value: executionContext,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function withExecutionOwner<T>(owner: ExecutionOwner, callback: () => T): T {
  const restore = pushExecutionOwner(owner);
  try {
    return callback();
  } finally {
    restore();
  }
}

/** Temporarily changes lexical ownership inside one synchronous call. */
export function withSynchronousExecutionOwner<T>(owner: ExecutionContextOwner, callback: () => T): T {
  const previous = executionContext.owner;
  executionContext.owner = owner;
  try {
    return callback();
  } finally {
    executionContext.owner = previous;
  }
}

export function pushExecutionOwner(owner: ExecutionOwner): () => void {
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
