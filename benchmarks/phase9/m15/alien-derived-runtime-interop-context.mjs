const contextKey = Symbol.for("react-fine-grained-signals.shared-interop-context.v1");

export const READABLE_INTEROP_V1 = Symbol.for("react-fine-grained-signals.readable-interop.v1");

export function getSharedInteropContext() {
  const root = globalThis;
  let context = root[contextKey];
  if (context === undefined) {
    context = {
      version: 1,
      graphCollector: undefined,
      renderCollector: undefined,
      renderScope: undefined,
      speculativeDepth: 0,
      speculativeDeepReadEpoch: 0,
    };
    Object.defineProperty(root, contextKey, { value: context, enumerable: false, configurable: false, writable: false });
  }
  if (context.version !== 1) throw new Error("Incompatible shared interop context");
  return context;
}
