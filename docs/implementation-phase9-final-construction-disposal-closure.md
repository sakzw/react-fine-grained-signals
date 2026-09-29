# Phase 9 — Final Construction and Disposal Closure

## Starting state and decision

The task started with a clean worktree at `8595a437c09725d6b12a4ab38752d4d7c9b309ad`. Local `main`, `origin/main`, and GitHub `main` all matched that commit. No Git history operation was performed.

**Decision C — Phase 9 performance remains open.** Source creation is reconciled with the existing M1.1b evidence. Disposal-only measurements show that dependency teardown is not slower than the v0.1.1 path, and no disposal bookkeeping ablation consistently recovers the authoritative `effect/create-dispose` gap. The remaining cost is specific to repeated effect creation followed immediately by disposal, but these diagnostics did not isolate a safe, repeatable implementation cause. No production patch is justified. M2 must wait for a narrower explanation of this row.

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

The paired decomposition locates the observed regression to the repeated **create then immediately dispose** lifecycle. Creation-only and disposal-only do not reproduce it, and removing the flags reset or absent-cleanup branch does not recover it. Reverse dependency unlinking is necessary and performs well as an isolated current-runtime path. The best-supported attribution is therefore an interaction in the full lifecycle loop and its transient effect/link/disposer objects; this task did not isolate a particular allocation or function as the stable cause. The known controls leave a material unexplained cost, so Phase 9 cannot close under the requested criterion. A narrower allocation/call-path diagnostic is needed before any production optimization is considered.

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

Phase 9 remains open solely for the combined `effect/create-dispose` cost. Do not begin M2 until this remaining performance blocker is either causally closed or explicitly accepted in a later release decision.
