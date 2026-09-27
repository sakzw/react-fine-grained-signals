# Phase 9 M1.4.2 — Cross-copy-aware Source Fast Path

## Decision

**Outcome B: the activity index was technically upgradeable, but the source candidate was rejected and no runtime code was retained.** The clean ordinary read gained an early-return shape, yet it was substantially slower. Accessor-backed shared context fields also imposed large costs on effect and computed scopes, and the exact bundle budgets failed. M1.4.1's effect/computed decisions remain closed. No calibration, authoritative M1b run, or M2 work was performed.

## Starting state and context study

The verified starting local and remote `main` were clean and equal at `978e710a3e03f35c666b10f7eed1ce4e8832ca5f` (`docs: record Phase 9 M1.4.1 refinement`). The experiment used a control worktree at that revision and an isolated candidate worktree.

On a fresh V1 context, `speculativeDepth` is an own data property with `configurable`, `writable`, and `enumerable` all `true`, value `0`. `graphCollector` and `renderCollector` are initially absent; after ordinary assignment, they are normal writable/configurable/enumerable data properties. `renderScope` is not read by `readSignalValue`; the source-read behavior depends on `renderCollector`, so `renderScope` was excluded from activity tracking.

## Temporary design and compatibility results

The prototype installed an optional integer mask under a private `Symbol.for` key on the existing shared V1 object:

| Bit | Tracked V1 field | Active when |
| --- | --- | --- |
| `1` | `graphCollector` | value is not `undefined` |
| `2` | `renderCollector` | value is not `undefined` |
| `4` | `speculativeDepth` | depth is greater than zero |

The three fields were upgraded in place to accessors. Their setters retained the field value and updated one bit. The same mask was used for an old-first context and a candidate-first context, without replacing the global object. A valid V1 object with an incompatible non-configurable field safely stayed on the old slow path. No readable protocol fields or public API were changed, and the design added no per-read or per-signal allocation.

Fresh independent baseline and candidate bundles passed old-first and candidate-first smoke checks. The old copy continued to install/restore graph and render collectors through its unchanged context assignments; cross-copy effects and computed values updated correctly in both directions. Bare and managed React reads across the two initialization orders updated correctly. Nested speculative depth, render-scope restoration, and exception cleanup passed. Existing duplicate-package/cross-copy suites also passed. The exploratory mixed-copy harness was run during the isolated experiment and was not retained because the runtime implementation was rejected.

## Candidate path and structural inspection

The candidate first checked the shared mask and local subscriber/speculative/render state. With no activity and no Dirty bit it returned `currentValue`; a Dirty source still went through `readSignalCore` and its pending-value settlement. Special modes continued into the existing path. There was no local activity mask and no change to render-scope setup APIs.

The built `readSignalValue` contained an early branch that avoids the subsequent speculative, render, foreign-graph, and core-read checks on an ordinary clean read. The function as a whole grew, and every context field access involved in scope installation/restoration became an accessor call. No V8 trace/profile was used: paired timings already showed the candidate losing decisively, so additional JIT diagnostics could not affect the selection.

## Paired measurements

All records compare the unchanged starting-HEAD runtime with the isolated candidate. Runs used Node v24.21.0, frozen M1b iteration counts, 3 warmups and 7 samples per process, serial execution, and alternating control/candidate process order. Ratios below are **duration candidate/control** (`<1` is faster); throughput equivalent is its inverse. Per-process samples and paired ratios are preserved in the [primary](../benchmarks/phase9/attribution/m142-source-primary-24.json), [adjacent](../benchmarks/phase9/attribution/m142-source-adjacent-8.json), and [React](../benchmarks/phase9/attribution/m142-source-react-4.json) records.

| Workload | Pairs | Median duration ratio (Q1–Q3) | Candidate faster | Throughput equivalent | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| `source/read@1` | 24 | 1.888 (1.708–2.204) | 0/24 | 0.530× | Large, repeatable regression. |
| `source/write-read@1` | 24 | 1.144 (0.932–1.474) | 9/24 | 0.874× | Wide spread; no material supported improvement. |
| `source/create@1` | 8 | 0.986 (0.973–1.025) | 5/8 | 1.014× | Near parity. |
| `source/unobserved-write@1` | 8 | 1.035 (0.988–1.113) | 3/8 | 0.966× | Near parity/slight slower direction. |

Adjacent workloads show the shared-scope cost clearly:

| Workload | Pairs | Median duration ratio (Q1–Q3) | Candidate faster |
| --- | ---: | ---: | ---: |
| `computed/dirty-read@1` | 8 | 3.618 (2.999–3.869) | 0/8 |
| `computed/equality-suppression@1` | 8 | 3.094 (2.824–3.303) | 0/8 |
| `effect/observed-write@1` | 8 | 4.349 (3.691–4.641) | 0/8 |
| `effect/dynamic-dependencies@1` | 8 | 3.340 (3.051–3.716) | 0/8 |
| `effect/fanout@16` | 8 | 13.545 (11.410–14.633) | 0/8 |
| `effect/fanout@64` | 8 | 9.171 (8.626–9.524) | 0/8 |
| `batch/two-writes-one-reaction@1` | 8 | 4.143 (3.557–4.181) | 0/8 |

The React diagnostics used four paired process rounds per workload. Bare tracking was 1.033 (0.983–1.048), managed tracking 1.004 (0.973–1.088), `useSignalValue` 0.970 (0.955–1.013), and JSX direct binding 0.877 (0.836–0.932). The first three were near parity/noisy; JSX direct binding favored the candidate in this small diagnostic. None can offset the source-read and adjacent runtime regressions.

## Bundle size and validation

The exact gzip byte comparison used the same `check-size.mjs --exact` scenarios and passed tree-shaking structural checks. Six existing budgets failed; no budgets were changed.

| Entry | Baseline bytes | Candidate bytes | Delta |
| --- | ---: | ---: | ---: |
| signal-only | 6,066 | 6,453 | +387 |
| core | 6,110 | 6,495 | +385 |
| core+hooks | 7,466 | 7,862 | +396 |
| deep | 10,579 | 10,942 | +363 |
| index-full | 11,776 | 12,135 | +359 |
| jsx-runtime | 9,290 | 9,689 | +399 |
| utils | 7,395 | 7,787 | +392 |

The isolated candidate passed `pnpm typecheck`, `pnpm lint` (existing warnings only), `pnpm test` (283 runtime tests; 221 transform tests passed, 3 skipped), `pnpm test:phase4-duplicate`, `tests/cross-copy-smoke.mjs`, `pnpm test:consumer`, and `pnpm test:browser` (27/27). Mixed-version smoke also passed for both initialization orders and the unupgradeable-context fallback. `check-size.mjs --exact` returned the expected nonzero status because the six listed budgets were exceeded.

## Closure and readiness

The prototype answers the compatibility questions positively: a valid V1 context can be upgraded in place; old copies using ordinary field assignments update the mask; and both initialization orders preserved tested behavior. The candidate did shorten the ordinary clean path's executed branch sequence. However, it **did not materially improve source/read or write-read**, and accessor-backed scope setup caused severe, repeatable regressions. The candidate was discarded; there is no accepted activity index or production runtime change.

The M1b source/read gap therefore remains. A different M1 experiment is justified only if it avoids adding accessor cost to every graph/render/speculative scope. M2 is not ready to begin. No authoritative M1b calibration or matrix, final M1.4.2 matrix, or release interpretation was run.
