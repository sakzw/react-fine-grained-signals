# Phase 9 M1.4 — Structural Hot-path Investigation

## Starting state and scope

The local checkout, `origin/main`, and GitHub `main` all started at `091b4ac5a4e71156db5c2e22836de64e9d21df75` (`docs: close Phase 9 M1.3.1 investigation`), with a clean worktree. Four read-only audits covered source execution, computed lifecycle, effect scheduling, and V8/JIT evidence. Three disposable worktrees based on that commit isolated the source/control, computed, and effect work. Runtime prototypes were never merged from those worktrees; only the effect candidate was reproduced temporarily in the primary checkout for the complete validation gates, then reverted after failing the frozen package-size budgets.

Scope was limited to M1.4. No public API or accepted runtime behavior was intentionally changed; no M2 work, Git history operation, tag, publish, or authoritative M1b run was performed.

## Performance targets and references

The M1.3 current/v0.1.1 paired medians remain the comparative evidence: source/create 0.637, source/read 0.654, source/unobserved-write 0.970, source/write-read 0.676; computed/create 1.592, dirty-read 0.581, dirty-unread 1.382, equality-suppression 0.626; effect/observed-write 0.814, fanout@16 0.785, and fanout@64 0.833. These values must be read with the recorded IQR and direction counts in the M1.3 report. They motivated structural probes but were not replaced by the M1.4 diagnostics below.

Comparisons used the published RFSG v0.1.1 fixture, Alien Signals 3.2.1, and the pinned Vue reactivity fixture. Production continues to use `alien-signals/system`; Alien high-level and Vue are architecture references, not semantic-equivalence targets.

## Profiling methodology and findings

The actual Phase 9 worker was run one process at a time after warmup. CPU profiles used `node --cpu-prof --cpu-prof-interval=100`; separate trace runs used `--trace-opt --trace-deopt`. Targets were source/read, source/write-read, computed/dirty-read, computed/equality-suppression, and effect/fanout at sizes 16 and 64. One mistyped computed workload name failed worker validation and was excluded. Profiles and traces were temporary and are not retained; reproduction instructions and small summarizers are in [`benchmarks/phase9/profiling/README.md`](../benchmarks/phase9/profiling/README.md).

CPU profiles sampled the real workload loop as well as runtime code. In source/read, the worker loop dominated self samples; the public `.value` accessor and `readSignalValue` were also sampled, while `readSignalCore`, `track`, and foreign publication had fewer samples. Write/read sampled both source write and read paths. Dirty-computed profiles sampled `readComputedValue`, `readComputedCore`, `updateComputed`, and `checkDirty`. Equality sampled the write → queue flush → dirty check → computed update path. Fan-out sampled `flushQueue`, effect `run`, graph/render/speculative context helpers, source reads, and dirty checks. GC was sampled in fan-out profiles, so profile attribution is qualitative; sample totals are not comparable across processes and are not throughput evidence.

V8 marked the relevant source, computed, dirty-check, and queue functions for MAGLEV and/or TURBOFAN_JS optimization. In the plain source/read trace, `readSignalValue` and `readSignalCore` optimized without a function-level deopt. Computed-dirty-read included generic named/global access deopts in `readComputedValue`, `readComputedCore`, and `readSignalValue`; worker `run` also showed OSR transitions and generic named-access deopts. Other traces showed dependent-code invalidations such as cleared embedded weak objects and prototype/field changes. These events do not establish that RFSG object shapes caused the throughput gaps. The evidence does not support a broad “hot functions are not optimized” explanation.

## Execution-path comparison

| Runtime | Source read | Computed/equality | Effect lifecycle |
| --- | --- | --- | --- |
| RFSG v0.1.1 | `SignalImpl.value` checks its render subscription, then reads the Alien source. | High-level computed delegates lazy dirty checking, equality, and dependency updates to Alien. | RFSG's wrapper adds callback, cleanup, and error handling around Alien's effect. |
| Current RFSG | `.value` → `readSignalValue` → subscriber/speculative/render checks → foreign graph publication → `readSignalCore` → dirty settlement → `track` → value. | `readComputedValue` dispatches graph reads versus render/speculative evaluation; graph updates validate and relink dependencies, settle errors/value/equality/revisions, and synchronize foreign liveness. Dirty-unread remains lazy; graph equality and render revision settlement are separate. | Source write marks pending/dirty, propagates Alien links into RFSG `notify`/queue state, then `flushQueue` → `run` checks lifecycle and dirtiness, sets graph/speculative/render isolation, calls the effect, restores state, and purges stale dependencies. |
| Alien 3.2.1 high-level | Its public signal getter tracks an active subscriber and returns the stored value. | Dirty/equality propagation is in Alien's shared graph system. | The high-level effect wrapper supplies cleanup/untracked/error handling over that system. It has no RFSG React revision, speculative cache, or RFSG readable protocol. |
| Vue 3.6 reference | `RefImpl.value` calls `trackRef`, performs dirty/check/update/shallow propagation, then returns `_value`. | `ComputedRefImpl` uses the same ReactiveNode flags and dependency checks, then applies computed equality and propagation. | `ReactiveEffect` uses flags plus `Dep`/`Link` lifecycle and scheduler hooks; this is a structural reference, not a behavior replacement target. |

The ordinary RFSG source path carries the React, speculative, and cross-copy contracts in the same runtime module. A cached global “ordinary mode” flag would need to remain accurate while independently installed RFSG copies manipulate the v1 shared interop context. A local-only flag would miss another copy's graph/render/speculative collectors; a shared cache would require protocol changes or retain the field checks needed to detect old copies. This mode-dispatch design was screened but not implemented because the proposed shortcut could not be made both cheaper and reliable under the current cross-copy contract without a broader context-protocol redesign. The plain source-read regression therefore remains structurally open.

## Structural prototypes and paired diagnostics

Diagnostics used frozen M1b iteration counts, three warmups, seven samples per fresh worker, and alternating control→variant / variant→control order. Ratios below are **duration** (`variant / control`), so below 1.00 is faster. The profiles were complete before timing began; benchmark processes ran serially. Exact raw records are in [`benchmarks/phase9/attribution/README.md`](../benchmarks/phase9/attribution/README.md).

| Prototype | Workload | Pairs | Median (Q1–Q3) | Faster pairs | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| Ordinary computed dispatch: keep durable reads out of render bookkeeping `try/finally` and foreign-publication work | computed/create@1 | 8 | 0.852 (0.477–1.011) | 6/8 | Too wide to claim a creation change. |
| Same | computed/dirty-read@1 | 16 | 0.943 (0.724–1.039) | 11/16 | No stable direction or narrow spread. |
| Same | computed/dirty-unread@1 | 8 | 1.021 (0.857–1.060) | 3/8 | Median stays near parity; spread is broad. |
| Same | computed/equality-suppression@1 | 16 | 0.852 (0.777–1.003) | 12/16 | Apparent gain not repeatable enough; upper quartile reaches parity. |
| Consolidate effect graph/speculative/render setup and restore into one callback helper | effect/observed-write@1 | 16 | 0.791 (0.660–0.960) | 13/16 | Repeatable signal, but package-size budget fails. Rejected. |
| Same | effect/fanout@1 | 8 | 0.936 (0.823–1.003) | 6/8 | Inconclusive. |
| Same | effect/fanout@16 | 16 | 0.974 (0.786–1.112) | 10/16 | No supported gain; broad spread. |
| Same | effect/fanout@64 | 16 | 0.905 (0.843–1.036) | 11/16 | Apparent median gain but upper quartile crosses parity; not accepted. |

The effect helper is the only production-shaped change temporarily reproduced in the primary checkout. Targeted runtime tests, typecheck, lint, build, duplicate-copy, consumer, and browser suites passed with it. It adds no per-source/computed/effect object fields, and it does not change the public API. The computed prototype likewise added no instance state; it was rejected on noisy timing evidence before integration. The source mode-dispatch candidate was rejected before code because an unsafe cache would violate cross-copy collector correctness.

## Bundle and allocation review

The clean baseline `pnpm size` passed all frozen budgets. The effect variant measured signal-only at 6.01 kB gzip versus a 6.00 kB budget, and deep at 10.41 kB versus a 10.38 kB budget. The same clean baseline measured 5.92 kB and 10.33 kB for those entries. The integrated helper therefore exceeded both budgets (by 0.01 kB and 0.03 kB respectively) and was rejected. The build's total emitted-file size was 371.09 kB for the variant and 368.22 kB for baseline; those totals include maps/types and are not the package-size score.

No allocation rounds were run for M1.4. The helper adds no persistent node fields or wrapper objects, but removes per-invocation arrow callback layers; its retained-heap effect was not measured. No allocation claim is made.

## Final measurement, correctness, and closure

No M1.4 authoritative-style matrix was run because the only promising candidate failed package-size budgets. The final runtime state is unchanged from the verified starting commit. Thus there is no M1.4 current/v0.1.1 table to compare with M1b, M1.2, or M1.3; the M1.3 matrix remains authoritative. The final M1.4 diagnostic ratios above are candidate/control time ratios, not M1.4 release statistics.

Validation performed on the temporarily integrated effect candidate:

- `pnpm typecheck` — passed.
- `pnpm lint` — passed; repository warnings remain, and warnings introduced by the diagnostic scripts were fixed.
- `pnpm test` — runtime 283 passed; transform 221 passed, 3 skipped.
- `pnpm build` — passed.
- `pnpm test:phase4-duplicate` — passed.
- `pnpm test:consumer` — passed.
- `pnpm test:browser` — 27 passed.
- `pnpm size` — candidate failed two budgets; clean baseline passed all budgets.
- `git diff --check` — passed after the final documentation/diagnostic edits.

No runtime change was accepted, so no full matrix was rerun. The source-read and write/read gaps have not materially recovered. Dirty-computed-read and equality candidates showed inconsistent paired directions; dirty-unread's median remained near parity but was noisy. Fanout@16 did not improve repeatably; fanout@64's apparent gain also crossed parity within its upper quartile. Computed creation diagnostics were too dispersed to claim preservation or regression. React semantics passed the browser suite for the effect prototype; there is no final React performance comparison. The size-budget failure is resolved by rejecting/reverting that variant, not by changing budgets.

M1.4 has ruled out these specific low-to-moderate complexity designs, but it has **not** established a structural ceiling for the major source/read regression. A safe cross-copy execution-mode dispatcher likely needs a broader interop-context design and compatibility policy. M2 is **not ready**; do not begin M2 until that structural alternative is assessed or its required protocol scope is explicitly deferred.
