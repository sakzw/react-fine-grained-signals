const contextKey = Symbol.for("react-fine-grained-signals.shared-execution-owner.v2");

const existing = globalThis[contextKey];
if (existing !== undefined && existing.version !== 2) {
  throw new Error("Incompatible RFSG shared execution owner");
}

export const executionContext = existing ?? { version: 2, owner: undefined };
if (existing === undefined) {
  Object.defineProperty(globalThis, contextKey, {
    value: executionContext,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export const UNTRACKED_OWNER = Symbol.for("react-fine-grained-signals.untracked-owner.v2");

export function withExecutionOwner(owner, callback) {
  const previous = executionContext.owner;
  executionContext.owner = owner;
  try {
    return callback();
  } finally {
    executionContext.owner = previous;
  }
}

export function pushExecutionOwner(owner) {
  const previous = executionContext.owner;
  executionContext.owner = owner;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (executionContext.owner === owner) executionContext.owner = previous;
  };
}

export function getExecutionOwner() {
  return executionContext.owner;
}
