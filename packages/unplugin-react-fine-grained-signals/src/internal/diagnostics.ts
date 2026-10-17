/**
 * Stable IDs for the non-fatal diagnostics the Managed Transform reports.
 *
 * An ID names a category of problem, and its meaning is fixed here. Message
 * text may be reworded without changing the ID that users match in
 * `diagnostics.errorOn` or in their own tooling. Each entry is listed below
 * with the situation it covers; the README documents the same table.
 *
 * - RFGS001 Hook call inside a signal read: a Hook sits in an expression that
 *   reads a tracked value, or shares a call with reads only that call performs.
 * - RFGS002 Hook-calling helper read: a call runs a function that calls a Hook
 *   and reads signals inside the caller's render.
 * - RFGS003 Untracked callback read: a JSX render-prop or children callback
 *   reads a signal, and its execution owner cannot be proven.
 * - RFGS004 Uncaptured parameter read: a `.value` read sits in a function
 *   parameter initializer, which runs before the capture Hook.
 * - RFGS005 Unverifiable barrel: `useSignalTracking()` resolves only through a
 *   barrel/re-export module that a single-file transform cannot follow.
 * - RFGS006 Ignored `@signalTracking` annotation: the annotated function has no
 *   component or hook identity to attach the boundary to.
 * - RFGS007 Unnamed default export: an anonymous `export default` function
 *   whose identity cannot be derived from the module name.
 * - RFGS008 Plain-called and mounted component: one component is both called
 *   as a plain function and rendered as `<Component />`.
 * - RFGS009 Server-directive component: a component in a module with a
 *   top-level `"use server"` directive, which is left untransformed.
 */
export const DIAGNOSTIC_IDS = [
  "RFGS001",
  "RFGS002",
  "RFGS003",
  "RFGS004",
  "RFGS005",
  "RFGS006",
  "RFGS007",
  "RFGS008",
  "RFGS009",
] as const;

export type DiagnosticId = (typeof DIAGNOSTIC_IDS)[number];

const DIAGNOSTIC_ID_SET: ReadonlySet<string> = new Set<string>(DIAGNOSTIC_IDS);

export function isDiagnosticId(value: unknown): value is DiagnosticId {
  return typeof value === "string" && DIAGNOSTIC_ID_SET.has(value);
}
