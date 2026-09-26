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
