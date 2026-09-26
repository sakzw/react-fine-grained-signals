/**
 * Experimental Prototype B: RFSG-facing boxes around alien-signals' high-level
 * API. This has no React or foreign-runtime lifecycle bridge.
 */
import {
  computed as alienComputed,
  effect as alienEffect,
  endBatch,
  getActiveSub,
  setActiveSub,
  signal as alienSignal,
  startBatch,
  trigger,
} from "alien-signals";

type Box<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "error"; readonly error: unknown };

export interface HybridSignal<T> {
  value: T;
  peek(): T;
}

export interface HybridRuntime {
  signal<T>(initial: T): HybridSignal<T>;
  computed<T>(getter: () => T): { readonly value: T; peek(): T };
  effect(fn: () => void | (() => void)): () => void;
  batch<T>(fn: () => T): T;
  untracked<T>(fn: () => T): T;
}

export function createHybridRuntime(onEffectError: (error: unknown) => void = reportError): HybridRuntime {
  function untracked<T>(fn: () => T): T {
    const previous = getActiveSub();
    setActiveSub(undefined);
    try { return fn(); } finally { setActiveSub(previous); }
  }

  function protectCleanup(cleanup: (() => void) | undefined): (() => void) | undefined {
    if (cleanup === undefined) return undefined;
    return () => {
      try { untracked(cleanup); } catch (error) { safelyReport(error); }
    };
  }

  function safelyReport(error: unknown): void {
    try { onEffectError(error); } catch { /* a reporter cannot stop alien's flush */ }
  }

  return {
    signal<T>(initial: T): HybridSignal<T> {
      const source = alienSignal(initial);
      let current = initial;
      return {
        get value() { source(); return current; },
        set value(next: T) {
          if (Object.is(current, next)) return;
          const equalUnderAlien = current === next;
          current = next;
          if (equalUnderAlien) trigger(() => source());
          else source(next);
        },
        peek() { return current; },
      };
    },
    computed<T>(getter: () => T) {
      const source = alienComputed<Box<T>>((previous) => {
        try {
          const value = getter();
          return previous?.kind === "value" && Object.is(previous.value, value)
            ? previous
            : { kind: "value", value };
        } catch (error) {
          return { kind: "error", error };
        }
      });
      function read(): T {
        const result = source();
        if (result.kind === "error") throw result.error;
        return result.value;
      }
      return { get value() { return read(); }, peek() { return untracked(read); } };
    },
    effect(fn) {
      let disposed = false;
      // Detach only the creation boundary so alien's nested-effect scope does
      // not make a child an owned dependency of its enclosing user effect.
      const parent = getActiveSub();
      setActiveSub(undefined);
      let disposeAlien: (() => void) | undefined;
      try {
        disposeAlien = alienEffect(() => {
          if (disposed) return;
          let cleanup: void | (() => void);
          try { cleanup = fn(); } catch (error) { safelyReport(error); return; }
          if (disposed) {
            if (typeof cleanup === "function") protectCleanup(cleanup)?.();
            return;
          }
          return protectCleanup(cleanup);
        });
      } finally {
        setActiveSub(parent);
      }
      return () => {
        if (disposed) return;
        disposed = true;
        disposeAlien?.();
      };
    },
    batch<T>(fn: () => T): T {
      startBatch();
      try { return fn(); } finally { endBatch(); }
    },
    untracked,
  };
}

function reportError(error: unknown): void {
  try { console.error("Prototype B effect error (contained)", error); } catch { /* contained */ }
  try {
    const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
    if (typeof report === "function") report.call(globalThis, error);
  } catch { /* contained */ }
}
