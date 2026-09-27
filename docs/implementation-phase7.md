# Phase 7 — Subscription Path Consolidation

Phase 7 consolidates subscriptions for `useSignalValue` and direct JSX DOM bindings. It preserves the React external-store contract, the public ReadableInterop V1 boundary, and existing rendering and DOM behavior. This phase does not redesign `useDeepSignalValue`, render tracking, `RenderStore`, runtime architecture, or the deepSignal/alien-signals integration.

## Current paths and target

- `useSignalValue` currently subscribes through `useSyncExternalStore` and an `effect(() => source.value)` bridge. That bridge allocates an EffectNode solely to notify React.
- Direct JSX bindings currently use `effect(() => source.value)` to apply a value to the DOM. The effect also provides immediate mount application, dependency tracking, error containment, and lifecycle disposal.
- `useDeepSignalValue` uses dynamic selector dependencies and remains unchanged in M0 and M1.
- ReadableInterop V1 is already attached to local and foreign public readables. Its private protocol provides `getRevision()` and `subscribe(listener)`, with an unsubscribe handle and initial revision. It does not expose graph nodes.

The selected design is a private helper that subscribes through a valid V1 protocol directly. This removes EffectNode allocation from the two targeted managed paths without adding a public API, a V2 protocol, raw-node access, a shared graph, or a scheduler. Objects without a valid V1 protocol retain a compatibility fallback to the current effect bridge; malformed or structural inputs therefore do not silently lose their existing read behavior. The fallback remains private.

## M0 — prototype and architecture gate

Compare the current effect bridge with direct V1 subscriptions for signals and computeds. The focused comparison covers subscribe/dispose, notifications, equality suppression, many listeners, computed success-to-error and error-to-success transitions, and the rule that a source write must not synchronously throw a computed failure. Include a small subscription-path benchmark or isolated prototype; do not duplicate the runtime.

The direct protocol watcher creates a graph watcher rather than an EffectNode, tracks the readable's dependency boundary, catches computed evaluation failures while checking dirty state, and reports revisions to listeners after graph updates. This is the required error-containment shape: the write completes, listeners are notified, and `useSignalValue` surfaces the failure from its render-time snapshot read. Confirm this behavior in tests before production migration.

M0 gate: preserve `useSyncExternalStore`, untracked snapshots, SSR snapshots, concurrent and StrictMode behavior, equality semantics, foreign V1 subscriptions, and unmount disposal. For JSX, preserve immediate mount application, error episode logging and recovery, and all existing special cases. Test both local and duplicate-copy readables through V1. For inputs without V1, retaining the effect bridge is the compatibility fallback.

**M0 result: pass.** Focused protocol tests verified signal/computed equality suppression, dynamic computed dependencies, many listeners and independent disposal, success/error/different-error/recovery transitions, and that writes do not throw. The direct watcher catches computed failures during dirty checking and notifies after the graph update; render-time `useSignalValue` reads still surface errors to Error Boundaries. Structural comparison confirms direct subscriptions allocate a graph watcher rather than an EffectNode. A local 20,000-subscription subscribe/write/dispose benchmark reported 401,673 operations/s for the effect bridge and 1,221,024 operations/s for V1. These are directional measurements from this machine, not a release-performance claim.

`ReactiveRuntime.subscribe()` had no production call sites after migration and duplicated the V1 watcher API. Its interface and implementation were removed. The runtime-specific tests were replaced by focused V1 protocol tests, including parity against the effect bridge for notifications and disposal.

Audit `ReactiveRuntime.subscribe()` after migration: remove it only if production no longer uses it and its tests do not preserve a distinct required contract; otherwise retain it with the reason recorded here.

## M1 — production migration

If M0 passes, route `useSignalValue` and direct JSX bindings through the private V1 subscription helper. Keep `useSyncExternalStore` and its server snapshot path. Subscribe before the JSX initial read/apply so a binding cannot miss a change during setup. Retain the existing error episode latch, leaving the last successful DOM value in place while a computed is failing and applying its value after recovery. Keep the select MutationObserver/multiple behavior, IME composition, controlled checked/value properties, style diffing, SVG/HTML property handling, and stable ref replacement/disposal behavior.

`useDeepSignalValue` remains on its current selector store. Cross-copy checks must exercise `useSignalValue` with foreign signals and computeds, and JSX direct bindings with a foreign readable; they must not imply a shared graph.

Required validation: focused hook, computed-error, concurrent/external-store, StrictMode, cross-copy, JSX binding, IME, select, style, and error-recovery tests; `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size`. Run relevant benchmark/smoke paths when available. Do not weaken tests or claim Node 22-specific validation.

## Phase status and scope boundary

- M0: complete; gate passed as recorded above.
- M1: complete; `useSignalValue` and direct JSX bindings subscribe through V1, and retain the effect bridge only for inputs without valid V1.
- M2: not started; do not begin in this pass.
- M3: not started; do not freeze Phase 7 in this pass.
- Phase 7 remains open after M1.

Validation completed: `pnpm typecheck`, `pnpm lint`, `pnpm test` (runtime: 270 passed; transform: 221 passed, 3 skipped), `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size` all passed. Focused React/runtime/JSX tests passed, including StrictMode, concurrent and external-store behavior, computed error containment/recovery, bindings, select, style, and IME coverage in the full suite. Genuine duplicate-copy smoke passed for foreign signal and computed `useSignalValue` subscriptions and a foreign readable bound through a duplicate JSX runtime. `pnpm bench:react` was attempted at default workload but stopped after it ran for several minutes without completing; its low-load smoke (`node --expose-gc benchmarks/react-render.mjs 20 10`) completed with its managed-hook and JSX binding cases. The focused subscription benchmark completed.

Remaining classification: no correctness blocker or architecture blocker found in M0/M1. More repeated workload-specific performance measurements are **hardening later**; this pass does not claim a release benchmark result. There is no new future-version idea. M2 and M3 remain explicitly unstarted; Phase 7 remains open. Stop after M1.
