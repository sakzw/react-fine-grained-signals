# Phase 9 M1.5.4 — Source representation and interop cost closure

## Scope and pinned inputs

The work started from `53ea18007b1934dc51902b6447551b1e237a2545` on `main`; local and remote `main` agreed and the worktree was clean. The machine was Windows x64 with Node `v24.21.0`. The frozen RFSG v0.1.1 source is `0e12bbf46ab098fbb2388704ab85c3c406189cbb`; `benchmarks/phase9/m1b-iterations.json` has SHA-256 `fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`.

Reference inputs were Alien Signals 3.2.1 at [`8734d386d925025d0e99419bd9161c17b112c5ee`](https://github.com/stackblitz/alien-signals/tree/8734d386d925025d0e99419bd9161c17b112c5ee) and Vue `@vue/reactivity@3.6.0-rc.9` at core commit [`5be279570a844b953dd44b56bdc2426f7421aecd`](https://github.com/vuejs/core/tree/5be279570a844b953dd44b56bdc2426f7421aecd). The Vue implementation details below were verified against the exact locked package bundle; the published package does not include those TypeScript source files.

## Representation and hot paths

| Property | Alien 3.2.1 | Vue 3.6.0-rc.9 | RFSG v0.1.1 | RFSG M1.5.3 |
| --- | --- | --- | --- | --- |
| Public source | Bound `signalOper` function | `RefImpl` instance | `SignalImpl` over Alien callable | `HelperBrandSignal` with private node |
| Public computed | Bound `computedOper` function | `ComputedRefImpl` instance | Getter wrapper over Alien computed | `HelperBrandComputed` with private node |
| Public object is graph state | Bound function receiver | Yes | No | No |
| Retained source objects | State + bound function | One ref | Wrapper, render subscription, Alien state, bound function | Graph node, readable, protocol |
| Protocol closures per readable | Bound operation | None | Render bridge callbacks as needed | Two eager closures |
| WeakMap writes per source | None | None | None | Readable→node and readable→protocol |
| Ordinary local clean read | Bound call, dirty/subscriber checks | `trackRef`, dirty check, value | Render-subscription tracking plus Alien read | Private node read, attempt/owner/render checks, graph read |

Alien exposes the bound operation itself as the state receiver. Vue's ref is its graph node and `RefImpl.value` calls `trackRef(this)` before reading `_value`. RFSG preserves a separate public wrapper and internal graph node to protect the reflective API and keep the runtime's render/interop contracts.

Before M1.5.4, a normal RFSG source creation allocated a node and readable, a protocol object, two per-readable protocol methods, two WeakMap entries, and the non-enumerable brand and interop symbols. A normal clean source read accessed `#node`, `activeRenderAttempt`, `executionContext.owner`, and the active render collector before/around `readSource`; with no subscriber it does not allocate graph links or consult either WeakMap. A clean computed read similarly uses the graph core and performs owner/render checks. The separate same-copy readable→node WeakMap is also used by render, DeepSignal, and APIs that receive readables; removing it would require exposing private node state.

## Experiments and decisions

The runner uses the frozen per-case iteration counts, serial fresh Node processes, 3 warmups, 7 samples, and a deterministic four-runtime order. Each ratio is the median of paired per-round duration ratios `current / comparison`; below 1 is faster. Full raw data and summaries are retained in `benchmarks/phase9/m15/results/m154-*`.

| Candidate | source/create vs v0.1.1 | source/read vs v0.1.1 | computed/dirty-read vs v0.1.1 | Decision |
| --- | ---: | ---: | ---: | --- |
| A — lazy symbol accessor, protocol materialized on first use | 2.61 (Q1–Q3 2.18–2.99) | 1.22 (Q1–Q3 1.07–1.38) | — | Rejected: creation cost rose; read path was unchanged. |
| B — `Object.create` / `Object.assign` protocol object | 3.32 median over the partial screen (range 1.87–7.17) | — | — | Rejected early after a clear creation regression. |
| C1 — shared protocol methods, protocol stored on internal node; source and computed owner-free branches | 1.26 (Q1–Q3 1.16–1.70) | 1.10 (1.03–1.16) | 1.40 (1.25–1.47) | Rejected: create/read were not improvements versus v0.1.1, and computed dirty-read was slower. |
| C2 — shared methods, discover local protocol through its existing symbol | 2.37 (2.23–2.80) | 1.14 (0.92–1.21) | 1.16 (0.98–1.32) | Rejected: no consistent source create/read gain and dirty-read remained inconclusive/slower. |
| C3 — internal-node protocol, source-only owner-free branch; computed getter restored | Preliminary screen: 1.36 (1.25–1.60) | Preliminary screen: 1.08 (1.01–1.17) | Preliminary screen: 1.28 (1.14–1.41) | The earlier rejection was provisional: the screen did not compare against frozen M1.5.3 production. It is superseded by the direct comparison below. |

C3's original screen mixed an intermediate control and a non-authoritative v0.1.1 comparison. That did not establish whether its source-path gain paid for the dirty-read movement relative to accepted production. M1.5.4.1 therefore rebuilt and pinned the exact M1.5.3 production baseline, then compared C3 directly against it before the authoritative M1b run.

## Direct M1.5.3 paired verification

The frozen production baseline is M1.5.3 commit `53ea18007b1934dc51902b6447551b1e237a2545`, rebuilt from source tree `5daebfd17e10290715e6ff5c44e7748829f7c378` with Node `v24.21.0`, tsdown `0.22.14`, and rolldown `1.2.6`. The checked artifact SHA-256 is `0e6f644945d9385d8ea32ed66f2d3785e13984abfd47202c58bfdefe0459f54d`. C3 is the production representation described above; its computed getter matches M1.5.3 and only the ordinary source getter has the owner-free branch.

The direct source-representation screen used 3 warmups, 7 samples, serial fresh processes, and deterministic balanced order. The counts are 24 rounds for source create/read, 18 for the four source/effect create/write controls, and 12 for the six graph/batch controls. Values below 1 are faster duration for C3. Spread and direction counts are across paired rounds.

| Case | Rounds | C3 / M1.5.3 duration median | Q1–Q3 | Min–max | C3 faster / slower |
| --- | ---: | ---: | ---: | ---: | ---: |
| source/create@1 | 24 | 0.276 | 0.216–0.776 | 0.149–1.136 | 22 / 2 |
| source/read@1 | 24 | 0.883 | 0.803–1.016 | 0.665–1.240 | 17 / 7 |
| source/unobserved-write@1 | 18 | 1.074 | 0.901–1.210 | 0.353–1.325 | 9 / 9 |
| source/write-read@1 | 18 | 0.923 | 0.833–1.295 | 0.467–2.859 | 12 / 6 |
| computed/create@1 | 18 | 0.360 | 0.341–0.443 | 0.304–0.921 | 18 / 0 |
| effect/create@1 | 18 | 0.929 | 0.850–1.026 | 0.697–1.320 | 12 / 6 |
| computed/dirty-read@1 | 12 | 1.055 | 0.887–1.123 | 0.564–1.286 | 5 / 7 |
| computed/equality-suppression@1 | 12 | 0.978 | 0.799–1.085 | 0.674–1.169 | 7 / 5 |
| effect/observed-write@1 | 12 | 0.912 | 0.871–0.993 | 0.742–1.165 | 9 / 3 |
| effect/fanout@16 | 12 | 0.947 | 0.906–1.064 | 0.751–1.260 | 8 / 4 |
| effect/fanout@64 | 12 | 1.005 | 0.950–1.120 | 0.779–1.227 | 6 / 6 |
| batch/two-writes-one-reaction@1 | 12 | 0.837 | 0.774–1.023 | 0.576–1.238 | 9 / 3 |

C3 materially improves source creation and computed creation versus M1.5.3. Source reads are modestly faster by median with Q3 near parity; source writes, computed dirty/equality, fan-out and effects are near parity or noisy, with no repeatable material regression. The effect observed-write movement is a stable improvement. Small movements in neighboring graph cases do not overturn the large, repeatable create gains. **C3 is accepted.** The implementation remains in production source; no M1.5.3 rollback is made.

The paired allocation diagnostic versus M1.5.3 (4 rounds) showed lower live/retained heap for the 1,000-node combined graph (about 22%/23% lower) and the 1,000 watched DeepSignal leaves (about 10%/13% lower); one source with 1,000 effects was approximately at parity. These forced-GC heap deltas are directional, not allocation rates or object counts. Exact gzip deltas versus M1.5.3 were +36, +40, +52, +51, +59, +60, and +49 bytes across the seven checked entries; every frozen size budget passed.

## Final authoritative M1b matrix

The accepted C3 runtime completed [`m1.5.4-2026-09-29-representation-final`](../benchmarks/phase9/results/m1.5.4-2026-09-29-representation-final/) with 8 balanced rounds, 3 warmups, 7 samples, frozen counts, sizes 1/16/64, graph count 1,000, and 3 allocation rounds. The run used Node `v24.21.0` on Windows x64 / AMD Ryzen 7 PRO 6850U. It completed 958/958 tasks, recorded 6,096 sample rows (5,992 successful and 104 expected N/A), 30 allocation rows, and zero failures. The manifest records the pre-output dirty state, exact runtime order, starting HEAD `fefd6bfb2b985fa16d647d9851fca22646d0f91f`, current artifact SHA-256 `946e86786f36718f45b792d5d19e0e02e06b2183c21168490ae52fbb87198787`, and frozen iteration SHA-256 `fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`. The captured dirty paths are pre-existing candidate, harness, and diagnostic work; the run's own output files are not in that list. `analysis.json` retains the deterministic analyzer output.

The frozen primary statistic is paired throughput ratio, current C3 / RFSG v0.1.1; below 1 is slower. Values include Q1–Q3, min–max, and round directions (`<1 / >1`; no ties occurred).

| Workload | Median | Q1–Q3 | Min–max | Rounds <1 / >1 |
| --- | ---: | ---: | ---: | ---: |
| source/create@1 | 0.802 | 0.789–0.831 | 0.679–0.994 | 8 / 0 |
| source/read@1 | 0.876 | 0.860–0.893 | 0.807–2.148 | 7 / 1 |
| source/unobserved-write@1 | 0.936 | 0.862–0.971 | 0.676–1.029 | 7 / 1 |
| source/write-read@1 | 0.949 | 0.857–1.058 | 0.710–1.143 | 5 / 3 |
| effect/create@1 | 0.846 | 0.791–0.894 | 0.736–1.201 | 7 / 1 |
| effect/create-dispose@1 | 0.887 | 0.807–1.083 | 0.599–1.217 | 5 / 3 |
| effect/observed-write@1 | 1.225 | 1.084–1.308 | 0.840–1.658 | 2 / 6 |
| effect/fanout@1 | 0.842 | 0.748–1.029 | 0.644–1.192 | 6 / 2 |
| effect/fanout@16 | 1.156 | 1.053–1.194 | 0.918–1.302 | 2 / 6 |
| effect/fanout@64 | 1.025 | 0.978–1.054 | 0.709–1.077 | 3 / 5 |
| effect/dynamic-dependencies@1 | 0.796 | 0.759–0.948 | 0.678–1.097 | 6 / 2 |
| computed/create@1 | 1.214 | 1.183–1.299 | 0.982–1.568 | 1 / 7 |
| computed/dirty-read@1 | 1.082 | 0.944–1.314 | 0.725–1.549 | 3 / 5 |
| computed/dirty-unread@1 | 1.196 | 1.136–1.237 | 0.817–1.616 | 1 / 7 |
| computed/equality-suppression@1 | 1.036 | 0.893–1.185 | 0.629–1.448 | 4 / 4 |
| computed/source-to-many@1 | 1.099 | 0.891–1.192 | 0.723–1.361 | 3 / 5 |
| computed/source-to-many@16 | 1.284 | 1.226–1.321 | 0.915–1.509 | 1 / 7 |
| computed/source-to-many@64 | 1.166 | 1.102–1.395 | 0.885–1.548 | 1 / 7 |
| computed/many-to-one@1 | 1.214 | 1.145–1.294 | 0.900–1.384 | 1 / 7 |
| computed/many-to-one@16 | 0.815 | 0.767–0.863 | 0.604–0.894 | 8 / 0 |
| computed/many-to-one@64 | 0.786 | 0.673–0.867 | 0.594–1.059 | 6 / 2 |
| batch/two-writes-one-reaction@1 | 1.015 | 0.907–1.180 | 0.528–1.586 | 4 / 4 |
| DeepSignal read@1 | 0.973 | 0.898–1.036 | 0.728–1.419 | 4 / 4 |
| DeepSignal watched-leaf write@1 | 0.915 | 0.820–1.038 | 0.780–1.270 | 6 / 2 |
| React bare tracking@1 | 0.930 | 0.900–0.969 | 0.880–1.039 | 6 / 2 |
| React managed tracking@1 | 0.871 | 0.819–0.984 | 0.398–1.142 | 6 / 2 |
| useSignalValue@1 | 0.977 | 0.954–1.043 | 0.883–1.364 | 5 / 3 |
| JSX direct binding@1 | 1.151 | 1.030–1.212 | 0.923–1.298 | 2 / 6 |

The final matrix retains material, repeatable construction/read and fan-out differences versus v0.1.1, as well as gains in observed writes, dynamic dependencies, and computed fan-in at sizes 16/64. The accepted direct C3/M1.5.3 comparison shows that the representation reduces the relevant create/read cost against the immediately preceding production baseline; existing M1.1 attribution and M1.5.3 acceptance remain the basis for treating residual gaps as optimization work rather than a new release blocker. The allocation results remain coarse: graph live/retained medians were 1,281,232/226,720 B; one-source/many-effects 419,528/92,328 B; DeepSignal watched leaves 3,317,416/460,904 B. Disposal/shape checks passed.

## Validation and retained artifacts

Passed during candidate checks:

- `pnpm typecheck`
- `pnpm exec vitest run tests/reactive-runtime.test.ts tests/runtime-surface.test.ts tests/cross-instance.test.tsx` — 56 tests
- `pnpm build:runtime`

The full production gate and authoritative M1b were not run because all production candidates were rejected at the diagnostic screen. The final worktree contains no production source or test changes. The raw diagnostic files include the runner's start-state and frozen-count hash. `m154-source-representation-screen.mjs` supports the focused source-only comparison with `M154_FOCUSED=1`; `summarize-m154.mjs` summarizes either output set with the same flag.

**Final decision: C3 is accepted, Phase 9 performance validation is closed, and M2 may begin next.** No M2 work is included in this change.
