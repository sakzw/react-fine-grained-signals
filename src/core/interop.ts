/** Internal, same-global communication for independently instantiated runtimes. */
export interface ReadableInteropV1 {
  readonly version: 1;
  readonly runtimeToken: object;
  getRevision(): number;
  subscribe(listener: (revision: number) => void): {
    unsubscribe(): void;
    revision: number;
  };
}

export interface InteropGraphCollectorV1 {
  readonly runtimeToken: object;
  add(protocol: ReadableInteropV1, observedRevision: number): void;
}

export interface InteropRenderCollectorV1 {
  add(protocol: ReadableInteropV1, observedRevision: number): void;
}

export interface InteropRenderScopeV1 {
  readonly token: object;
  readonly managed: boolean;
  isActive(): boolean;
  finish(): void;
}

export interface SharedInteropContextV1 {
  readonly version: 1;
  graphCollector?: InteropGraphCollectorV1 | undefined;
  renderCollector?: InteropRenderCollectorV1 | undefined;
  renderScope?: InteropRenderScopeV1 | undefined;
  speculativeDepth: number;
  speculativeDeepReadEpoch: number;
}

export const READABLE_INTEROP_V1 = Symbol.for(
  "react-fine-grained-signals.readable-interop.v1",
);

const SHARED_CONTEXT_V1 = Symbol.for(
  "react-fine-grained-signals.shared-interop-context.v1",
);

let cachedContext: SharedInteropContextV1 | undefined;

/** Resolve the tiny same-global context shared by duplicate module copies. */
export function getSharedInteropContext(): SharedInteropContextV1 {
  if (cachedContext !== undefined) return cachedContext;

  const globalObject = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globalObject[SHARED_CONTEXT_V1] as SharedInteropContextV1 | undefined;
  if (existing !== undefined) {
    if (existing.version !== 1 || typeof existing.speculativeDepth !== "number") {
      throw new Error("Incompatible react-fine-grained-signals interop context");
    }
    cachedContext = existing;
    return existing;
  }

  const context: SharedInteropContextV1 = {
    version: 1,
    speculativeDepth: 0,
    speculativeDeepReadEpoch: 0,
  };
  Object.defineProperty(globalObject, SHARED_CONTEXT_V1, {
    value: context,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  cachedContext = context;
  return context;
}

export function getReadableInterop(readable: object): ReadableInteropV1 | undefined {
  const protocol = (readable as Record<PropertyKey, unknown>)[READABLE_INTEROP_V1];
  if (protocol === undefined || typeof protocol !== "object" || protocol === null) {
    return undefined;
  }
  const candidate = protocol as Partial<ReadableInteropV1>;
  return candidate.version === 1 &&
      typeof candidate.getRevision === "function" &&
      typeof candidate.subscribe === "function" &&
      typeof candidate.runtimeToken === "object" && candidate.runtimeToken !== null
    ? candidate as ReadableInteropV1
    : undefined;
}

export function attachReadableInterop(
  readable: object,
  protocol: ReadableInteropV1,
): void {
  Object.defineProperty(readable, READABLE_INTEROP_V1, {
    value: protocol,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function withInteropRenderCollector<T>(
  collector: InteropRenderCollectorV1 | undefined,
  callback: () => T,
): T {
  const context = getSharedInteropContext();
  const previous = context.renderCollector;
  context.renderCollector = collector;
  try {
    return callback();
  } finally {
    context.renderCollector = previous;
  }
}

export function withoutInteropRenderCollector<T>(callback: () => T): T {
  return withInteropRenderCollector(undefined, callback);
}

export function isInteropSpeculative(): boolean {
  return getSharedInteropContext().speculativeDepth > 0;
}

/** Marks speculative deep reads whose per-key dependencies were not collected. */
export function markInteropSpeculativeDeepRead(): void {
  const context = getSharedInteropContext();
  context.speculativeDeepReadEpoch = (context.speculativeDeepReadEpoch ?? 0) + 1;
}
