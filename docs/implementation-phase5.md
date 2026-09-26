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

### Core hot-path attribution

Attribution ran from clean `main` commit `8e7af9688d3078cb53f827fc5a303e47be986dbc` on Windows x64, AMD Ryzen 7 PRO 6850U, Node v24.20.0 (pnpm-managed), pnpm 11.24.0, alien-signals 3.2.1. Initial exploration used the same harness at 30,000 operations, 3 warmups, 9 samples; each source ablation was built, run, then reverted before the next. A fresh 100,000-operation/3-warmup/9-sample run was used for the final Phase 5 numbers below. Short-run raw alien controls moved substantially, so small ablation deltas are treated as inconclusive. No temporary ablation remains in the source.

The 30,000-op Phase 5 baseline was 1.53M observed writes/s, 1.32M computed update/read/s, and 0.55M two-observed-write batches/s. Ratios below are each ablation divided by that baseline; they are directional short-harness measurements, not additive cost shares.

| Temporary ablation | Observed | Computed | Batch | Reading |
| --- | ---: | ---: | ---: | --- |
| no shared graph collector scope | 0.80× | 0.83× | 0.96× | no recovery |
| no render suppression | 0.95× | 1.06× | 1.06× | no measurable change |
| both scopes removed | 0.87× | 1.01× | 1.07× | no recovery |
| liveness refresh no-op | 1.06× | 0.97× | 1.01× | no recovery; source node refresh already exits by kind |
| skip stale dependency pruning | 0.86× | 0.96× | 1.08× | no recovery on the fixed one-dependency effect |
| remove runReaction entry guards only | 0.95× | 0.89× | 1.08× | no clear change |
| dispatch directly to runReaction (bypass queue) | 0.88× | 0.97× | 1.01× | queue/flush alone is not dominant |
| shortest local active-subscriber source read | 0.80× | 1.08× | 1.04× | no recovery |
| skip normal computed observed-result refresh | 0.70× | 1.17× | 1.00× | noisy; did not improve computed throughput |
| cold-pull generation no-op | 0.78× | 0.91× | 1.09× | no consistent improvement |
| unconditional Pending computed update (skip `checkDirty`) | 0.88× | 1.28× | 1.08× | about 22% less computed time in this run, but changes redundant reevaluation behavior; not retained |
| direct-source revision fast-path candidate | 0.91× | 1.01× | 1.06× | no benefit; reverted |
| direct callback instead of `runReaction` | 2.64× / 2.72× | 1.07× / 0.90× | 0.99× / 1.03× | observed-write recovery repeated; omits runner lifecycle/error/cleanup/disposal guarantees, so attribution only |

The strongest isolated result is the source-only effect runner path: directly invoking the tracked callback, while bypassing `runReaction`, raised short-harness observed-write throughput from 1.53M to 4.05M and 4.17M ops/s on two runs. Calling `runReaction` directly instead of enqueueing it did not help. This localizes a substantial share of observed-write cost to work surrounding callback invocation in the reaction runner, beyond queue insertion/flush. Computed and batch cases did not improve under that callback ablation, so this does not explain their regressions or the full remaining gap. Removing only entry guards did not help; exact per-field shares within the runner were not isolated. This fast path intentionally violates cleanup, disposal, and error handling and is not eligible as a production change.

The public-vs-private control (100,000 operations, 3 warmups, 9 samples) measured private/public throughput of 37.19M/28.33M read, 9.20M/8.52M unobserved write, 1.55M/1.19M observed write, and 1.38M/1.39M computed update/read ops/s. Public read and observed-write medians were lower, but p25–p75 intervals overlapped or were noisy; this reconfirms that wrapper delegation is not the several-fold dominant cost. This control is diagnostic rather than a precision wrapper estimate.

An allocation/GC signal was also measured at 10,000 operations: V8 emitted 45 GC events for raw alien, 117 for RFSG, and 80 for Preact across the adapter suites. This count includes the harness's explicit per-sample collections and is not a byte-allocation measurement; it indicates greater RFSG allocation/collection pressure but does not identify which allocation site dominates. The earlier attribution pass did not include a heap profile; the follow-up below adds sampled allocation call sites.

Alien-signals v3.2.1 high-level source (`esm/index.mjs` and `esm/system.mjs`) handles a simple write by updating a source, propagating through graph links, running `checkDirty` as needed, executing the effect, and relinking/purging dependencies. RFSG uses that same low-level reactive system and adds: (1) public value wrappers — modest measured cost; (2) local/foreign graph collector and render isolation — their ablations did not improve throughput; (3) revision/error/result observation — required for render race detection, Object.is equality, and contained errors; (4) RFSG queue and reaction lifecycle — queue bypass alone did not help, but the broader runner/callback ablation recovered part of the source-only effect path; and (5) cross-copy/liveness state — liveness no-op did not affect these local benchmarks. The computed checkDirty ablation found a measurable computed-only cost, but safely bypassing it on a direct-local-source path needs a correct dependency-change shortcut; the attempted snapshot shortcut did not help.

The fresh final Phase 5 full core run measured 43.19M read, 24.75M unobserved write, 1.63M observed write, 1.50M computed update/read, and 0.46M batch ops/s. Against the recorded Phase 4 baseline, the ratios were 0.81×, 0.60×, 0.16×, 0.19×, and 0.12× respectively. The same fresh run's raw alien control measured 57.92M, 54.27M, 13.68M, 11.88M, and 3.81M ops/s. P5 p25–p75 times were 2.308–2.337, 3.765–22.513, 60.750–74.603, 64.045–81.785, and 188.303–287.713 ms. The broad write/batch ranges reflect machine/run variation; observed, computed, and batch remained far below both Phase 4 and same-run alien.

No production hot-path optimization was retained: scope, liveness, prune, lifecycle-guard, local-read, and direct-source candidates did not measurably improve the core suite; unconditional dirty-check removal was not semantics-preserving; the direct-callback recovery omits required lifecycle behavior. `useSignalValue` effect bridging, JSX subscriptions, public wrapper removal, and deepSignal Proxy changes remain deferred to Phase 6. No Phase 6 work began. The remaining observed/computed/batch gaps are not quantitatively explained by accepted Phase 5 requirements, so the performance blocker remains.

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
- `pnpm bench`, `pnpm bench:deep`, `pnpm bench:react`: completed during the prior Phase 5 review; this pass reran the final full `pnpm bench` and the focused attribution harness.
- `git diff --check`: passed after the implementation and checkpoint edits.

Intentional unsupported/unchanged behavior: Phase 3 nested-effect conformance cases #209/#210 remain unsupported; cross-runtime batch operations remain non-atomic. The effect-backed `useSignalValue`, generic JSX binding effect, deepSignal Proxy architecture, and `markWatched()` remain unchanged for Phase 5.

## Files changed

Runtime and interop: `src/core/base.ts`, `src/core/core-runtime.ts`, `src/core/deep-signal.ts`, `src/core/interop.ts`, `src/core/reactive-runtime.ts`; removed `src/core/low-level-runtime.ts`.

Tests and fixtures: `tests/consumer-smoke.mjs`, `tests/cross-copy-smoke.mjs`, `tests/cross-instance.test.tsx`, `tests/fixtures/consumer-vite/package.json`, `tests/fixtures/phase4-duplicate-entry.ts`, `tests/phase4-duplicate-smoke.mjs`, `tests/react-render-tracking.test.tsx`, `tests/reactive-runtime.test.ts`, `tests/use-signals-managed.test.tsx`; removed `tests/low-level-runtime.test.ts`.

Packaging, size, examples, and docs: `package.json`, `pnpm-lock.yaml`, `scripts/check-size.mjs`, `scripts/size-budget.json`, `examples/browser/server.mjs`, `examples/browser/vite.config.ts`, `examples/react-router/vite.config.ts`, `README.md`, `README.ja.md`, `docs/core-primitives.md`, `docs/core-primitives.ja.md`, `docs/design/packaging.md`, `docs/design/packaging.ja.md`, `docs/global-state.md`, `docs/global-state.ja.md`, and this checkpoint.

## Remaining work and next action

- **Correctness blocker:** none found; final focused and full correctness checks pass.
- **Architecture blocker:** the private runtime candidate has been several-fold slower since its first Phase 2 checkpoint. The Phase 5 migration did not create most of this gap, but it promoted that candidate to production.
- **Performance blocker:** Phase 5 observed, computed, and batch throughput still trails the Phase 4 public implementation by several-fold. Profiling identifies the tracked reaction/dependency and computed dirty-check paths, but current attribution does not show a semantics-preserving local optimization that closes the gap. Request a runtime performance architecture review before further optimization. Retain `markWatched()` until a separately scoped pruning change proves the render-to-commit window safe.
- **Future-version idea:** Phase 6 may consider direct private subscriptions for `useSignalValue`/JSX and later wrapper/pruning optimizations.

## Historical private-runtime comparison and profiling (2026-09-26)

This follow-up answers whether the Phase 5 migration introduced the main runtime cost. It does not: the Phase 2 low-level candidate already has the same low observed/computed/batch throughput order as Phases 3–5. The candidate architecture introduced the debt when it first appeared in Phase 2; Phase 5 made it the production path. The much faster Phase 4 public API was still using alien-signals' high-level implementation and is not evidence that the Phase 4 private candidate was fast.

Measurements used Windows x64, AMD Ryzen 7 PRO 6850U, Node v24.21.0, pnpm v11.24.0, alien-signals v3.2.1, tsdown v0.22.14, 40,000 operations, three warmups, nine samples, one runtime/case per process, and median ops/s. Historical source snapshots were bundled as test-only entries; no package export changed. The process-separated measurements reduce cross-runtime JIT interference, though the short runs still show noise, especially for unobserved writes.

| Runtime | Read | Unobserved write | Observed write | Computed update/read | Two-source computed batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| Phase 2 private candidate | 39.8M | 4.0M | 1.42M | 1.06M | 0.67M |
| Phase 3 private candidate | 46.8M | 4.0M | 1.32M | 1.17M | 0.65M |
| Phase 4 public API | 51.0M | 42.1M | 8.92M | 8.98M | 3.67M |
| Phase 4 private candidate | 28.0M | 4.32M | 1.19M | 0.97M | 0.42M |
| Phase 5 private runtime | 36.9M | 7.08M | 1.00M | 1.12M | 0.45M |
| Phase 5 public API | 34.9M | 7.00M | 1.00M | 1.01M | 0.34M |

The Phase 2 private candidate was already about 5.5–8.5 times slower on observed, computed, and batch cases than the Phase 4 public implementation. Phase 4 private and Phase 5 private are broadly similar; no Phase 4→5 private-runtime performance cliff appears in these measurements. This puts the production regression in context: Phase 5 migrated to an existing slower candidate rather than creating most of its cost.

CPU profiles ran as separate Node processes for observed source writes, computed write/read, and batch. In observed writes, `flush` and `runReaction` were the largest runtime self-time sites (about 401 ms and 281 ms in the sampled profile); `system.link` and `linkLocalDependency` were also visible (about 128 ms and 64 ms). Computed profiling concentrated in `ensureComputed`, `updateComputed`, `readComputedNormally`/`readComputedResult`, and `system.link`; batch profiling added substantial `checkDirty` and `recordReadableRead` time alongside `flush`, `runReaction`, and computed updates. These are profile attributions, not benchmark timings, and inclusive times overlap.

Heap sampling (1 KiB sampling interval, isolated private-runtime bundle) found runtime allocation stacks in `flush`/`runReaction`, `updateComputed`, `observedResultsEqual`, `promoteSpeculativeCache`, and dependency linking. The sample trees do not reliably identify allocated object classes, and sampled sizes are not exact allocation totals. This profile does not justify attributing the cost to Maps, Sets, arrays, or Results specifically.

V8 `--trace-opt --trace-deopt` showed hot helpers including `runReaction`, `flush`, `ensureComputed`, `updateComputed`, `readComputedResult`, `linkLocalDependency`, and alien `system.link` reaching Maglev/TurboFan. Some later deoptimized on generic property feedback or object-map changes. This diagnostic suggests shape/feedback sensitivity, but does not by itself explain the measured gap or justify a production change.

Runner experiments were attribution-only and reverted. Removing error/cleanup/afterRun handling while preserving graph tracking did not produce a repeatable improvement. Splitting tracked callback execution into a helper while preserving behavior was also neutral within run-to-run noise. Omitting two reaction-state resets did not produce a repeatable gain. The earlier direct-callback bypass recovers source-write throughput only by skipping required runner semantics, so it is not a valid fast path. No specialized reaction type or semantics-preserving source-effect fast path was retained; the evidence points to the combined tracked reaction/dependency path rather than one removable lifecycle clause.

Batch decomposition confirms that the combined benchmark is not measuring `batch()` alone. Phase 4 private versus Phase 5 private medians were about 18.2M versus 158M empty batches, 2.10M versus 2.75M two unobserved writes in a batch, 1.34M versus 1.19M one observed write in a batch, 0.99M versus 0.86M two observed sources to a direct effect, and 0.48M versus 0.44M for the full computed batch. The empty-batch case is tiny relative to propagation cases; adding a computed dependency costs substantially more in both private runtimes. `checkDirty` remains necessary for accepted semantics; no revision shortcut was retained.

No production optimization was retained, no profiler or benchmark harness was kept, and all temporary historical bundles and variants were removed. The core performance debt is present from the first private candidate checkpoint and remains several-fold behind the Phase 4 public baseline. The existing tracked fast-path attribution did not recover that gap while preserving semantics. This meets the escalation condition: request a runtime performance architecture review before deciding on internal redesign. Phase 6 remains deferred, and Phase 5 is not ready to freeze.

Follow-up validation after removing all temporary code: `pnpm test` passed (259 runtime tests; 221 transform tests, 3 skipped); `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:browser` (27/27), `pnpm size`, and `git diff --check` passed. Lint reported existing warnings only; the build reported TypeScript 7's experimental API warning.

**Historical status at this checkpoint: PHASE 5 RUNTIME PERFORMANCE ARCHITECTURE REVIEW REQUIRED**

## Architecture review follow-up (2026-09-26)

The architecture study is recorded in [`runtime-architecture-review.md`](./runtime-architecture-review.md), with isolated local measurements and test-only prototypes in `benchmarks/prototypes/`. Prototype A measured about 2.4–4.5x the current runtime's throughput in observed, computed, and batch cases, while remaining slower than alien-signals high-level. Its optional revision sidecar measured about 10–13% lower throughput in those cases; full React tracking and cross-runtime interop remain unmeasured. Prototype B was stopped early because high-level alien does not expose the last-consumer lifecycle needed for a clean foreign bridge, and its cached computed graph complicates speculative React reads.

This is evidence that runtime implementation shape contributes substantially to the performance debt, not a production cutover decision. Prototype A is the preferred candidate for a separately scoped continuation; production readiness remains inconclusive. Phase 6 was not started.

Prototype A now has a private real-React layer with local-only render correctness coverage. See the “Prototype A — real React layer” section in runtime-architecture-review.md for revision storage, watcher/cache design, benchmarks, and remaining interop/deepSignal gaps. This does not freeze Phase 5 or start the next milestone.

Prototype A's local-hardening follow-up, including shape-only measurements, corrected pending `peek()` behavior, reentrant-write parity, the expanded local semantics suite, and a temporary current-runtime graph-shape diagnostic, is recorded in [`runtime-architecture-review.md`](./runtime-architecture-review.md#prototype-a-local-hardening). The hardened local core retains a clear observed/computed/batch advantage over current Phase 5. Full React and interop parity remain open; Phase 5 is not frozen.
