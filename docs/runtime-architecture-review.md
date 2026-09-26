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

At this point in the initial review, the React layer had not yet been implemented. The later “Prototype A — real React layer” section records the actual managed/unmanaged React coverage and staged measurements. The subsequent “Prototype A cross-runtime interop” section records the interop implementation and its cost.

## Prototype B — alien high-level hybrid

`benchmarks/prototypes/hybrid-runtime.ts` wraps alien's high-level signal/computed/effect API, adds an `Object.is` value box, boxes computed errors, contains effect and cleanup failures, and detaches nested effect creation. Its local benchmark is mixed and does not retain alien's raw throughput. The wrapper reached 5.09M observed, 4.48M computed, and 1.34M batch ops/s, below Prototype A on all three cases.

The feasibility study stops before a foreign bridge. Alien high-level exposes active-subscriber control and `trigger`, but its public wrapper does not expose a hook for the underlying graph's last-consumer `unwatched` transition or a subscription lifecycle object for an RFSG-owned observer. A correct dynamic bridge could maintain its own dependency and consumer graph, but that would recreate the graph/liveness machinery the hybrid was meant to avoid. Keeping foreign subscriptions indefinitely or invalidating broadly is not an acceptable substitute.

The React path has the same structural obstacle: setting the active subscriber aside can avoid linking a direct signal read, but computed reads use the high-level computed cache and graph. Correct abandoned speculative renders and render-to-commit validation would need a detached collector plus revision and cache policy around alien's graph, duplicating substantial custom runtime state. Prototype B is architecturally unsuitable for the required interop and React guarantees unless a concrete public lifecycle API changes this assessment.

## Comparison and decision

Prototype A's first local results show that several-fold of the current observed/computed/batch gap can be recovered without dropping the tested local semantics. That gap is therefore not fundamentally required by RFSG semantics. The remaining cost could be from the lean graph algorithm, effect queue and computed checks, revision/render machinery, or a combination; current evidence does not isolate those fully. Alien's substantially higher throughput suggests more implementation-shape room, but local benchmark similarity alone does not prove equivalent behavior.

Prototype A was the preferred architecture to continue studying at this stage: retain a compact local graph path and add render and foreign behavior as explicit sidecars. Prototype B is rejected for now. This was not a production replacement recommendation; later interop results and remaining gaps are recorded below. No production migration scope is approved by this review.

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

## Prototype A — real React layer (2026-09-26)

This follow-up starts from commit 5a8e59d4d335ee227c637701610186f5ed2dd241 on Windows x64, AMD Ryzen 7 PRO 6850U, Node v24.21.0, alien-signals v3.2.1. It stays private to benchmarks/prototypes/ and tests/prototypes/; it does not migrate production to Prototype A or add interop/deepSignal support.

### M1 — revision storage

The A/B used 100,000 operations, three warmups and nine samples per isolated process. It compared a WeakMap sidecar with an inline revision initialized on source/computed creation. Each cell is pass 1 / pass 2 in M ops/s:

| Storage | Read | Unobserved write | Observed write | Computed | Batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| WeakMap sidecar | 14.52 / 31.56 | 4.18 / 4.89 | 3.05 / 3.74 | 2.18 / 2.58 | 1.10 / 1.24 |
| Inline revision | 27.80 / 19.28 | 5.10 / 3.28 | 4.01 / 4.12 | 3.19 / 3.32 | 1.50 / 1.64 |

Read and unobserved-write rankings moved between passes. Inline fields won observed, computed and batch in both passes, keep a fixed source/computed node shape, and avoid a sidecar allocation and lookup path. Prototype A retains only inline revisions. The benchmark variants were removed after the comparison.

Source revisions advance on each Object.is-distinct write. Computed revisions advance when an evaluated result changes semantically, when value/error state changes, and on a genuine error reevaluation even when the same error object is thrown. Reading a clean result does not advance a revision.

### M2 — render dependency and watcher

Prototype A readables implement the internal RenderDependency surface: getRenderVersion() and subscribeRender(listener). Source reads return the pending render value and add the source at its current revision. Computed reads first obtain a settled render result, then add the computed at the revision for that result. RenderStore remains the component boundary and performs subscribe-then-compare at commit, retaining the first version for duplicate reads in one render.

Each source/computed owns one lazily created graph-native RenderWatcherNode while its render subscription surface is active. Additional React listeners share its listener set. The watcher has no effect cleanup or effect error channel; source updates notify only after semantic graph checks, and computed equality suppresses equal outputs. When the last watcher link is removed, alien-signals marks a computed dirty and the unwatched callback releases its dependency links. RenderStore defers its last React-listener cleanup to a microtask to preserve StrictMode replay; the graph watcher is released after that cleanup. The focused lifecycle test confirms that a computed stops evaluating after deferred unmount cleanup.

An idle local microbenchmark measured about 3.14M source-to-RenderWatcher notifications/s and 2.39M computed-to-RenderWatcher notifications/s. These cases exclude React reconciliation. The ordinary effect observed-write control varied from 2.12M to 3.35M across nearby runs; treat this comparison as directional.

### M3 — speculative computed state

Render-time computed evaluation uses a separate per-node result/error cache and a private dependency map. While a getter runs, the component collector and graph subscriber are hidden. Source reads capture source revisions; nested computed reads capture the nested computed boundary instead of flattening its sources. A cached result is reused only after recursively checking that each captured dependency is current. A normal graph read or first watcher activation promotes a valid speculative result and links the recorded dependencies, so identity-producing getters are not immediately reevaluated at commit.

Abandoned or throwing renders may leave inert speculative cache data, but no graph links or active subscriptions. A stale cache is reevaluated on the next read. Computed errors are thrown through React; error-to-value recovery works after a source update.

The activeRenderCollector binding is exported only from the internal src/core/render-tracking.ts module so Prototype A can inspect it without a helper call on every idle source read. It is not re-exported by package entry points. trackRenderDependency now reads the default revision only after finding a collector; its result is unchanged while collector-free calls avoid an unnecessary version read. These are behavior-preserving internal changes, not package API changes.

### M4 — React correctness and staged performance

The actual jsdom suite exercises useSignalTracking() and useManagedSignals() with React 19. It covers source updates, dynamic dependencies, unrelated reads, StrictMode replay, siblings and independent roots, first-observed revisions, render-time change/revert, insertion-effect render-to-commit races, semantic batch-revert suppression, computed equality, nested and identity-unstable computed caches, untracked() and peek(), graph-effect isolation, managed finish/throw, managed Suspense with a source and computed, unmanaged abandoned-scope cleanup, SSR, computed error recovery, subscription cleanup, and the suppression regressions documented below. All 51 Prototype A local/React tests pass; production package exports are unchanged.

| Stage | Read | Unobserved write | Observed | Computed | Batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stage 0 — hardened local core (prior two passes) | 44.78 / 52.48 | 8.94 / 10.22 | 5.40 / 5.48 | 4.55 / 3.82 | 2.21 / 2.81 |
| Stage 1 — inline revision A/B, no render subscriber | 27.80 / 19.28 | 5.10 / 3.28 | 4.01 / 4.12 | 3.19 / 3.32 | 1.50 / 1.64 |
| Stage 2 — dedicated watcher | — | — | 2.79–3.14* | 2.39–3.39* | — |
| Stage 3 — speculative computed read | — | — | — | 0.56–1.59* | — |
| Stage 4 — full local React layer, idle graph path | 17.34 / 23.64 / 34.33 | 3.76 / 7.36 / 7.36 | 3.32 / 3.35 / 3.22 | 4.28 / 4.28 / 3.50 | 1.57 / 1.49 / 1.36 |

All operation cells are M ops/s, three passes where shown; * is an isolated nine-sample median with the observed pass-to-pass range shown. Stage 2 isolates a mounted-style graph watcher without DOM work; Stage 3 uses the speculative computed microcase. The idle Stage 4 numbers were measured with no active React collector/subscriber. Compared with the Phase 5 baseline from the accepted hardening run (33.87M read, 7.34M unobserved write, 1.42M observed, 1.53M computed, 0.59M batch), Prototype A Stage 4 median remains about 2.3x faster on observed writes, 2.8x on computed updates, and 2.5x on batch. Read and unobserved-write results are close to or below that Phase 5 control, so those paths remain a performance concern. Short-process measurements vary materially; per-run data is in benchmarks/prototypes/results-local.jsonl.

No React DOM throughput benchmark was run. The correctness suite uses actual React/jsdom, and the graph watcher microbenchmark isolates notification overhead. A React benchmark remains useful before any production migration. No interop or deepSignal work was started.

### Remaining boundaries and recommendation

Prototype A now has local React/render correctness coverage for the listed local scenarios. Cross-runtime graph interop, foreign liveness, duplicate-runtime behavior, and cross-runtime cycles were still open at that checkpoint and are covered in the later interop section. Prototype per-key deepSignal versions, proxy metadata, and deep tracking remain open. Production migration remains out of scope.

Recommendation at that checkpoint: continue to the separately scoped interop milestone. Keep the observed/computed/batch gain and the idle read/write regression visible; do not treat the React result as a production cutover decision.

### Remaining gaps

At that checkpoint, the remaining work was cross-runtime interop, foreign liveness, cold foreign computed freshness, duplicate runtime/package validation, bounded cross-runtime cycles, `deepSignal` integration, production migration, and a final React throughput/performance review before cutover. Prototype B remains frozen. Phase 6 remains unstarted.

## Prototype A React suppression hardening (2026-09-26)

The initial React-layer implementation paused only the shared component collector. Its private `activeRenderReads` and `speculativeReads` maps could still capture reads from `untracked()`, effects, cleanups, or render-watcher notifications. Prototype A now has two distinct helpers: `withoutComponentRenderCollection()` hides the outer React collector while preserving a computed getter's own speculative map; `withoutAllRenderCollection()` saves and clears both local maps and the shared collector, then restores each map in `finally`. Speculative getters use the first. `untracked()`, effect bodies, effect cleanups, and RenderWatcher listeners use the second. Effect bodies keep `activeSub` set to the effect so their graph dependencies remain intact; cleanup clears it.

New React regressions cover an untracked source inside a speculative computed, a nested computed read only through `peek()`, an effect and cleanup synchronously triggered during speculative evaluation, nested `untracked()` restoration after a caught throw, and RenderWatcher listener isolation. The effect continues to track its own sources. The complete Prototype A local/React suite passes 51 tests.

An idle local read still reaches `readSignalCore(node)` directly when no React/speculative collector is active. The computed getter takes its direct graph read path after the collector checks. No duplicated getter fast path was added. The only remaining work on the read measurement is variance: the Phase 5 control measured 46.90M / 35.40M reads/s in these two passes; Prototype A before hardening measured 17.34M / 23.64M (selected previous isolated passes); hardened Prototype A measured 36.09M / 38.10M. For unobserved write, observed, computed, and batch, the same two current-control / hardened-A passes measured respectively 8.56M / 8.24M vs 8.96M / 8.17M; 1.44M / 1.04M vs 5.69M / 2.99M; 1.46M / 1.03M vs 3.17M / 4.29M; and 0.51M / 0.48M vs 2.50M / 1.73M ops/s. Observed/computed/batch retain a material advantage, though the short-run results vary. Existing pre-hardening runs also varied materially, particularly for reads and writes.

## Prototype A cross-runtime interop (2026-09-26)

This milestone extends only the private Prototype A runtime and its tests/benchmarks. Production runtime modules and package exports are unchanged. It reuses `src/core/interop.ts` and its V1 readable protocol/shared context without changing protocol semantics. Each `createLeanRuntime()` allocates a unique `runtimeToken`; each source/computed gets one stable frozen protocol attached under the existing non-enumerable `Symbol.for` key. `getRevision()` exposes semantic source/computed revisions. Equal source writes are suppressed with `Object.is`; `0 -> -0` advances the revision, while `NaN -> NaN` does not.

The same-runtime read path remains direct. A foreign read publishes only when a graph collector is active. Each runtime reuses one collector object, filters its own token, and maps a foreign protocol to one local `ExternalNode` through a `WeakMap`. Foreign `ReactiveNode`s never enter another alien-signals graph. No foreign protocol/node/map is allocated by an ordinary local read; the `ExternalNode` appears only on the first actual foreign graph read. React render collection remains a separate channel on the shared context.

The `ExternalNode` stores `currentEpoch` and `pendingEpoch` independently of the readable's semantic revision. Protocol subscriptions are created only while a local effect/computed/render watcher makes the external node live, and multiple consumers in a runtime share the one subscription. Removing the last live consumer unsubscribes it. Foreign-dependent computed liveness propagates through its dependency links. A foreign computed's own protocol watcher evaluates and publishes the computed boundary, so downstream equality is retained; errors remain subscribed and later revisions can recover them. When a foreign-dependent computed has no live consumer, reads use the small cold-pull strategy: force it dirty and recompute on each read. The trade-off is extra cold reads in exchange for avoiding permanent foreign subscriptions and generation maps.

The protocol's `subscribe()` returns the revision observed when subscription became active. If it differs from the revision captured during the read, the ExternalNode advances its epoch and propagates a rerun. A dedicated fixture takes a value/revision snapshot, mutates during subscription, and confirms the consumer sees `[1, 2]`; this closes the read-to-subscribe loss window. Local computed speculative dependency maps accept foreign protocol keys only when speculative evaluation actually occurs. Cache validation briefly subscribes to a foreign protocol, compares its revision, and unsubscribes; promotion restores the foreign computed boundary as an ExternalNode link.

Foreign reads inside `untracked()` and `peek()` are excluded from the graph. Dynamic foreign branches are relinked and stale branches pruned. Each foreign source/computed has one graph-native protocol watcher while subscribed. The instrumented protocol regression confirms two local consumers use one `subscribe()`, the first disposal keeps it, and the last disposal calls `unsubscribe()` once. Protocol revisions, source `Object.is`, batch-revert behavior, computed equality/error recovery, cold nested computed freshness, and bounded A-to-B-to-A computed cycles are covered by focused tests. A three-bundle fixture additionally verifies A computed -> B computed -> C source with B's equality boundary, `+0 -> -0`, and bounded cross-runtime feedback. No shared scheduler, batch depth, or active subscriber was introduced.

The actual duplicate-bundle React smoke builds three independent Prototype A bundles, each with its own bundled alien-signals installation, while keeping React external/shared. It verifies foreign computed equality suppression, identity-unstable computed freshness, first-observed render-to-commit race detection, change/revert detection, and exactly one protocol unsubscribe on unmount. Separate Vitest coverage also exercises React source/computed reads with jsdom. The focused Prototype A local/React/interop suite has 61 passing tests; the duplicate-copy core+React smoke passes.

Latest local run: 100,000 operations, three warmups, nine samples, Node v24.21.0. The private full-interoperability Stage 4 medians were 36.97M read, 5.98M unobserved write, 4.47M observed, 3.63M computed, and 2.11M batch ops/s. Against the Phase 5 control from the accepted hardening run (33.87M / 7.34M / 1.42M / 1.53M / 0.59M), observed, computed, and batch remain materially faster (about 3.1x / 2.4x / 3.6x); read is near the control, while unobserved write is lower. Short isolated samples are noisy; these are directional rather than release budgets.

| Foreign case (A consumes B/C) | M ops/s |
| --- | ---: |
| A effect <- B source | 1.67 |
| A computed <- B source | 3.85 |
| A effect <- B computed | 1.08 |
| A computed <- B computed | 2.32 |
| A effect with dynamic B/C foreign branches | 0.30 |

The foreign cases use 100,000 mutations per sample with three warmups and nine samples; the dynamic B/C case alternates a local selector between sources owned by two foreign runtimes. It is intentionally more work than a single-edge update and is not a release budget. Rebuild the private harness with `pnpm build:prototype-a` before running `node --expose-gc benchmarks/prototypes/bench.mjs lean <case> 100000`.

Final validation for this pass: `pnpm test` passed (320 runtime tests; 221 transform tests, 3 skipped); `pnpm typecheck`, `pnpm lint` (warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:prototype-a-duplicate`, `pnpm test:browser` (27/27), `pnpm size`, and `git diff --check` passed. Production files and exports are unchanged. The changed implementation/tests remain private to benchmarks and tests, plus this architecture note and npm scripts.

`deepSignal` integration, production runtime migration, and React DOM throughput remain out of scope and unstarted. Do not start Phase 6. The results support continuing with the separately scoped `deepSignal` prototype, not a production cutover decision; production migration should wait for deep tracking validation and another performance review.

The retained `src/core/render-tracking.ts` export of `activeRenderCollector` remains internal and is not re-exported by package entry points. A function accessor would add a call to the ordinary read path; the direct binding keeps that path shorter. `trackRenderDependency()` still delays the default-version lookup until a collector exists. Production test/build/export checks confirm no public API change. No production file was changed in this hardening pass.

Final repository validation for the original React-layer checkpoint: `pnpm test` passed (285 runtime tests; 221 transform tests, 3 skipped); `pnpm typecheck`, `pnpm lint` (warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:browser` (27/27), and `pnpm size` passed. The 2026-09-26 suppression-hardening pass also passed the full matrix: `pnpm test` (310 runtime tests; 221 transform tests, 3 skipped), `pnpm typecheck`, `pnpm lint` (warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:browser` (27/27), `pnpm size`, and `git diff --check`. The changed-file set is confined to `benchmarks/prototypes/`, `tests/prototypes/`, and `docs/`; production runtime files and package exports are unchanged.
