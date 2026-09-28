# Phase 9 M1.5.3 — Hot-path recovery and contract freeze

## Decision and starting point

Starting HEAD was `c72bacd03bc4b156dc382a972e97521f04539462` (`feat: port M1.5.1 runtime architecture to production`); local and `origin/main` agreed and the checkout was clean. The selected Alien-derived graph architecture remains unchanged. No public API names or dependency topology changed.

**Decision A — Freeze.** The Phase 8 ownership contract and strict production typing are restored, the focused hot paths are near the M1.5.1 owner candidate, full correctness passes, bundle budgets pass with narrow headroom, and the authoritative M1b matrix is complete. M2 may begin next. No M2 work is included here.

## Scope, ownership, and graph changes

The Phase 8 matrix is restored and tested both within one copy and across duplicate package copies:

| Transition | Final behavior |
| --- | --- |
| managed → managed | Lexical nesting; inner finish restores the managed parent. |
| managed → bare | Bare start closes the managed parent; it does not resume. |
| bare → managed | Managed start closes the bare parent; after managed finish reads are untracked. |
| bare → bare | Inner bare start closes the prior bare scope; it does not resume. |

Long-lived render scopes still use `pushExecutionOwner()` frames so cleanup can occur later or out of order. Synchronous graph callbacks use direct owner save/set/`finally` restore. `withGraphOwner` restores the previous owner and render attempt while retaining nested same-runtime optimization and foreign publication. Computed evaluation, effect callback/cleanup, `untracked()`, protocol revision reads, and ordinary synchronous graph scopes no longer allocate or push owner frames.

Local computed nodes keep `foreignDependent` false; foreign reads mark the active computed. Only foreign-dependent computed values refresh or activate foreign dependencies. Transition tests cover local↔foreign changes, foreign replacement, nested chains, and cold/live cases. Recursive computed cleanup was removed: Alien unlink/unwatched callbacks already release dependencies, and cleanup/error tests pass.

The Dirty effect fast path remains intact. A final getter adjustment branches on the ordinary `owner === undefined` case before checking graph/render owner kinds. This preserves render-collector tracking and foreign publication while keeping the common local read away from both type guards. The emitted production getter was rebuilt and measured; source/read's focused current/M1.5.1 duration ratio moved from 1.36x to 1.06x.

## Contract and TypeScript audit

Tests now explicitly cover all four mixed-scope rules in same-copy and duplicate-copy cases. Additional retained contracts include: SSR evaluates separately for independent speculative requests; computed errors recover when the source revision advances; cross-copy batches publish the observed final effect values; foreign dependency errors/subscriptions recover and release correctly; and render attempts preserve StrictMode, Suspense, throw cleanup, and render-to-commit behavior.

Production modules migrated from `.mjs` plus permissive declaration shims to checked `.mts`:

- `src/core/alien-derived-runtime-core.mts`
- `src/core/foreign-readable-v1.mts`
- `src/core/interop-context.mts`
- `src/core/render-runtime.mts`
- `src/react/react-adapter.mts`
- `src/core/alien-derived-types.ts` provides local strict graph types.

The redundant `.d.mts` shims were removed; `tsconfig.json` includes `.mts`. The production runtime still imports only `alien-signals/system`. Alien remains a normal dependency; topology was unchanged.

## Corrected history and comparison method

The historical table in [M1.5.2](implementation-phase9-m1.5.2.md#final-authoritative-matrix) was corrected to use **throughput ratios versus v0.1.1** for old production, M1.5.1 research, and M1.5.2 production wherever the source runs support that comparison. M1.5.1 values are reciprocals of its recorded duration ratios; they are not direct paired comparisons to M1.5.2. React values for M1.5.1 remain `n/a`. No duration value is mixed into that throughput table.

The 24-pair M1.5.3 diagnostic used 3 warmups, 7 samples, frozen iteration SHA-256 `fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`, serial fresh processes, and the balanced four-runtime order. Its focused ratios below are **duration ratios, M1.5.3 production / M1.5.1 integrated owner candidate**; below 1 is faster. Q1/Q3 are the paired-round spread.

| Case | Median | Q1–Q3 | Current slower rounds |
| --- | ---: | ---: | ---: |
| source/read | 1.06 | 0.90–1.28 | 15/24 |
| source/write-read | 1.48 | 1.28–1.77 | 22/24 |
| computed/dirty-read | 1.22 | 0.92–1.48 | 15/24 |
| computed/equality-suppression | 1.27 | 1.12–1.40 | 21/24 |
| effect/observed-write | 1.00 | 0.82–1.12 | 11/24 |
| effect/dynamic-dependencies | 1.11 | 0.85–1.28 | 16/24 |
| effect/fanout@1 | 0.92 | 0.86–1.32 | 10/24 |
| effect/fanout@16 | 0.99 | 0.89–1.24 | 12/24 |
| effect/fanout@64 | 0.94 | 0.83–1.14 | 11/24 |
| batch/two-writes-one-reaction | 1.12 | 0.89–1.23 | 15/24 |

The direct synchronous owner primitive diagnostic separately compared direct save/restore to frame push/restore: direct/frame median duration ratio was 0.38, with direct faster in all 24 rounds. The callback count, restored owner, and zero remaining frame depth were verified. This microdiagnostic isolates only the owner primitive, not graph throughput.

## React and allocation diagnostics

React/DeepSignal selector results use **duration ratios, current / v0.1.1**, for eight paired rounds, three warmups, and seven samples:

| Case | Median | Q1–Q3 |
| --- | ---: | ---: |
| bare tracking | 1.10 | 1.07–1.27 |
| managed tracking | 1.07 | 0.99–1.11 |
| useSignalValue | 0.92 | 0.89–1.01 |
| JSX direct binding | 0.93 | 0.87–1.01 |
| DeepSignal selector | 1.03 | 0.98–1.07 |

Allocation diagnostics are retained-heap measurements after disposal, three rounds at graph count 1,000. They are directional, not bytes-per-node or allocation-rate measurements.

| Shape | Runtime | Live median | Retained median |
| --- | --- | ---: | ---: |
| signal/computed/effect graph | M1.5.3 | 1,656,104 B | 300,288 B |
| 1 source + 1,000 effects | M1.5.3 | 418,832 B | 91,928 B |
| 1,000 DeepSignal watched leaves | M1.5.3 | 3,688,008 B | 529,656 B |
| signal/computed/effect graph | v0.1.1 | 1,950,768 B | 203,960 B |
| 1 source + 1,000 effects | v0.1.1 | 492,040 B | 83,064 B |
| 1,000 DeepSignal watched leaves | v0.1.1 | 3,213,232 B | 297,544 B |

The DeepSignal heap footprint remains higher than v0.1.1; this is an optimization signal, not a release gate. Disposal assertions passed for every allocation row.

## Final authoritative M1b matrix

The completed run is [`m1.5.3-2026-09-29-hot-path-recovery-final`](../benchmarks/phase9/results/m1.5.3-2026-09-29-hot-path-recovery-final/). It used 8 balanced rounds, 3 warmups, 7 samples, frozen M1b iterations, graph count 1,000, and 3 allocation rounds. Starting HEAD, runtime inputs SHA, built artifact SHA, exact round order, and frozen iteration SHA are in the manifest. The analyzer verified all identities, sample groups, orders, and allocation shapes.

There were 958/958 completed tasks, 6,096 sample rows (5,992 successful and 104 expected N/A), 30 allocation rows, and zero failures. The primary statistic is **paired throughput ratio, M1.5.3 / v0.1.1**. Values below 1 are slower; values above 1 are faster. Q1–Q3 and direction counts show spread across eight paired rounds. Rough parity is symmetric around 1.00; values above 1.05 are not automatically claimed as improvements.

| Workload | M1.5.3 / v0.1.1 | Q1–Q3 | Rounds below / above 1 |
| --- | ---: | ---: | ---: |
| source/create | 0.57 | 0.50–0.67 | 8 / 0 |
| source/read | 0.77 | 0.71–0.81 | 8 / 0 |
| source/unobserved-write | 0.93 | 0.85–0.96 | 7 / 1 |
| source/write-read | 0.96 | 0.87–1.03 | 4 / 4 |
| effect/create | 0.70 | 0.66–0.79 | 7 / 1 |
| effect/create-dispose | 0.92 | 0.87–0.95 | 7 / 1 |
| effect/observed-write | 1.29 | 1.21–1.38 | 0 / 8 |
| effect/fanout@1 | 0.84 | 0.72–0.96 | 6 / 2 |
| effect/fanout@16 | 1.07 | 0.93–1.11 | 3 / 5 |
| effect/fanout@64 | 1.02 | 0.92–1.11 | 4 / 4 |
| effect/dynamic-dependencies | 0.96 | 0.82–1.10 | 5 / 3 |
| computed/create | 0.76 | 0.65–0.93 | 7 / 1 |
| computed/dirty-read | 0.87 | 0.84–0.98 | 6 / 2 |
| computed/dirty-unread | 1.20 | 1.18–1.47 | 1 / 7 |
| computed/equality-suppression | 1.08 | 0.90–1.10 | 3 / 5 |
| computed/source-to-many@1 | 0.88 | 0.80–1.15 | 5 / 3 |
| computed/source-to-many@16 | 1.20 | 1.09–1.37 | 1 / 7 |
| computed/source-to-many@64 | 1.25 | 1.14–1.31 | 1 / 7 |
| computed/many-to-one@1 | 1.19 | 0.94–1.40 | 3 / 5 |
| computed/many-to-one@16 | 1.07 | 0.96–1.09 | 3 / 5 |
| computed/many-to-one@64 | 1.09 | 0.89–1.31 | 3 / 5 |
| batch/two-writes-one-reaction | 0.95 | 0.90–1.20 | 5 / 3 |
| DeepSignal read | 0.96 | 0.86–1.19 | 5 / 3 |
| DeepSignal watched leaf write | 1.00 | 0.95–1.14 | 3 / 5 |
| React bare tracking | 1.00 | 0.93–1.08 | 4 / 4 |
| React managed tracking | 0.98 | 0.93–1.09 | 4 / 4 |
| useSignalValue | 0.99 | 0.92–1.05 | 5 / 3 |
| JSX direct binding | 1.01 | 0.96–1.06 | 3 / 5 |

The prior old-production and M1.5.1 research ratios appear in the corrected M1.5.2 history table; that table uses the same throughput/v0.1.1 convention and is not represented as a paired comparison with this run. M1.5.3 materially improves the former production effect/computed paths; effect observed-write is a repeatable improvement. Fanout@64 and source/write-read are rough parity by median; fanout@16's 1.07 median has a wide interval crossing parity, so no improvement is claimed. Source/read remains below v0.1.1, but is close to the M1.5.1 research throughput baseline and improves over old production. Residual source write/read duration versus the research-only owner core reflects production render revision bookkeeping; the release-facing paired result is near parity. These remaining v0.1.1 differences do not form a release blocker.

## Package size and validation

The final gzip measurements and frozen budgets are:

| Entry scenario | Gzip | Budget |
| --- | ---: | ---: |
| Signal-only | 6.54 KiB | 6.88 KiB |
| Core | 6.58 KiB | 6.94 KiB |
| Core + hooks | 8.13 KiB | 8.56 KiB |
| Deep | 11.18 KiB | 11.75 KiB |
| Full index | 12.67 KiB | 13.31 KiB |
| JSX runtime | 9.85 KiB | 10.38 KiB |
| Utils | 7.99 KiB | 8.44 KiB |

Budgets retain 5% headroom and tree-shaking checks pass. Final validation after the runtime adjustment passed:

```text
pnpm typecheck
pnpm lint (existing warnings only)
pnpm test (285 root tests + 221 plugin tests; 3 skipped)
pnpm build
pnpm test:phase4-duplicate
pnpm test:consumer
pnpm test:browser (27 passed)
pnpm size
git diff --check
```

No commit, push, rebase, amend, merge, or tag operation was performed. M2 did not begin.
