# Phase 7 — Subscription Path Consolidation (frozen)

Phase 7 is complete. M0, M1, M2, and M3 are complete; the production subscription paths and accepted trade-offs below are the final Phase 7 record.

## Final production architecture

- **`useSignalValue` with a package readable:** `useSyncExternalStore` → private `ReadableInterop` V1 subscription → private runtime watcher. Snapshots remain untracked. The normal path does not allocate an `EffectNode`.
- **Direct JSX DOM binding with a package readable:** `ReadableInterop` V1 subscription → binding-local protected read → DOM update. It subscribes before the initial read/apply, does not allocate an `EffectNode`, and preserves per-binding error episodes and recovery.
- **`useDeepSignalValue`:** a selector-specific effect-backed store, retained intentionally after the M2 memory comparison. It dynamically tracks deep dependencies and caches primitive values or errors.
- **`useSignalEffect`:** `effect()` remains the API's purpose.
- **Structural `useSignalValue` readable without valid V1:** the effect-backed compatibility fallback remains supported.
- **Structural JSX readable without valid V1:** the existing effect-backed binding fallback remains.

The private `subscribeReadableV1()` disposer closes over its subscription object. The helper is not public, does not expose graph nodes, and does not introduce ReadableInterop V2. No shared cross-runtime graph or scheduler was added.

## Completed milestones

### M0 — direct-subscription feasibility (complete)

Focused tests covered signal and computed notifications/disposal, computed equality suppression, dynamic dependencies, many independent listeners, success/error/different-error/recovery transitions, and writes that must not synchronously throw computed failures. The V1 watcher contains dirty-check failures so render-time reads can deliver them to React Error Boundaries.

The historical local 20,000-subscription subscribe/write/dispose comparison recorded 401,673 operations/s for the effect bridge and 1,221,024 operations/s for V1. These are directional measurements from that machine, not release-performance claims.

### M1 — single-readable production migration (complete)

`useSignalValue` and direct JSX bindings for package readables moved to the private V1 path while preserving `useSyncExternalStore`, server snapshots, initial JSX binding application, and established React/DOM behavior. Cross-copy tests cover foreign signal and computed reads plus foreign JSX bindings.

### M2 — dynamic selector decision (complete; computed candidate rejected)

The computed + V1 candidate passed behavioral prototypes but retained about 1,646 B/store versus about 780 B/store for the selector effect store in the directional 3,000-live-store comparison (about 2.1×). The measurement is an approximate process heap delta, not shallow-object sizing. The computed design was rejected for this phase; `useDeepSignalValue` intentionally keeps its selector-specific effect store. No generic observer was introduced.

The candidate also reduced repeated mount selector evaluations and generally did well in selected updates, unrelated sibling writes, and branch switches, with mixed timing results. The exact counts and timings are implementation evidence, not API guarantees.

### M3 — stabilization, cleanup, and freeze (complete)

Phase 7-touched effect-era comments were synchronized with V1 watchers, live subscriptions, binding updates, and the remaining real effect-backed paths. `createSignalStore` was renamed `createEffectBackedStoreSubscription` and its comment now limits it to the deep-selector store and structural-readable compatibility fallback; package-readable `useSignalValue` uses V1.

An explicit production regression test constructs a structural `ReadonlySignal` without V1, verifies initial rendering and backing-signal updates through `useSignalValue`, rerenders with an unrelated prop, and confirms that unmount releases the fallback subscription.

Focused production coverage still exercises V1 notification/disposal, computed `Object.is` suppression and dynamic dependencies, success/error/error-change/recovery, non-throwing writes, independent listeners, and cross-copy signals, computeds, and JSX. Deep selector tests continue to cover sibling isolation, branch switching, root/source/dependency replacement, primitive snapshots, selector errors, StrictMode cleanup, SSR/hydration, and no evaluations after unmount. JSX tests continue to cover binding ordering/disposal/error recovery, select and multiple-select behavior, IME, controlled value/checked, style key removal, SVG/HTML, stable ref identity, and binding diff/reuse.

## Phase 7-only benchmark files retired

Neither comparison script was wired to normal benchmark scripts, and both had completed their architecture-evidence role. Their results and methodology are recorded above, so keeping the rejected alternative executable would add maintenance without ongoing production value.

- `benchmarks/subscription-path.mjs` — retired; its M0 directional comparison is preserved above.
- `benchmarks/deep-selector-subscription.mjs` — retired; its M2 behavioral, retained-heap, and timing findings are preserved above, including the rejected computed + V1 candidate.

## Final validation

All checks below passed on Node v24.21.0; no Node 22-specific validation was performed.

- `pnpm typecheck` — passed (runtime and unplugin).
- `pnpm lint` — passed with existing non-fatal warnings: `consistent-function-scoping` and one React hooks warning; no M3 lint errors.
- `pnpm test` — runtime: 20 files, 273 passed; unplugin: 3 files, 221 passed, 3 skipped.
- `pnpm build` — passed (runtime and unplugin build smoke).
- `pnpm test:phase4-duplicate` — passed with three independent Alien systems.
- `pnpm test:consumer` — passed, including package tarball resolution, consumer build, and genuine duplicate-package smoke.
- `pnpm size` — passed all seven existing gzip budgets and tree-shaking presence/absence checks without changing budgets. Measured gzip sizes: signal-only 5.82 kB, core 5.87 kB, core+hooks 7.23 kB, deep 10.25 kB, index-full 11.46 kB, JSX runtime 8.98 kB, and utils 7.15 kB.
- `pnpm test:browser` — passed, 27 tests across Chromium, Firefox, WebKit, production build, and React Router.
- `node --expose-gc benchmarks/react-render.mjs 20 10` — completed as a lightweight production sanity run. On Node v24.21.0 / Windows x64 / AMD Ryzen 7 PRO 6850U, the small run reported 4,355 updates/s for `signals`, 4,315 for `signals-managed`, 632,911 for `unrelated-production`, 24,331 for `equality-production`, and 901 for `many-production`. Treat these small-run timings as smoke evidence only, not comparative release claims.

## Final status and scope boundary

- M0 — complete
- M1 — complete
- M2 — complete
- M3 — complete
- **Phase 7 — frozen**

No correctness blocker or architecture blocker remains. **Hardening later:** only if a future phase revisits computed-based selector subscriptions, first address the candidate's additional retained memory. No separate future-version idea was opened by this freeze. Phase 8 is outside this record.
