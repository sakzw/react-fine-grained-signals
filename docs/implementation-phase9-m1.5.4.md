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
| C3 — internal-node protocol, source-only owner-free branch; computed getter restored | 1.36 (1.25–1.60) | 1.08 (1.01–1.17) | 1.28 (1.14–1.41) | Rejected: source/read gain was small and dirty-read remained slower; no candidate clears the full trade-off. |

C3 was measured in a focused 24-round create/read and 8-round control screen. Against the intermediate `m151-integrated` runtime, its medians were 0.89 create, 0.88 read, 1.34 computed dirty-read, and 1.02 effect observed-write. These paired screens are diagnostics, not release conclusions; the v0.1.1 comparison is the controlling M1b baseline. The computed dirty-read result is especially unfavorable: C1 was 1.40 and C3 was 1.28 versus v0.1.1, with all eight C3 paired rounds slower.

The rejected C1/C3 protocol placement adds a property to each internal graph node. C2 avoids that node shape change, but also did not show a repeatable create/read benefit. The source-only owner-free branch avoids the computed change but its focused screen still did not eliminate the broader source create/read and dirty-read trade-off. No representation candidate is accepted; production source and production tests were restored to the starting commit. Therefore the conditional authoritative M1b matrix was not run, and no performance conclusion or baseline change is made.

## Validation and retained artifacts

Passed during candidate checks:

- `pnpm typecheck`
- `pnpm exec vitest run tests/reactive-runtime.test.ts tests/runtime-surface.test.ts tests/cross-instance.test.tsx` — 56 tests
- `pnpm build:runtime`

The full production gate and authoritative M1b were not run because all production candidates were rejected at the diagnostic screen. The final worktree contains no production source or test changes. The raw diagnostic files include the runner's start-state and frozen-count hash. `m154-source-representation-screen.mjs` supports the focused source-only comparison with `M154_FOCUSED=1`; `summarize-m154.mjs` summarizes either output set with the same flag.

**M1.5.4 closes with no production change accepted.** Keep the M1.5.3 implementation and its frozen interpretation. Do not begin M2 based on these rejected candidates.
