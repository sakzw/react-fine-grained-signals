# Phase 5 implementation checkpoint

## Status

Phase 5 runtime behavior, packaging migration, duplicate-package validation, and cleanup are implemented. The runtime architecture blocker is resolved: speculative computed-cache behavior is now unconditional and identical for the production singleton and independently constructed runtimes. The final performance review found large Phase 4-to-Phase 5 core regressions that the code inspection could not attribute quantitatively to specific correctness/interoperability costs. Phase 5 is not ready to freeze.

No Phase 6 work has started. No git history operation was performed.

## M0–M5

- **M0 — complete.** `tests/consumer-smoke.mjs` now resolves pnpm's Node CLI and launches it directly, avoiding Windows `.cmd`/`spawn` behavior and avoiding `shell: true`. Baselines are recorded below.
- **M1 — complete.** The Phase 4 implementation and tests were promoted from `low-level-runtime` to `reactive-runtime`; the old production path and duplicate implementation are gone.
- **M2 — complete.** `deepSignal` counters use the RFSG runtime and no longer read alien's high-level active-subscriber or batch-depth state.
- **M3 — complete.** Public primitives delegate through wrappers to `coreRuntime`; render suppression, error reporting, interop forwarding, deep-signal regressions, and one option-free speculative cache policy pass.
- **M4 — complete.** Public duplicate-package behavior passes using three independent RFSG builds, each bundling its own alien-signals system. `alien-signals` is a runtime dependency; React remains the peer.
- **M5 — complete.** The obsolete runtime path is deleted, production code no longer imports alien's root high-level reactive APIs, and documentation was migrated from the shared-alien requirement.

## Runtime structure

The private module dependencies are:

```text
render-tracking.ts → interop.ts
reactive-runtime.ts → render-tracking.ts, interop.ts, alien-signals/system
core-runtime.ts → reactive-runtime.ts
base.ts → core-runtime.ts, interop.ts
deep-signal.ts → base.ts, core-runtime.ts, render-tracking.ts
```

`interop.ts` owns the private same-global protocol, shared graph/render collectors, speculative depth, and helpers. `render-tracking.ts` owns React render-dependency infrastructure. `reactive-runtime.ts` imports only `alien-signals/system` and private interop/render infrastructure; it owns graph nodes, batching, scheduling, liveness, subscriptions, and the isolated runtime factory. `core-runtime.ts` creates the module-local production runtime. `base.ts` exposes thin public wrappers; `deep-signal.ts` keeps its existing Proxy/data model and uses narrow runtime/render helpers.

There is one production runtime per RFSG module copy. No runtime is stored globally and no shared scheduler or cross-runtime batch was introduced. Public wrapper objects hide internal nodes and pass through the exact `ReadableInteropV1` object from their inner runtime readable. `SIGNAL_BRAND` remains a separate public identity mechanism.

`signal`, `computed`, `effect`, `batch`, and `untracked` all delegate to `coreRuntime`. Writable signals and computeds remain wrappers; no runtime node or subscription surface becomes public. Effect cleanup suppresses graph and render collection. Normal graph evaluation suppresses render collection while retaining graph collection. Existing error containment/reporting behavior remains covered by the public suite.

### Unified speculative cache behavior

`ReactiveRuntimeOptions` and `reuseSpeculativeComputedCache` were removed. Every runtime now validates and reuses a current speculative computed snapshot, and promotes it on the first committed graph read. Promotion links its captured dependencies without reevaluating the getter.

The nested batch-revert case remains covered and passes with cache reuse enabled for every runtime. The private regression test now asserts the intended promotion contract directly: a current speculative snapshot is committed without reevaluation, its graph dependencies are linked, and its render revision/listener stay stable. This replaces its former expectation that commit reevaluates an identity-unstable getter and creates an extra revision. The managed-hook identity stability case also passes under the same unconditional runtime behavior.

Speculative deep reads also advance a shared epoch, making computed speculative caches non-promotable when deep-property tracking could not be registered. This fixed the managed React Router stale deep-property update regression. A dedicated managed-hook test covers this path.

## deepSignal and duplicate-copy guarantees

`deepSignal` has no imports from alien's high-level root API. Its read predicate is false during shared speculative rendering and otherwise checks the production runtime's active graph subscriber, local render collector, shared graph collector, and shared render collector. Unobserved reads therefore do not allocate per-key metadata. Root, property, existence, and iteration versions use the production RFSG runtime. Batch depth is local to that runtime. Conservative `markWatched()` is retained to cover the render-to-commit subscription window; actual graph liveness is also considered for pruning.

Coverage now includes cross-runtime computed/effect reads of deep properties, deep-property React tracking, sibling isolation, dynamic pruning, Object.is behavior, and `useSignalValue` observing a signal from another package copy. Public duplicate smoke builds three independent package bundles, each with its own alien system, and verifies shallow/deep behavior, computed/effect propagation, batching local to each runtime, React render tracking, and value-hook updates. The smoke observed cross-copy batch values `[0, 2]`; cross-runtime batches are intentionally not atomic.

The Phase 1 requirement that every RFSG copy resolve the identical alien package instance is retired. `SIGNAL_BRAND` identity does not imply reactive interop with older package copies that lack `ReadableInteropV1`.

## Packaging and source audit

Root `package.json` now declares `alien-signals` under `dependencies` and retains React under `peerDependencies`; alien is not a peer dependency. Production build externalizes the dependency normally rather than force-bundling it. Example Vite configs no longer dedupe alien solely for correctness; React/ReactDOM dedupe remains.

The only production imports from alien are `alien-signals/system` in `src/core/reactive-runtime.ts` (runtime values and the `ReactiveNode` type). No production imports remain from alien's root high-level API. Benchmarks and comparison/reference tests may use alien's high-level public APIs intentionally.

## Size and benchmark results

Sizes are gzip kB; these consumer-build measurements include alien-signals after it became an ordinary runtime dependency. Baseline figures are from M0 on Node v24.21.0; final figures are from Node v24.20.0, Windows x64, so compare as directional rather than exact.

| Consumer | M0 | Final | Final budget |
| --- | ---: | ---: | ---: |
| signal-only | 2.56 | 5.57 | 6.00 |
| core | 3.51 | 5.66 | 6.13 |
| core+hooks | 4.99 | 7.16 | 7.75 |
| deep | 7.24 | 9.58 | 10.38 |
| index-full | 8.69 | 10.74 | 11.69 |
| jsx-runtime | 5.77 | 8.67 | 9.38 |
| utils | 3.52 | 6.75 | 7.31 |

Tree-shaking checks remain structurally green: signal-only/core builds do not pull the React hooks, JSX runtime, or deepSignal implementation. The gzip growth is consistent with including the runtime dependency in consumer bundles. Budgets retain roughly 10% headroom and `pnpm size` passes.

Final core benchmark (Node v24.20.0, Windows x64, AMD Ryzen 7 PRO 6850U; median ops/s, 100,000 operations, 9 samples):

| Case | Alien raw | RFSG |
| --- | ---: | ---: |
| signal read | 40.14M | 23.85M |
| signal write | 36.67M | 17.31M |
| observed write | 8.98M | 0.77M |
| computed update/read | 10.40M | 0.63M |
| two observed batch writes | 3.14M | 0.15M |

Final deep benchmark (50,000 operations, same host): nested read 0.99M ops/s; observed leaf write 0.16M; sibling isolation 0.77M; parent replacement 0.04M; array push 0.12M. Compared with the M0 results (1.19M, 0.41M, 1.23M, 0.14M, 0.33M respectively), most cases regressed; Node patch version differs.

Final React benchmark (500 rows, 300 updates, 5 samples; median ms): hooks-naive 5471.949; hooks-memo 1926.864; signals 381.111; signals-managed 368.649; JSX component 5794.779; JSX host element 5998.414. M0 medians were 3931.308, 1011.125, 398.754, 325.169, 3394.622, and 3965.151. Signals paths are similar/slower by about 5–14%; JSX render paths are materially slower in this run. Isolated JSX pragma calls measured 874.953 ms per 200k custom-component calls and 1082.454 ms per 200k host-element calls.

These measurements are manual diagnostics, not CI thresholds. The large core observed/computed/batch and JSX deltas need a dedicated performance investigation before a release freeze. No Phase 6 optimization was started here.

### Final Phase 4-to-Phase 5 performance review (2026-09-26)

The primary A/B comparison used Phase 4 freeze `c7603dc1d389c08fa62c61a20a1fa4a294ad9715` and Phase 5 `f3f76bdc6bd00edfab584b0930087ada7bfea145`. Both ran on Windows x64 / AMD Ryzen 7 PRO 6850U with pnpm 11.24.0 and the repository's pinned Node runtime v24.20.0. The same benchmark scripts and iteration counts were used: core 100,000 operations, 3 warmups and 9 samples; deepSignal 50,000 operations and 9 samples; React 500 rows, 300 updates and 5 samples. The benchmark scripts did not differ between the revisions. Throughput ratios below are P5/P4; timings are median-derived. This A/B supersedes M0 comparisons for assessing migration impact. The isolated JSX smoke is a separate 200,000-call timing, not an ops/s suite.

Core throughput (ops/s; lower means slower):

| Case | Phase 4 | Phase 5 | P5/P4 | P4 p25–p75 ms | P5 p25–p75 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| signal read | 53.21M | 22.83M | 0.43× | 1.847–1.941 | 4.125–5.228 |
| unobserved signal write | 41.40M | 27.26M | 0.66× | 2.350–2.536 | 3.032–18.570 |
| observed signal write | 9.95M | 1.26M | 0.13× | 9.630–10.308 | 72.398–93.891 |
| computed update/read | 8.01M | 1.35M | 0.17× | 12.388–12.991 | 65.656–78.148 |
| two observed batch writes | 3.96M | 0.15M | 0.15× | 23.877–29.722 | 166.778–190.593 |

DeepSignal throughput (ops/s; lower means slower):

| Case | Phase 4 | Phase 5 | P5/P4 | P4 p25–p75 ms | P5 p25–p75 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| nested read | 1.79M | 1.34M | 0.75× | 27.449–29.442 | 32.127–38.603 |
| observed leaf write | 0.77M | 0.37M | 0.48× | 61.547–85.823 | 127.002–150.352 |
| sibling isolation | 1.57M | 1.38M | 0.88× | 30.456–32.398 | 33.248–37.954 |
| parent replacement | 0.15M | 0.07M | 0.49× | 324.518–360.444 | 643.500–694.648 |
| array push | 0.30M | 0.22M | 0.73× | 154.624–170.516 | 224.323–254.169 |

React and JSX medians (ms; lower means faster):

| Case | Phase 4 | Phase 5 | Change | Phase 4 p25–p75 ms | Phase 5 p25–p75 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| hooks-naive control | 2,181.8 | 3,903.9 | +79% | 2,153.4–2,772.9 | 3,509.3–4,130.6 |
| hooks-memo control | 843.3 | 1,650.6 | +96% | 810.8–1,037.5 | 1,608.1–1,871.1 |
| signals | 177.5 | 208.6 | +18% | 175.7–178.1 | 200.0–210.6 |
| signals-managed | 171.5 | 195.8 | +14% | 169.2–173.2 | 186.1–199.8 |
| JSX component | 3,684.3 | 3,695.8 | +0.3% | 3,273.9–3,974.0 | 3,366.6–4,224.7 |
| JSX host element | 3,095.0 | 4,608.1 | +49% | 2,621.4–3,212.9 | 4,536.1–4,804.6 |

The plain React controls nearly doubled, so they demonstrate substantial environment/run-to-run noise in the React suite. JSX component time was effectively unchanged while host-element time increased; isolated JSX calls also rose from 638.7 to 726.8 ms for 200k custom-component calls and from 765.8 to 908.4 ms for 200k host calls. The JSX source and benchmark harness did not change. These JSX deltas are therefore inconclusive and are not used as the freeze blocker. The signals and signals-managed differences are smaller than the controls' movement.

The core and deepSignal suites show much more repeatable, workload-specific regressions than the React controls. Source inspection found no repeated whole-graph liveness scan on source-only reads/writes: source dependencies bypass computed liveness scans; liveness scans are gated to computed/external nodes and graph-link changes. Source-only effects also bypass `system.checkDirty()`; computed dirty checking is gated by computed/foreign dependencies. Local dependency reads return before foreign interop publication. Speculative result/dependency capture is entered for render/speculative reads, not ordinary source-only effect updates. These findings rule out the suspected asymptotic whole-graph scan and identify the broad additional work as Phase 5 graph tracking, scheduler/lifecycle, and interop-safe bookkeeping, but do not apportion the measured constant-factor cost among those components.

A temporary private-vs-public microbenchmark measured signal reads at 2.51 ms private vs 2.84 ms public per 100,000 operations (about 13% wrapper cost), and observed writes at 68.08 ms vs 77.34 ms (about 14%); unobserved write samples were too noisy to interpret. The public wrapper is not the explanation for the 7.9× observed-write, 5.9× computed, and 6.7× batch throughput differences. Individual interop collector scope, render-suppression scope, liveness bookkeeping, scheduler, and speculative-cache costs were inspected but not independently instrumented; no separate numerical overhead claim is made for them. A combined local fast-path/context-scope experiment was measured, did not improve any core case, and was fully reverted. No performance optimization remains in the runtime from this review.

Classification: React control/JSX variation is **A, benchmark/environment noise**; wrapper delegation is a measured but modest Phase 5 cost (**C**, avoidable only via the explicitly deferred Phase 6 wrapper work); local scheduler, graph lifecycle, and cross-copy interop bookkeeping are plausible **B, expected Phase 5 correctness/interoperability costs**, but their exact contribution is unproven. The observed/computed/batch/deep deltas are therefore still an **unresolved Phase 5 performance blocker**, rather than being assumed acceptable. Direct subscriptions for `useSignalValue`/JSX, wrapper removal, and deepSignal redesign remain **E, Phase 6 opportunities**, and were not attempted.

The cleanup error-reporting contract was corrected during this review: public effect body and cleanup failures now both report the documented `effect() callback threw` message with `{ cause }`, while retaining guarded error reporting. Public and private cleanup regression tests pin that exact message.

## Validation

Final commands run on this worktree:

- Focused `pnpm exec vitest run tests/reactive-runtime.test.ts tests/use-signals-managed.test.tsx --maxWorkers=1`: passed, 61/61 after unifying cache behavior.
- `pnpm test`: passed; runtime 18 files / 259 tests, transform 3 files / 221 passed / 3 skipped.
- `pnpm typecheck`: passed for runtime and transform.
- `pnpm lint`: passed with existing style warnings in tests; no errors.
- `pnpm build`: passed for runtime and unplugin. TypeScript 7 emits its existing experimental API warning.
- `pnpm test:consumer`: passed; package builds, local consumer install/typecheck/Vite build, and public cross-copy smoke pass.
- `pnpm test:phase4-duplicate`: passed; three independent bundles.
- `pnpm test:browser`: passed, 27/27, including React Router and production-build cases.
- `pnpm size`: all budgets and structural checks passed.
- `pnpm bench`, `pnpm bench:deep`, `pnpm bench:react`: completed; results above.
- `git diff --check`: passed after the implementation and checkpoint edits.

Intentional unsupported/unchanged behavior: Phase 3 nested-effect conformance cases #209/#210 remain unsupported; cross-runtime batch operations remain non-atomic. The effect-backed `useSignalValue`, generic JSX binding effect, deepSignal Proxy architecture, and `markWatched()` remain unchanged for Phase 5.

## Files changed

Runtime and interop: `src/core/base.ts`, `src/core/core-runtime.ts`, `src/core/deep-signal.ts`, `src/core/interop.ts`, `src/core/reactive-runtime.ts`; removed `src/core/low-level-runtime.ts`.

Tests and fixtures: `tests/consumer-smoke.mjs`, `tests/cross-copy-smoke.mjs`, `tests/cross-instance.test.tsx`, `tests/fixtures/consumer-vite/package.json`, `tests/fixtures/phase4-duplicate-entry.ts`, `tests/phase4-duplicate-smoke.mjs`, `tests/react-render-tracking.test.tsx`, `tests/reactive-runtime.test.ts`, `tests/use-signals-managed.test.tsx`; removed `tests/low-level-runtime.test.ts`.

Packaging, size, examples, and docs: `package.json`, `pnpm-lock.yaml`, `scripts/check-size.mjs`, `scripts/size-budget.json`, `examples/browser/server.mjs`, `examples/browser/vite.config.ts`, `examples/react-router/vite.config.ts`, `README.md`, `README.ja.md`, `docs/core-primitives.md`, `docs/core-primitives.ja.md`, `docs/design/packaging.md`, `docs/design/packaging.ja.md`, `docs/global-state.md`, `docs/global-state.ja.md`, and this checkpoint.

## Remaining work and next action

- **Correctness blocker:** none found; final focused and full correctness checks pass.
- **Architecture blocker:** none found; the accepted Phase 5 architecture remains unchanged.
- **Performance blocker:** same-environment Phase 4-to-Phase 5 observed writes, computed update/read, and batched observed writes remain 7.9×, 5.9×, and 6.7× slower respectively. Inspection excludes the hypothesized repeated whole-graph scans and avoids blaming the modest public wrapper cost, but the remaining constant-factor cost has not been measured by component. Keep Phase 5 open until this gap is either isolated to understood correctness/interoperability work or reduced by a semantics-preserving Phase 5 optimization. Retain `markWatched()` until a separately scoped pruning change proves the render-to-commit window safe.
- **Future-version idea:** Phase 6 may consider direct private subscriptions for `useSignalValue`/JSX and later wrapper/pruning optimizations.

The next action is to isolate the Phase 5 core hot-path overhead while preserving semantics, then reassess freeze. Do not begin Phase 6 until Phase 5 is explicitly frozen.

**PHASE 5 NOT READY — PERFORMANCE BLOCKER**
