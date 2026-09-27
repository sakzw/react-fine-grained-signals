# Phase 7 — Subscription Path Consolidation

Phase 7 consolidates managed subscriptions while preserving the React external-store contract, the public ReadableInterop V1 boundary, and existing rendering and DOM behavior. M0 and M1 are complete. M2 evaluated a computed-based selector path and retained the existing selector store because the candidate materially increased retained heap. Phase 7 remains open; M3 is not started.

## Current paths and target

- `useSignalValue` uses `useSyncExternalStore` and a private ReadableInterop V1 subscription for package readables. The structural-readable fallback retains its effect bridge.
- Direct JSX bindings use a private V1 subscription for package readables, with the effect bridge retained for structural readables.
- `useDeepSignalValue` retains its selector-specific effect store. It preserves dynamic deep-property dependencies, Object.is equality, cached selector errors, and source/dependency replacement.
- ReadableInterop V1 is already attached to local and foreign public readables. Its private protocol provides `getRevision()` and `subscribe(listener)`, with an unsubscribe handle and initial revision. It does not expose graph nodes.

M1 selected a private helper that subscribes through a valid V1 protocol directly. Objects without a valid V1 protocol retain a compatibility fallback to the effect bridge; malformed or structural inputs do not silently lose their existing read behavior. No public API, V2 protocol, raw-node access, shared graph, or scheduler was added.

## M0 — prototype and architecture gate

Compare the current effect bridge with direct V1 subscriptions for signals and computeds. The focused comparison covers subscribe/dispose, notifications, equality suppression, many listeners, computed success-to-error and error-to-success transitions, and the rule that a source write must not synchronously throw a computed failure. Include a small subscription-path benchmark or isolated prototype; do not duplicate the runtime.

The direct protocol watcher creates a graph watcher rather than an EffectNode, tracks the readable's dependency boundary, catches computed evaluation failures while checking dirty state, and reports revisions to listeners after graph updates. This is the required error-containment shape: the write completes, listeners are notified, and `useSignalValue` surfaces the failure from its render-time snapshot read. Confirm this behavior in tests before production migration.

M0 gate: preserve `useSyncExternalStore`, untracked snapshots, SSR snapshots, concurrent and StrictMode behavior, equality semantics, foreign V1 subscriptions, and unmount disposal. For JSX, preserve immediate mount application, error episode logging and recovery, and all existing special cases. Test both local and duplicate-copy readables through V1. For inputs without V1, retaining the effect bridge is the compatibility fallback.

**M0 result: pass.** Focused protocol tests verified signal/computed equality suppression, dynamic computed dependencies, many listeners and independent disposal, success/error/different-error/recovery transitions, and that writes do not throw. The direct watcher catches computed failures during dirty checking and notifies after the graph update; render-time `useSignalValue` reads still surface errors to Error Boundaries. Structural comparison confirms direct subscriptions allocate a graph watcher rather than an EffectNode. A local 20,000-subscription subscribe/write/dispose benchmark reported 401,673 operations/s for the effect bridge and 1,221,024 operations/s for V1. These are directional measurements from this machine, not a release-performance claim.

`ReactiveRuntime.subscribe()` had no production call sites after migration and duplicated the V1 watcher API. Its interface and implementation were removed. The runtime-specific tests were replaced by focused V1 protocol tests, including parity against the effect bridge for notifications and disposal.

The post-M1 audit found no production call sites for `ReactiveRuntime.subscribe()` beyond V1 and no distinct contract to retain. Its interface and implementation were removed as recorded above.

## M1 — single-readable production migration (complete)

M1 routed `useSignalValue` and direct JSX bindings through the private V1 subscription helper. It retained `useSyncExternalStore` and the server snapshot path. JSX subscribes before its initial read/apply. Existing error latches, select MutationObserver/multiple behavior, IME composition, controlled checked/value properties, style diffing, SVG/HTML property handling, and stable ref replacement/disposal behavior remain intact.

Cross-copy checks exercise `useSignalValue` with foreign signals and computeds, and JSX direct bindings with a foreign readable; these do not imply a shared graph.

## M2 — dynamic selector subscription consolidation (complete; computed candidate rejected)

### Alternatives

The preferred prototype wrapped `selector(source.value)` and `assertSignalSnapshot()` in a memoized internal `computed()`, then reused `useSignalValue()` and V1. This would delegate dynamic dependency switching, root replacement, Object.is value suppression, error caching/recovery, and repeated-error invalidation to the existing computed runtime. The memo dependencies remain `[source, ...dependencies]`; selector function identity alone is intentionally not a dependency, and the fixed dependency-length guard remains before the memo. The other option was to retain the effect-backed selector store, which has only one runtime effect node per selector and keeps its cached value/error result locally.

### Findings and decision

The computed prototype passed focused behavioral checks: property-level sibling isolation, dynamic branch switching, parent/root/source replacement, prop dependency replacement, primitive snapshot rejection, selector error recovery and latest-error delivery, Error Boundary propagation without synchronous writer errors, SSR/hydration, StrictMode, concurrent reads, and disposal. A focused React test records the current path's two selector evaluations during mount (store construction and initial effect run), no evaluation on an unrelated parent render or sibling write, one per selected write, and none after unmount. These exact counts are evidence, not a public contract.

The focused benchmark compared the current effect-store shape with computed + V1 over 5,000 operations per case. Timings varied by run: computed + V1 reduced repeated mount selector evaluations from 10,000 to 5,000 and generally performed well on selected updates, unrelated sibling writes, and branch switches, with some mixed results. The retained-heap comparison was stable across two fresh processes with 3,000 live stores: effect store was about 780 B/store; computed + V1 was about 1,646 B/store (about 2.1×). This is an approximate process heap delta, not shallow-object sizing. Structurally, the effect path has one EffectNode per selector; the candidate has a computed graph node plus a V1 graph watcher per selector. The simpler error/equality machinery does not offset this material retained-memory increase for this milestone.

**M2 decision: do not adopt computed + V1.** Keep `createDeepSelectorStore` and its effect subscription so normal `useDeepSignalValue` does not incur the measured additional per-subscriber graph node and retained heap. No new generic observer abstraction was added. The focused benchmark is in `benchmarks/deep-selector-subscription.mjs`.

The M1 protocol disposer now closes over its owning subscription object (`() => subscription.unsubscribe()`), rather than returning an extracted method. JSX cleanup names were updated locally to use subscription terminology.

Required validation: focused hook, computed-error, concurrent/external-store, StrictMode, cross-copy, JSX binding, IME, select, style, and error-recovery tests; `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size`. Run relevant benchmark/smoke paths when available. Do not weaken tests or claim Node 22-specific validation.

## Phase status and scope boundary

- M0: complete; gate passed as recorded above.
- M1: complete; `useSignalValue` and direct JSX bindings subscribe through V1, and retain the effect bridge only for inputs without valid V1.
- M2: complete; computed + V1 was evaluated and rejected based on the retained-heap gate above.
- M3: not started; do not freeze Phase 7 in this pass.
- Phase 7 remains open after M2.

M0/M1 validation completed at commit `76bc6b1`: `pnpm typecheck`, `pnpm lint`, `pnpm test` (runtime: 270 passed; transform: 221 passed, 3 skipped), `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size` all passed. React benchmark default workload was stopped after several minutes; its low-load smoke completed.

On the retained-effect final state, `pnpm typecheck`, `pnpm lint`, `pnpm test` (runtime: 272 passed; transform: 221 passed, 3 skipped), `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size` all passed. Focused deep-selector, hook, computed-error, concurrent, SSR/hydration, and subscription tests passed (62 tests). The focused M2 selector benchmark completed in multiple fresh Node 24.21.0 processes.

Remaining classification: no correctness blocker found. **Hardening later:** if revisiting computed-based selector subscriptions, first reduce their per-subscriber retained memory; the current computed candidate failed that gate. No architecture blocker or future-version idea was found. M2 is complete as a no-adoption decision; M3 is not started and Phase 7 remains open.
