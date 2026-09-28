//#region src/react/use-signals.d.ts
/**
 * Makes the component reactive to signals whose `.value` is read during render.
 * Call this as the component's first hook and before those reads.
 *
 * The boundary is best-effort: tracking stays open until the next
 * `useSignalTracking()` call, the commit-phase layout effect, or a microtask — not the
 * point the component returns. Every component that reads a signal during
 * render must call this itself; a read from a sibling or descendant that does
 * not can be attributed to another component's still-open boundary, and then
 * silently stops updating the component that read it. Use the bundler
 * plugin's default `transform: "managed"` for an exact boundary. See
 * docs/design/use-signals-boundary-design.md.
 */
declare function useSignalTracking(): void;
/** The render-scope handle consumed by the source transform runtime. */
interface ManagedSignalsStore {
  finish(): void;
}
/** Starts a managed render scope that must be closed synchronously with `finish()`. */
declare function useManagedSignals(): ManagedSignalsStore;
//#endregion
export { useManagedSignals as n, useSignalTracking as r, ManagedSignalsStore as t };
