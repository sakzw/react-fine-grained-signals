# Phase 8 — Render Boundary Contract and Scope Isolation

## M0 — contract and architecture investigation

M0 validates the current boundary contract and evaluates Candidate S. No production M1 migration or production runtime change is included.

## Working render-boundary contract

| Path | Contract |
| --- | --- |
| Plugin `transform: "managed"` (default) | Exact component/custom-hook render boundary, generated with `try` / `finally`; recommended whole-render path. |
| Manual `useManagedSignals()` plus `try` / `finally` | Exact plugin-free boundary. |
| Bare `useSignalTracking()` | Best-effort convenience API; every signal-reading component must call it itself. |
| Plugin `transform: "inject"` | Best-effort advanced/compatibility mode with the same lifetime as the bare hook. |
| `useSignalValue()` | Exact targeted leaf subscription through `useSyncExternalStore` and ReadableInterop V1 for package readables. |
| JSX direct signal binding | Exact targeted host subscription through ReadableInterop V1 for package readables. |

This contract matches the existing runtime, API docs, plugin default, and plugin transform. The bare sibling misattribution is a known limitation, not a failure of the managed contract. A memoized-child regression test makes the limitation observable without rerendering the child by accident. Its managed counterpart demonstrates scope isolation: the parent is not subscribed to the child's read. The child remains stale because it did not open its own boundary; managed scope does not imply implicit child tracking.

Three-level managed nesting is also covered. Each nested scope tracks its own reads, `finish()` restores the exact active parent collector, and the outer component remains subscribed to reads both before and after the nested custom-hook scopes.

## Current responsibility classification

Categories: **A** core RenderStore subscription/dependency state; **B** exact managed scopes; **C** bare best-effort scopes; **D** nested managed scopes; **E** same-global duplicate-package interop; **F** abandoned-scope recovery; **G** historical complexity without a current requirement.

| Responsibility | Categories | M0 finding |
| --- | --- | --- |
| `currentStore` | B, C, D, F | Module-local active-scope link used to restore the preceding collector. It is part of scope control, not dependency subscription state. Stale/self-overlap recovery serves the best-effort/recovery path; nested exact scopes still need parent restoration. |
| `finalCleanupScheduled` | C, F | Coalesces the bare hook's trailing microtask cleanup. `useManagedSignals()` does not schedule it. |
| `shouldCloseCurrentScope()` | C, D, E, F | Policy for whether the next scope may nest over the current one. Managed/managed nesting must stay open; an unmanaged overlap closes the prior boundary. The same rule is applied to the shared interop scope. |
| `closeDisallowedCurrentStores()` | C, D, F | Module-local arbitration and stale-scope recovery on a new scope. Its managed/managed exception is a real nesting rule, not removable flattening. |
| `cleanupTrailingStore()` | C, E, F | Closes the top shared scope at the layout or microtask cleanup edge and resets bare cleanup scheduling. It is not RenderStore dependency commit. |
| `ensureFinalCleanup()` | C, F | Best-effort abandoned-bare-scope microtask fallback. Called only for `useSignalTracking()`. |
| `RenderStore.managed` | B, C, D, E | Policy metadata propagated into the shared scope so managed nesting and duplicate-copy scope arbitration agree about allowed nesting. |
| `RenderStore.start()` | A, B, C, D, E, F | Begins pending dependency collection (A), installs local and shared collectors (B/C/E), preserves parent nesting (D), and includes overlap/self-overlap recovery (F). This is the main current coupling point. |
| `RenderStore.finish()` | B, C, D, E, F | Closes collection and restores the exact parent scope locally and through shared interop. Managed callers invoke it synchronously; bare callers also rely on cleanup edges. |
| `RenderStore.commit()` | A | Diffs pending render dependencies against live subscriptions, detects render-to-commit changes, and notifies React. Needed regardless of scope policy. |
| `RenderStore.isScopeActive()` | B, C, D, E, F | Lets restoration skip a parent scope that has already finished; protects nested local and cross-copy scope restoration. |
| `useSignalTrackingImplementation()` | A, B, C, D, E, F | Owns the React subscription and commit hook (A), chooses policy (B/C), and connects start/finish to local/shared scope state (D/E). It currently also shares the cleanup edge for bare recovery (F). |
| `pushInteropRenderScope()` | B, C, D, E, F | Saves/restores the same-global render collector/scope. It restores only a still-active parent, preserving legitimate nesting across package copies and ignoring completed scopes. |
| `SharedInteropContextV1.renderScope` / `renderCollector` | B, C, D, E, F | Same-global ambient read ownership shared between independently loaded package copies. Both exact and bare reads need the collector channel; the scope stack carries lifecycle and recovery. |
| `InteropRenderScopeV1.managed` | C, D, E | Shares the local nesting policy bit across copies; it prevents a managed parent from being mistaken for a stale scope when another managed boundary nests. |
| `InteropRenderScopeV1.isActive()` | B, C, D, E, F | Shared restoration checks whether the saved parent is still live. |
| `InteropRenderScopeV1.finish()` | B, C, D, E, F | Routes shared-scope close to the owning store so local collector and shared context stay synchronized. |

No listed responsibility is classified as **G**: the current mechanisms have live exact-nesting, cross-copy, dependency-commit, or bare-recovery roles. Some of those roles can be separated by policy; none should be deleted as dead code on the basis of this M0 audit.

`RenderStore.subscribe()` also schedules a microtask when its last React listener unsubscribes. That delayed disposal is separate from `ensureFinalCleanup()`'s bare-scope microtask: the former preserves dependencies across StrictMode unsubscribe/resubscribe replay; the latter closes an abandoned bare collector. M0 does not propose removing either behavior.

## `currentStore` and shared interop ownership

The code currently represents the active scope twice: module-local `currentStore` and same-global `SharedInteropContextV1.renderScope`. Each `RenderStore.start()` always installs an `InteropRenderScopeV1`; its `finish()` closes the owning store and restores the still-active shared parent. This shared stack already spans duplicate package copies. The local `currentStore` is not needed to hold the render collector itself: that is saved/restored by the `RenderStore` finish closure through `setActiveRenderCollector()`.

There is one important self-overlap guard: `RenderStore.start()` finishes its own still-open collection before the normal managed/managed-nesting rule. That guard is store-local (`#finishCollection`) and remains necessary even if the module pointer is removed. The pointer's other duties—finding the current store, closing incompatible parents, and restoring a still-active parent pointer—appear expressible through the shared scope's `finish()` / `isActive()` protocol. The new genuine duplicate-bundle test exercises A-managed → B-managed nesting, B's finish, and restoration of A's collector. It supports the feasibility of using that one stack as the arbitration authority; it does not prove every production scheduling edge of a `currentStore` removal.

**M0 finding:** `currentStore` is currently functional but its stack duties are duplicated by the shared interop scope. M1 should evaluate removing it and the local `closeDisallowedCurrentStores()` loop, while retaining the local collector save/restore closure and self-overlap guard. Do not remove it without running the full mixed-mode, concurrent, StrictMode, Suspense, and cross-copy matrix against the real implementation.

## Managed/bare interaction matrix

The current `shouldCloseCurrentScope(next, current)` rule closes every overlap except managed → managed. These mixed calls are not a supported way to compose two exact boundaries; the table records their present deterministic collector ownership so a future refactor does not silently change it.

| Outer → inner | Reads before inner | Reads inside inner | Reads after inner | Parent restoration / closure | Contract |
| --- | --- | --- | --- | --- | --- |
| managed → managed | outer | inner | outer, if still active | inner finish restores outer; neither is force-closed | exact lexical nesting |
| managed → bare | managed until bare starts | bare | bare until a cleanup edge | bare start force-closes managed outer; outer `finish()` is then a no-op; no parent restoration | best-effort mixed mode |
| bare → managed | bare until managed starts | managed | untracked after managed finishes | managed start force-closes bare outer; inactive bare parent is not restored | best-effort mixed mode |
| bare → bare | outer until inner starts | inner | inner until a cleanup edge | inner start force-closes outer; outer is not restored | best-effort; every reader should opt in separately |

At a new scope, the same managed/managed exception is enforced on the cross-copy `renderScope` stack. Managed `finish()` is synchronous and safe to call after a prior force-close. A bare scope's commit/layout or microtask cleanup closes the current shared top scope; it does not mean the old bare parent resumes.

## Candidate S — Scope Policy Separation

**M0 result: a narrow Candidate S prototype is justified (Outcome S recommendation), but no production migration is approved.** The current exact path is lexically synchronous: managed scopes finish in `finally`, and only the bare path schedules `ensureFinalCleanup()`. The tests validate three levels of parent restoration, managed isolation from a returned child, and genuine duplicate-bundle restoration. Existing runtime tests cover thrown/abandoned managed renders, Suspense retries, StrictMode, multiple roots, and committed dependency changes.

The smallest useful separation is one shared dependency store plus two scope-policy entry paths, not a copied runtime:

```text
RenderStore
  React listeners, pending/live dependencies, snapshot version,
  dependency diff/commit, notifications, disposal

openManagedScope(store)
  begin collection; save/push local and shared parent;
  finish synchronously and restore the still-active parent

openBareScope(store)
  use the same collection store; preserve current best-effort
  overlap arbitration, commit-edge cleanup, and microtask recovery
```

An exact managed scope intrinsically needs synchronous collection and parent restoration, including nested managed scopes and same-global shared interop. It does not intrinsically need the trailing microtask, abandoned-bare cleanup, or a later unrelated scope to rescue its own lifetime when its generated/manual `finally` is honored. Mixed bare/managed use still needs a narrow policy for closing an incompatible ambient scope; the matrix above preserves that behavior without giving managed scopes bare recovery. The store still needs its layout commit for React dependency subscription/diffing.

Production continues to use the existing combined implementation for M0. This investigation adds executable contract coverage and a responsibility map, not a substitute RenderStore implementation. Avoiding a second miniature dependency engine is the smaller and more meaningful M0 experiment; the actual production `RenderStore`, local collector, shared interop stack, and React commit behavior are under test.

### Structural comparison and M1 proposal

Baseline has two module-level mutable fields (`currentStore`, `finalCleanupScheduled`), one shared-scope overlap predicate used by local and cross-copy arbitration, plus a second local close loop. Managed render does not enter the bare microtask fallback; it still reads the shared `managed` bit and may close an incompatible ambient scope. The proposed split removes the duplicate local pointer and local arbitration loop, leaving one module-level bare-cleanup flag and one shared scope stack. It preserves the single RenderStore and adds no per-render object, wrapper, or public API. The unavoidable managed/bare arbitration remains one policy branch because those APIs can be mixed.

The isolated M0 interop probe reuses the production `pushInteropRenderScope()` from three independently bundled copies, rather than cloning RenderStore or mocking a process-wide singleton. It confirms stack restoration directly: A owns the outer collector, B owns reads while nested, B finishes, then reads return to A; finishing A clears the stack. A realistic nested cross-copy React test was not added: it would require invoking hook-bearing components across separately bundled module contexts, while the direct protocol probe isolates the exact shared-stack responsibility under investigation. Existing consumer smoke still covers full duplicate-package React subscriptions for foreign readable collection.

Structural deltas are prospective, not a built candidate measurement: global mutable scope state 2 → 1; local/shared arbitration loops 2 → 1; managed calls into the bare microtask fallback 0 → 0; managed recovery paths for a correctly nested managed-only tree remain 0. `currentStore` removal and function extraction need a real M1 branch before reliable LOC/gzip or hot-path deltas exist. No bundle-size or benchmark improvement is claimed from code that M0 did not build.

**Proposed M1 scope (not started):** remove the redundant module-local current-scope pointer and duplicate local close loop in favor of the shared scope stack; make managed and bare scope opening explicit internal policy entry points while keeping one RenderStore; retain self-overlap, bare cleanup, commit/disposal microtasks, and all public APIs; rerun all boundary and duplicate-package tests and measure the real candidate's bundle and render-path direction. If real nested interop or mixed-mode tests show the shared stack is insufficient, retain `currentStore` and reject the split rather than adding replacement state.

## Rejected or deferred options

- **React internals** (`ReactCurrentDispatcher`, secret dispatcher state, fiber traversal, hook patching) are rejected. They are private, version-sensitive contracts and are unnecessary for the existing exact transform/manual paths.
- **`withSignals(Component)` wrapper** is rejected. Returning `<Component {...props} />` creates an element; it does not lexically surround React's later invocation of `Component`. Calling `Component(props)` directly to force that boundary is not a valid component model.
- **Runtime misattribution diagnostics** are deferred. The runtime sees an active collector, reads, and scope lifecycle, but lacks reliable React component identity to distinguish a component from its child, custom hook, sibling, render prop, or another invocation. A warning for a collector merely remaining open would be noisy because that is the intended bare-hook lifetime.
- Arbitrary strict-bare-hook prototypes are rejected for this phase. Bare and `inject` remain explicitly best-effort; exactness comes from managed `try` / `finally` or targeted leaf subscriptions.

## Measurements

The existing lightweight React render benchmark was run after `pnpm build:runtime` with `node --expose-gc benchmarks/react-render.mjs 20 10` on Node v24.21.0, Windows x64, AMD Ryzen 7 PRO 6850U. It completed its render-count assertions. This run measured bare `signals` at 2,603 updates/s (3.842 ms median; p25–p75 3.728–4.023 ms) and `signals-managed` at 2,720 updates/s (3.677 ms median; p25–p75 3.664–3.744 ms). The ranges overlap slightly; this small run does not establish a performance difference. It is a sanity measurement of current implementations, not a benchmark of a proposed M1 separation. No production overhead conclusion is drawn from it.

## M0 validation

- Focused React tracking/managed/concurrent/SSR tests: 4 files, 43 tests passed, including the new memoized-child and three-level nesting cases.
- Existing transform tests identify managed boundaries for eligible custom hooks; the relevant existing case is `auto-detects custom hooks that own a .value read` in `packages/unplugin-react-fine-grained-signals/tests/transform.test.ts`.
- Full `pnpm test`: runtime 20 files / 276 tests passed; transform 3 files / 221 passed, 3 skipped.
- `pnpm typecheck` passed. `pnpm lint` passed with warnings, including one warning in the pre-existing `tests/react-render-tracking.test.tsx` hook-read expression and existing warnings elsewhere.
- `pnpm build`, `pnpm test:phase4-duplicate`, `pnpm test:consumer`, and `pnpm size` passed. The duplicate-runtime smoke used three independent Alien systems. Consumer smoke passed package tarball resolution, consumer build, foreign-readable React subscriptions, and the new separate-copy scope-restoration case. All seven existing gzip budgets and tree-shaking checks passed unchanged: signal-only 5.82 kB, core 5.87 kB, core+hooks 7.23 kB, deep 10.25 kB, index-full 11.46 kB, JSX runtime 8.98 kB, utils 7.15 kB.
- `pnpm test:browser` passed all 27 tests across Chromium, Firefox, WebKit, production build, and React Router.
- Existing checks cover hydration, multiple roots, dynamic dependencies, render-to-commit changes, managed throw/Suspense cleanup, StrictMode replay, and opt-in sibling tracking. The compiler transform tests pass in the full transform suite. The current harness cannot deterministically force React to yield between component invocations while the bare cleanup microtask is pending, so no time-slicing guarantee is claimed.
- Production behavior tests are the evidence for this milestone. No React-internal prototype, wrapper, broad diagnostic system, or production migration was added.

## Completion boundary

M0 validates the boundary contract and recommends Outcome S: a narrowly scoped M1 evaluation of shared-stack ownership, not a production migration in this pass. No correctness blocker was found in the contract. M0's docs/tests and required validation are complete, but Phase 8 is **not frozen** because the M0 decision recommends the separate M1 evaluation. Do not begin it without a separate request.

## Final contract decision

| API / mode | M0 decision |
| --- | --- |
| Bare `useSignalTracking()` | Retain as explicitly best-effort convenience. Every signal-reading component opts in; nested and sibling reads can still be misattributed. |
| `transform: "managed"` | Retain as exact, recommended/default automatic whole-render boundary. |
| `transform: "inject"` | Retain as supported advanced/compatibility best-effort mode; no Phase 8 deprecation. |
| Manual `useManagedSignals()` | Retain as exact plugin-free escape hatch with synchronous `try` / `finally`. |
| Wrapper API | Reject: element wrapper cannot surround React's later invocation; direct component invocation is invalid. |
| Runtime diagnostics | Defer/reject as a primary candidate: no reliable component identity, and open-scope heuristics are noisy. |

Final M0 result is **Outcome S**: prototype one shared scope stack and two internal policy entry paths in a separate M1; do not start that production change here. No production M1 code has been changed. The exact known bare limitation and all evidence are recorded above.

Repository inputs requested by the M0 brief but absent from this checkout: `AGENTS.md`, `CLAUDE.md`, `docs/agent-execution-policy.md`, and `docs/adversarial-review-checklist.md`.
