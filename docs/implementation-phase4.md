# Phase 4 Implementation Checkpoint

## Frozen architecture

- Each candidate runtime owns its alien system, graph, nodes, computed cache, effect lifecycle, queue, batch depth, and flush state.
- Same-global duplicate copies communicate only through a versioned context containing graph/render collectors, the current render scope, and speculative depth. It contains no graph or scheduler state.
- Foreign reads adapt a private readable protocol to runtime-local `ExternalNode`s. Foreign `ReactiveNode`s never cross runtime boundaries.
- No shared scheduler or cross-runtime batch atomicity was introduced. Production core primitives, package exports, and `deepSignal` remain unchanged.

## M1 status

- Complete. Added the non-enumerable v1 readable protocol, unique per-runtime tokens, scoped graph collector switching, local ExternalNode cache, semantic epochs, and same-runtime direct-link fast path.
- Foreign source/computed reads preserve intermediate `Object.is` equality boundaries, including transitive A → B → C reads.

## M2 status

- Complete. Computed liveness propagates only from live consumers; foreign subscriptions activate/deactivate with demand. Cold foreign-dependent computed pulls refresh on the next external read.
- Read-to-subscribe revision mismatches cause a bounded local invalidation. Dynamic branch cleanup, reuse, errors/recovery, untracked reads, cleanup reads, and effect disposal have focused regressions.
- Cross-runtime batches are non-atomic by design; the characterization settles correctly and may show a bounded duplicate observation.

## M3 status

- Complete. Render dependencies collect exact observed versions; `RenderStore` preserves the first version observed per render attempt. Foreign protocol adapters are cached by protocol.
- Render scopes, collectors, and speculative depth work across copies. Managed nesting restores only active parents; an abandoned or forced-closed scope is not resurrected.
- Cross-copy React smoke covers source updates, computed equality suppression, render-to-commit races, abandoned/suspended render, managed nesting, sibling isolation, and SSR scope cleanup.

## M4 status

- Complete. `tests/phase4-duplicate-smoke.mjs` builds three independent temporary RFSG bundles with tsdown. Every bundle includes its own `alien-signals`; React remains external/shared. The fixture is test-only and adds no package export.
- `pnpm test:phase4-duplicate` runs the genuine-copy smoke. It covers different module identities with shared context/protocol identity, dynamic foreign dependencies, equality boundaries, three-copy transitivity, error recovery, cold pulls, and bounded two-/three-runtime feedback loops.

## Files changed

- `src/core/interop.ts`
- `src/core/low-level-runtime.ts`
- `src/core/render-tracking.ts`
- `src/react/use-signals.ts`
- `tests/low-level-runtime.test.ts`
- `tests/react-render-tracking.test.tsx`
- `tests/fixtures/phase4-duplicate-entry.ts`
- `tests/phase4-duplicate-smoke.mjs`
- `docs/implementation-phase4.md`

## Validation performed

- Root runtime suite: 258 tests passed. Unplugin suite: 221 passed, 3 skipped.
- Root and unplugin TypeScript checks passed.
- Oxlint completed with no errors; existing warnings remain.
- Runtime and unplugin builds passed; unplugin build smoke passed.
- Phase 1 production cross-copy smoke passed; observed cross-copy batch values `[0, 2]`.
- Phase 4 genuine duplicate smoke passed with 3 independent RFSG + alien-signals bundles, including React/SSR and cycle cases.
- Consumer smoke was attempted but could not start: its child-process harness invokes `pnpm` without a Windows command extension and Node returned `ENOENT`. Direct builds, typechecks, and both test suites passed.

## Intentional semantic differences

- Phase 3 conformance cases #209/#210 require implicit nested-effect ownership and remain unsupported; explicit cleanup composition is still required.
- Cross-runtime batches are not atomic. Effect ordering and bounded duplicate runs are not specified.
- Interop is guaranteed only for duplicate modules in the same JavaScript global environment.

## Known hardening items

- Make `tests/consumer-smoke.mjs` launch the package manager through a Windows-compatible command path so its existing consumer check can run in this environment.
- No Phase 4 correctness or architecture blocker was found.

## Current blocker, if any

- None for Phase 4 core freeze. Consumer-smoke invocation is a validation harness limitation, not a runtime failure.

## Next exact action

- Freeze Phase 4. Production migration, `deepSignal`, and public API changes require a separate phase and are not started here.
