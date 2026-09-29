# Phase 9 — Final Construction and Disposal Closure

## Starting state and decision

The task started with a clean worktree at `8595a437c09725d6b12a4ab38752d4d7c9b309ad`. Local `main`, `origin/main`, and GitHub `main` all matched that commit. No Git history operation was performed.

**Historical Decision B — the `effect/create-dispose` lifecycle pattern was explained, with no production patch accepted.** Source creation is reconciled with the existing M1.1b evidence. A persistent-subscriber control supports the finding that the current/v0.1.1 gap is associated with repeatedly removing the final source subscriber. A benchmark-only fast path showed a promising initial result but did not reproduce across confirmation sessions or the control workloads. The final clean confirmation and superseding Phase 9 decision appear at the end of this report.

## Authoritative workload and prior result

The M1.6 `effect/create-dispose@1` workload creates one source, then repeats the following `78,528` times inside the timed region:

```js
const stop = api.effect(() => {
  api.read(source);
  runs += 1;
});
api.dispose(stop);
```

The callback returns no cleanup function and observes exactly one source. Verification writes the source after the loop and checks that disposed effects do not rerun. The accepted full matrix reports `current / v0.1.1` throughput `0.803`, IQR `0.107`, with all 8 rounds slower. `effect/create@1` is `1.002`, with 4 faster and 4 slower rounds. These authoritative records remain unchanged; the focused diagnostics below do not replace them or rerun the full M1b matrix.

## Disposal path comparison

| Runtime | Public disposer path for one observed effect | Work after entering graph teardown |
| --- | --- | --- |
| Current RFSG | Returned arrow closure → `disposeEffect` → `disposeDeps` → `unlinkNode` → Alien `unlink` | Writes `flags = None`; reads `depsTail`; for each dependency reads `prevDep`, unlinks and updates both linked lists; reads `cleanup` and branches. No owner/context or WeakMap operation occurs on this path. |
| RFSG v0.1.1 | Returned wrapper reads/sets `disposed` → optional call of Alien's bound `effectOper` → `effectScopeOper` → `disposeAllDepsInReverse` → Alien `unlink` | Writes `flags = 0`; traverses the dependency tail in reverse and unlinks it; checks `cleanup`. Its public wrapper also has the `disposed` branch and calls the bound Alien disposer. |
| Alien Signals 3.2.1 | Bound `effectOper` → `effectScopeOper` → `disposeAllDepsInReverse` → `unlink` | Writes `flags = 0`; reverse-unlinks dependencies; checks `cleanup`. It has no RFSG wrapper's `disposed` guard. |

Both RFSG generations and Alien use reverse dependency teardown. Current RFSG has one extra `unlinkNode` adapter call at each edge; v0.1.1 has the public disposed guard and bound-effect call. None of these paths invokes user cleanup for this workload. Current disposal has no WeakMap/WeakSet lookup or execution-owner work.

The current source locations are `effect()` and its returned closure, `disposeEffect()`, `disposeDeps()`, and `unlinkNode()` in `src/core/alien-derived-runtime-core.mts`. The v0.1.1 wrapper is `effect$1()` in the pinned package's `dist/base-BZTnpU8U.js`; Alien's `effectOper()`, `effectScopeOper()`, and `disposeAllDepsInReverse()` are in the pinned `alien-signals@3.2.1` ESM build.

## Focused diagnostic method and results

`benchmarks/phase9/attribution/disposal/worker.mjs` adds three diagnostic shapes without changing the authoritative workload:

- `effect/dispose-only`: pre-create 78,528 effects, each observing one source, then time only disposer calls and verify that a later write does not rerun them.
- `effect/dispose-empty`: same, but with no dependency, to estimate public disposer overhead without edge unlinking.
- `effect/create-dispose`: mirror the authoritative create/read/dispose loop.

Each screening uses fresh Node processes, three warmups, seven samples, and alternating AB/BA pair order. D1–D4 are generated copies of the current built runtime under `benchmarks/phase9/attribution/disposal/variants/`; they do not edit production source. Ratios in the raw runner output are variant throughput divided by current throughput. `1.00` is parity; above `1.00` favors the diagnostic variant.

| Diagnostic | Paired rounds | Count | Variant/current throughput | Direction | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| D0 current, disposal-only vs fresh v0.1.1 | 12 | 78,528 | 0.48 | v0.1.1 wins 0/12 | Current disposal-only is about 2.08× faster by median paired ratio. |
| Empty disposal vs fresh v0.1.1 | 12 | 78,528 | 0.54 | v0.1.1 wins 1/12 | Current's no-edge disposer path is faster; the public wrapper alone does not explain the regression. |
| Create-only vs fresh v0.1.1 | 12 | 85,858 | 0.89 | v0.1.1 wins 3/12 | No stable create-only regression in this focused run. |
| Combined create-dispose vs fresh v0.1.1 | 12 | 78,528 | 1.51 | v0.1.1 wins 12/12 | The combined-path cost reproduced; this focused estimate is larger than the accepted M1.6 estimate and is not a replacement for it. |
| D1, no flags reset, disposal-only | 24 × 3 sessions | 78,528 | 0.96, 1.05, 1.03 | D1 wins 9/24, 16/24, 14/24 | Small movement with a session-direction reversal; not a repeatable 20% cause. |
| D2, omit absent-cleanup branch, disposal-only | 24 × 3 sessions | 78,528 | 0.76, 0.89, 0.83 | D2 wins 3/24, 8/24, 5/24 | Reversed the small screening result; the branch is not a material cause. |
| D1, no flags reset, combined create-dispose | 12 | 78,528 | 1.01 | D1 wins 7/12 | No material recovery of the combined gap. |

At the 5,000-iteration screen, D1 (omit the flags write), D2 (omit the absent-cleanup branch), D3 (dependency unlink only), and D4 (bound disposer in place of the returned arrow) produced median throughput ratios of `1.02` (6/12), `1.03` (7/12), `0.99` (5/12), and `1.01` (7/12), respectively, on disposal-only. D5, the Alien 3.2.1 path, measured `1.06` (8/12). None identifies a dominant cost in current dependency unlinking. On the 5,000-iteration combined workload D1 was `0.97` (6/12), and on the frozen-count combined screen D1 was `1.01` (7/12).

The three-session frozen-count confirmations for D1 and the strongest RFSG screening variant, D2, are recorded in `confirm-d1-frozen-s*.json` and `confirm-d2-frozen-s*.json`. Neither variant produced a repeatable gain. No variant was admitted to production. D1 removes state reset needed for disposal semantics; D2 specializes around this benchmark's no-cleanup callback; D3 omits unrelated teardown bookkeeping; D4 changes only the disposer call shape; D5 is a reference implementation, not a drop-in RFSG patch.

A single `--trace-gc` diagnostic recorded more GC events for v0.1.1 on the combined workload (132 vs 119), and a larger aggregate traced pause time (63 ms vs 54 ms). Those totals include forced collections before samples and the trace flag changes execution. They do not explain why current is slower in the timed combined loop; no GC-causality claim is made. The raw record is `gc-profile.json`.

### Strongest causal conclusion

The paired decomposition locates the observed regression to the repeated **create then immediately dispose** lifecycle. Creation-only and disposal-only do not reproduce it, and removing the flags reset or absent-cleanup branch does not recover it. Reverse dependency unlinking is necessary and performs well as an isolated current-runtime path. The follow-up sentinel diagnostic narrows the pattern to losing the last source subscriber on each temporary effect disposal. It supports the lifecycle attribution, but does not establish a stable production optimization: the benchmark-only fast path did not survive confirmation. No production change was accepted, so Phase 9 remains open for an explicit release decision.

## Source creation reconciliation

Current source construction is:

```text
signalClassBrandHelper
→ createBrandedSignal
→ makeNode
→ HelperBrandSignal constructor
→ registerHelperBrand
→ attachProtocol
```

`makeNode` allocates the internal source node. `HelperBrandSignal` stores the node in a private field, installs the public `Symbol.for("react-fine-grained-signals.signal")` brand used by `isSignal`, and calls `attachProtocol`. The protocol adapter eagerly inserts the readable-to-node entry into its `readableNodes` WeakMap, creates a protocol object and stores it on the node, and defines the non-enumerable ReadableInterop V1 symbol on the public readable.

The M1.1b source-creation findings still structurally apply as follows:

| Earlier finding | Current mapping | Transferability |
| --- | --- | --- |
| Skip `nodesByReadable.set`: `2.025×`, 4/4 faster | The map is now named `readableNodes` and lives in `createForeignReadableAdapter`; `attachProtocol` still writes it for each local readable. | Same lookup responsibility remains; the old ablation's magnitude is not reassigned to this implementation. |
| Skip public source brand registration: `1.428×`, 4/4 faster | `registerHelperBrand` still defines the public symbol property. The earlier WeakSet-plus-brand registration has been replaced; current source creation no longer performs that WeakSet insertion. | Brand work remains, but the old combined ablation magnitude does not transfer exactly. |
| Skip eager source protocol construction: `1.160×`, 3/4 faster | `attachProtocol` still creates the protocol object, stores it on the node, and defines the interop symbol. Its methods are shared functions now, rather than two per-readable closures. | Protocol responsibility remains with a cheaper shape; the earlier result was partial and is not a current cost estimate. |

The original diagnostics and their limitations remain in [`benchmarks/phase9/attribution/README.md`](../benchmarks/phase9/attribution/README.md) and [`implementation-phase9.md`](implementation-phase9.md#causal-findings). These results establish material registration contributors, not that the full current source/create gap is an unavoidable semantic cost. The current tree still performs equivalent map, brand, and interop-protocol responsibilities, so the attribution does not need to restart from zero and does not motivate another representation redesign.

## Validation and stop boundary

- Disposal diagnostic preflight passed for current, D1–D4, v0.1.1, and Alien runtimes; each timed disposal cohort verified that a subsequent source write did not rerun stopped effects.
- Three-session D1 confirmation completed at the frozen `effect/create-dispose@1` iteration count of 78,528, using 24 balanced pairs per session.
- No authoritative M1b matrix, calibration run, or production runtime change was made.
- Full production validation was not applicable because no production patch was accepted.

At the end of the disposal attribution, Phase 9 remained open pending a clean full-matrix confirmation. That boundary is superseded by the final clean confirmation below.

## Last-subscriber transition diagnostic

This follow-up started from `54999b9862ca73c54eb76bfe092387a19df73cce` with the existing sentinel worker changes and two v0.1.1 comparison records in the worktree. Git history operations were not performed.

The paired fresh-process control compared the frozen 78,528-iteration loop against a sentinel effect that stayed subscribed to the same source for the entire timed loop. Each run used 24 AB/BA pairs, three warmups, and seven samples per process. Against fresh v0.1.1, ordinary create-dispose measured current/v0.1.1 throughput `0.805` (v0.1.1 won 14/24 pairs); the sentinel workload measured `1.066` (current won 15/24). Keeping one subscriber prevented the source from reaching its unwatched state on every temporary effect disposal, and the gap moved to near parity. This supports the last-subscriber transition as the causal lifecycle feature.

U1 was a benchmark-only copy of the current built runtime with one change: `unwatched()` returns immediately for `node.kind === "source"` before external/computed/effect dispatch. The 24-pair screen measured U1/current `1.126` on ordinary create-dispose and `0.924` with the sentinel. The three new 24-pair ordinary confirmations measured `0.974`, `0.979`, and `1.033`; the initial gain was not repeatable. The remaining 24-pair U1/current screens were dispose-only `0.976`, create `0.875`, observed-write `0.933`, fanout@16 `1.075`, fanout@64 `0.917`, and computed/dirty-read `1.146`. These inconsistent control movements reinforce that the initial U1 screen is not acceptance evidence. U1 was not compared further against v0.1.1 and was not applied to production.

Raw records are `last-subscriber-ordinary.json`, `last-subscriber-sentinel.json`, `u1-screen-*.json`, and `u1-confirm-*.json` under `benchmarks/phase9/attribution/disposal/`. The diagnostic worker supports the sentinel and focused U1 screening workloads; `prepare-variants.mjs` generates U1 as a disposable build copy. No authoritative M1b matrix or production runtime behavior was changed. Since the sentinel recovered the gap, no block-size follow-up was needed.

## Final clean M1.6 confirmation — Decision A

The full four-runtime Phase 9 matrix completed from clean committed HEAD `efbe51ef18beee2d7f587af32b6c481d8fe79327`, matching local `main`, `origin/main`, and GitHub `main`. The pre-run worktree was clean, and the manifest records `worktreeDirty: false` with no dirty paths. `src/**` has no changes since the M1.6 production commit `8595a437c09725d6b12a4ab38752d4d7c9b309ad`. Runtime input SHA-256 is `b74fb4e4641b80af3b6f4aca42020131bbd18df09bd024ddd0712c5b96f60f66`; after rebuilding, the 26-file distribution SHA-256 is `06a75351b209871c615ce877616beae9f8767e7ac9552432faba595741353316`, matching the accepted M1.6 record.

The run used Node `v24.21.0`, pnpm `12.6.0`, Windows x64, and an AMD Ryzen 7 PRO 6850U. It used the frozen iteration-file SHA-256 `fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`, eight balanced rounds, three warmups, seven samples, sizes 1/16/64, graph count 1,000, and three allocation rounds. Pins were verified as RFSG v0.1.1 commit `0e12bbf46ab098fbb2388704ab85c3c406189cbb`, Alien Signals `3.2.1`, and Vue reactivity `3.6.0-rc.9` (Vue core `5be279570a844b953dd44b56bdc2426f7421aecd`). All `958/958` tasks completed: 5,992 successful samples, 104 expected N/A rows, 30 allocation rows, and zero failures. The manifest's harness hash is `f37e5656ecf58917d9014a63df3cdafe187c5d440fb3cc90c7b38f304e7774fe`; it differs from the earlier matrix because the Phase 9 benchmark tree now includes the subsequent diagnostic additions, while the production input and built artifact hashes match.

The major paired throughput ratios (current/v0.1.1) were: source/create `0.81`, source/read `0.93` (wide spread), source/unobserved-write `1.87`, source/write-read `1.39`; effect/create `0.70` in the full matrix, create-dispose `0.83`, observed-write `1.31`, fanout@1 `0.92`, @16 `0.99`, and @64 `1.02`; computed/create `1.06`, dirty-read `1.09`, dirty-unread `1.40`, equality-suppression `1.21`; batch/two-writes-one-reaction `0.96`. DeepSignal read was `1.12` and watched-leaf write `0.97`. The previously unexplained full-matrix `effect/create` value was checked against its raw samples, then repeated with the existing fresh-process paired disposal runner at the frozen 85,858 count: the 24-pair confirmation measured current/v0.1.1 `0.973`, with 13/24 pairs favoring v0.1.1. It did not reproduce a stable material regression; the prior M1.6 ratio was `1.002` with 4/8 slower rounds. The known create-dispose result remains in its established range and is explained by the last-subscriber lifecycle diagnostic.

Contextual comparisons remain workload-specific: current/Alien was `1.93` for unobserved write and `1.39` for write/read, while raw Alien remained faster on several source/effect/computed paths; current/Vue was `0.95` for unobserved write, `0.93` for write/read, and `1.33` for observed effect writes, with mixed results elsewhere. The fanout@16 and computed rows showed wide round-to-round contextual variation; paired current/v0.1.1 results remained near parity or favorable on those rows, and raw Alien tendencies remained coherent. These comparisons do not impose a global ranking. The very large source/create difference against raw Alien/Vue is the known cost of RFSG's source registration, public brand, and ReadableInterop responsibilities, not a new finding.

Retained-heap medians were directionally consistent with M1.6: signal/computed/effect graph current `225,936` bytes (previous `226,632`), one-source/many-effects current `89,792` (previous `91,344`), and deep-watched-leaves current `461,968` (previous `461,656`). No dramatic retained-heap increase appeared. The full result, raw samples, allocations, failures, manifest, and analyzer output are in [`final-clean-confirmation-2026-09-29`](../benchmarks/phase9/results/final-clean-confirmation-2026-09-29/).

**Final Decision A — Phase 9 performance validation is closed.** The clean full matrix reproduced the accepted ordinary-write recovery and exposed no new stable material unexplained regression. Known source-creation and short-lived create-dispose costs remain documented as optimization evidence, not release blockers. M2 Release Hardening may begin next. No M2 implementation is included here.
