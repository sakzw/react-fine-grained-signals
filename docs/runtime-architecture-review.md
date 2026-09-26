# Runtime architecture review (2026-09-26)

This is a test-only architecture study. It does not replace `ReactiveRuntime`, change package exports, or start Phase 6. The control remains the Phase 5 runtime. The working tree was based on `b3fdac164abeef21e2a27d3914f162eda6583baf` (`Document core performance attribution`) on Windows x64, AMD Ryzen 7 PRO 6850U, Node v24.21.0, alien-signals v3.2.1. Each benchmark case ran in an isolated Node process with 100,000 operations, three warmups, nine samples, and median ops/s; p25–p75 is retained in `benchmarks/prototypes/results-local.jsonl`.

## Prototype A — lean local runtime

`benchmarks/prototypes/lean-runtime.ts` implements local `signal`, `computed`, `effect`, `batch`, and `untracked` on `alien-signals/system`. It uses separate signal/computed/effect node shapes, direct cached value/error fields instead of allocating a result record on successful computed reads, dynamic dependency links, and a local effect queue. It is private test code only.

| Runtime | Read | Unobserved write | Observed write | Computed update/read | Two-source computed batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| alien high-level | 77.56M | 38.45M | 11.84M | 17.73M | 6.34M |
| Prototype A local core | 47.42M | 7.44M | 3.34M | 3.64M | 2.43M |
| Prototype B hybrid | 33.74M | 8.21M | 5.09M | 4.48M | 1.34M |
| Phase 5 current runtime | 29.91M | 8.14M | 1.40M | 1.47M | 0.54M |

These short measurements vary between runs, so treat ratios as directional. In this final run, Prototype A is about 2.4x faster than the current runtime for observed writes, 2.5x for computed updates, and 4.5x for the batch case. It is still slower than alien high-level by about 3.5x, 4.9x, and 2.6x respectively. The unobserved-write result is close to current and far below alien. This supports implementation-shape cost, but does not yet establish production viability. Earlier exploratory runs showed higher observed/computed numbers; those are retained in the JSONL output to make the variability visible and are not the selected comparison.

### Render sidecar experiment

An optional revision sidecar stores semantic revisions in a `WeakMap`; local-core nodes do not gain render fields. Writes bump source revisions and semantically changed computed reevaluations bump computed revisions. Prototype A's local-core and sidecar runs produced:

| Stage | Observed | Computed | Batch |
| --- | ---: | ---: | ---: |
| local core | 3.34M | 3.64M | 2.43M |
| + revision sidecar | 2.93M | 3.27M | 2.11M |
| + speculative computed read simulation | — | 2.97M | — |

The revision-enabled runs are approximately 10–13% lower on these cases, and read throughput was 35.85M versus 47.42M. The speculative case allocates one read map per speculative render and recomputes the computed getter without linking or changing its cache. Its result is not a full React benchmark and is not directly comparable to a committed React render. The wide p25–p75 ranges on several cases and run-to-run variation warrant a longer controlled benchmark before using exact percentages as a budget.

### Local correctness coverage and allocation notes

The focused suite covers `Object.is` (`0`/`-0`, repeated `NaN`), dynamic effect dependencies, cleanup order and disposal, self-disposal, contained body/cleanup errors, error recovery, cached computed errors and reevaluation, lazy caching, equality suppression, computed cycles, nested batch/revert, `peek`, and `untracked`. The revision-sidecar tests check semantic version changes, nested computed reads, and render-to-commit invalidation. All 11 focused tests pass.

No heap profile was run for this prototype. Structural allocation observations: successful computed reevaluations do not construct the current runtime's value/error union object; effects use a reused queue array; each call to `speculate()` allocates a `Map`; enabling revisions creates one `WeakMap` per runtime and writes numeric entries. This is source inspection, not measured allocation evidence.

React support remains incomplete. There is no actual React test for shared render collectors, first-observed render versions, abandoned concurrent renders, managed render scopes, SSR inertness, or commit integration. No Prototype A interop layer was built, so those costs are unknown. React and interop cost therefore cannot be reported as fully measured stages.

## Prototype B — alien high-level hybrid

`benchmarks/prototypes/hybrid-runtime.ts` wraps alien's high-level signal/computed/effect API, adds an `Object.is` value box, boxes computed errors, contains effect and cleanup failures, and detaches nested effect creation. Its local benchmark is mixed and does not retain alien's raw throughput. The wrapper reached 5.09M observed, 4.48M computed, and 1.34M batch ops/s, below Prototype A on all three cases.

The feasibility study stops before a foreign bridge. Alien high-level exposes active-subscriber control and `trigger`, but its public wrapper does not expose a hook for the underlying graph's last-consumer `unwatched` transition or a subscription lifecycle object for an RFSG-owned observer. A correct dynamic bridge could maintain its own dependency and consumer graph, but that would recreate the graph/liveness machinery the hybrid was meant to avoid. Keeping foreign subscriptions indefinitely or invalidating broadly is not an acceptable substitute.

The React path has the same structural obstacle: setting the active subscriber aside can avoid linking a direct signal read, but computed reads use the high-level computed cache and graph. Correct abandoned speculative renders and render-to-commit validation would need a detached collector plus revision and cache policy around alien's graph, duplicating substantial custom runtime state. Prototype B is architecturally unsuitable for the required interop and React guarantees unless a concrete public lifecycle API changes this assessment.

## Comparison and decision

Prototype A's first local results show that several-fold of the current observed/computed/batch gap can be recovered without dropping the tested local semantics. That gap is therefore not fundamentally required by RFSG semantics. The remaining cost could be from the lean graph algorithm, effect queue and computed checks, revision/render machinery, or a combination; current evidence does not isolate those fully. Alien's substantially higher throughput suggests more implementation-shape room, but local benchmark similarity alone does not prove equivalent behavior.

Prototype A is the preferred architecture to continue studying: retain a compact local graph path and add render and foreign behavior as explicit sidecars. Prototype B is rejected for now. This is not a production replacement recommendation. The next implementation study would need full React invariants, interop/liveness and cold foreign-computed tests, independent runtime/duplicate-package tests, feedback cycles, and sustained benchmarks for each added layer. It must also assess integration with `deepSignal` and quantify whether sidecar costs can be reduced. No production migration scope is approved by this review.

| Dimension | Prototype A | Prototype B | Current Phase 5 |
| --- | --- | --- | --- |
| Local graph shape | Compact RFSG-owned runner over alien system; some engine behavior duplicated | Familiar high-level API with wrappers | Generalized graph and boundary lifecycle |
| Local performance | Best of tested RFSG-facing prototypes; still below alien | Mixed; below A | Much slower in observed/computed/batch cases |
| React correctness | Not established; speculative sketch only | Would need detached collector/cache policy around alien graph | Existing implementation and tests are control |
| Foreign liveness | Not implemented | No clean public last-consumer lifecycle; own graph likely required | Existing cross-runtime path is the control |
| Allocation evidence | Structural only; no prototype heap profile | No allocation profile | Historical profile exists, inconclusive by object type |
| `deepSignal` fit | Not assessed | Not assessed | Existing behavior |

Phase 5 may continue as a separately scoped internal-runtime replacement study based on Prototype A, but this review is **inconclusive** on production readiness. A larger package/API architecture rethink is not yet supported by evidence. Phase 6 was not started.

## Prototype A local hardening (2026-09-26)

This pass stays in `benchmarks/prototypes/` and `tests/prototypes/`; production `src/core/reactive-runtime.ts`, package exports, and the `dist` output were restored to the committed baseline after a temporary shape diagnostic. The working commit is `07f3f7968f360599f235f7f89b49315fc9dbb60f`.

### Node fields and reset assignment

Prototype A's signal, computed, and effect nodes already initialized `deps`, `depsTail`, `subs`, and `subsTail` on creation. The previous reset helper used `Object.assign(node, { depsTail: undefined })`, which also allocated a one-property helper object on every tracked callback/computed reevaluation. The private node types now model all four mutable graph links as `Link | undefined`, and the hot path uses direct `node.depsTail = undefined`. No V8 deopt trace was needed to decide this experiment; two isolated benchmark passes were more directly useful.

| Case | Before: pass 1 / pass 2 (M ops/s) | After: pass 1 / pass 2 (M ops/s) | p25–p75 per pass, before → after (ms) |
| --- | ---: | ---: | --- |
| Read | 33.76 / 49.95 | 39.48 / 54.31 | 2.88–3.06 / 1.97–2.03 → 2.35–2.67 / 1.81–1.87 |
| Unobserved write | 6.58 / 8.95 | 8.99 / 8.93 | 14.57–16.26 / 10.56–12.56 → 10.43–14.34 / 11.17–11.55 |
| Observed write | 2.95 / 4.83 | 5.49 / 6.01 | 29.63–40.96 / 20.47–21.05 → 17.70–18.48 / 15.86–16.64 |
| Computed | 4.68 / 5.00 | 5.04 / 5.42 | 20.76–22.24 / 18.48–23.78 → 19.69–20.83 / 17.23–24.51 |
| Batch | 1.76 / 2.36 | 2.43 / 2.37 | 49.45–58.10 / 39.08–50.99 → 36.00–49.26 / 40.28–43.38 |

Observed-write medians rose in both passes; computed improved modestly; batch improved in one pass and was effectively unchanged in the other. Read and write results varied substantially across passes, so the exact gain is not stable enough to claim a general node-map effect. The receiver node keys were present before and after; this test primarily isolates direct assignment from `Object.assign` and its temporary object, not absent-versus-present graph fields.

### Semantic gaps found and corrected

- Source `peek()` now returns `pendingValue` without tracking, including before graph commit and inside a batch. Tests cover `0 → -0`, repeated `NaN`, multiple pending writes, `A → B → A` reverts, and the distinction between write revisions and semantic notifications.
- Computed `peek()` is tested for lazy/cached reads, untracked outer effects, batch coherence, and cached error rethrow.
- Nested effects remain flat by default. Tests prove outer rerun/disposal leaves children alive; returning the child disposer opts into cleanup ownership.
- Self-disposal tests cover rereading old and new sources after disposal, detaching prior dependencies, and invoking the returned cleanup exactly once.
- Writes from an effect to another source synchronously notify its consumer. A write to the same source while the effect is running settles like the current runtime: the effect observes `[0, 1]`, `peek()` sees the final pending `2`, and no asynchronous rerun is introduced. The runner defers nested flushes until the active run boundary.
- Cleanup transitions cover no-cleanup → cleanup → replacement cleanup → no cleanup → disposal cleanup. Cleanup reads are untracked, failures are contained, and the next body still runs.
- Error coverage includes body retry, cleanup/reporter failure containment, continuation of other queued effects, cached same-error reads, same-error reevaluation notifying dependents, different error identity, and recovery.
- Computed coverage includes equality suppression (`1 → 3` does not rerun an effect; `3 → 4` does), dynamic left/right dependencies, nested computed chains, batch revert, error propagation/recovery, direct and indirect cycles, and cycle recovery.
- Batch callback return, nesting, callback throw with pending writes flushed, and later write recovery are covered. Nested and throwing `untracked()` calls restore dependency tracking.
- The revision sidecar now preserves the first revision observed for each node in a speculative scope. A read at revision N, write to N+1, then reread still yields an invalid snapshot. `speculate()` remains an architecture sketch: it recomputes computed getters directly and is not React speculative-cache parity.

The focused Prototype A suite passes 26 tests. No tests claim React or cross-runtime parity.

### Hardened local benchmark and current-runtime diagnostic

Final local comparison: two passes of 100,000 operations, three warmups and nine samples per case, one process per runtime/case. Each cell gives the two pass medians in M ops/s; p25–p75 is available in `benchmarks/prototypes/results-local.jsonl`.

| Runtime | Read | Unobserved write | Observed write | Computed | Batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| alien high-level | 53.75 / 56.28 | 56.11 / 53.75 | 16.88 / 16.86 | 18.05 / 18.63 | 7.44 / 5.83 |
| Phase 5 current | 35.52 / 33.87 | 7.72 / 7.34 | 1.56 / 1.42 | 1.16 / 1.53 | 0.51 / 0.59 |
| Prototype A hardened | 44.78 / 52.48 | 8.94 / 10.22 | 5.40 / 5.48 | 4.55 / 3.82 | 2.21 / 2.81 |

Across these two runs, Prototype A remains about 3.6–3.9x faster than current on observed writes, 2.5–3.3x on computed, and 3.8–4.8x on batch. It does not match alien high-level. Pass-to-pass ranges were 5.40–5.48M observed, 3.82–4.55M computed, and 2.21–2.81M batch for A; current had 1.42–1.56M, 1.16–1.53M, and 0.51–0.59M respectively. The observed result is stable in these passes; computed and batch still vary.

A separate temporary diagnostic changed the production build to initialize all four graph links on source/computed/reaction/external node creation and to use direct `depsTail = undefined` instead of the three hot deletes. It was built and benchmarked twice, then source was restored and the baseline build regenerated. No production edit remains.

| Current runtime case | Baseline pass 1 / 2 | Stable-shape pass 1 / 2 | Direction |
| --- | ---: | ---: | --- |
| Observed | 1.56 / 1.42M | 2.04 / 2.89M | Improved, high spread |
| Computed | 1.16 / 1.53M | 2.99 / 3.05M | Improved about 2x |
| Batch | 0.51 / 0.59M | 0.83 / 1.28M | Improved, high spread |

The current-runtime variant narrows some of Prototype A's lead, especially on computed, but does not close most of the historical Phase 4-to-Phase 5 gap or eliminate A's advantage. The shape-only diagnostic did not run the full production test matrix, so it is a candidate for a separately reviewed optimization, not an accepted production change. This evidence does not reverse the recommendation to continue Prototype A before React, though it makes the direct assignment and stable graph layout worth preserving as an independent option.

### Remaining gaps

Prototype A still needs first-observation/render-commit tests beyond the sidecar sketch, actual React managed scopes and SSR behavior, speculative computed cache parity, foreign source/computed/effect interop, foreign liveness and cold computed freshness, duplicate runtime tests, bounded cross-runtime cycles, and `deepSignal` integration before production viability can be claimed. Prototype B remains frozen. Phase 6 remains unstarted.

Final repository validation after the hardening changes: `pnpm test` passed (285 runtime tests; 221 transform tests, 3 skipped); `pnpm typecheck`, `pnpm lint` (warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:browser` (27/27), `pnpm size`, and `git diff --check` passed. The changed-file set is confined to `benchmarks/prototypes/`, `tests/prototypes/`, and `docs/`; production runtime and package exports are unchanged.
