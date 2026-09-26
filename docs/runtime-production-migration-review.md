# Runtime Production Migration Review

Date: 2026-09-26
Reviewed checkpoint: `906a0108b212dff2c84ed226c48063a6d096cc40` (`main`, equal to `origin/main`).
Scope: design and measurement only. No production source, public export, runtime behavior, or history was changed.

## Executive summary

Prototype A is a correctness-qualified candidate for a staged runtime cutover. The controlled local measurements show substantial gains in observed writes, computed updates, batching, dynamic dependencies, and effect creation/disposal. Raw reads and unobserved writes are slower in the private-core comparison; deep untracked reads and unrelated sibling updates are slightly slower. The React 19 samples show no material update regression in the tested component shapes, but the result is not a substitute for a browser application benchmark.

Proceed to a narrowly scoped M1 cutover behind the existing private `ReactiveRuntime` interface, with public wrappers and the shared deep Proxy engine preserved. M1 must first satisfy the brand, adapter, and tree-shaking gates below. Do not remove wrappers or combine this with an API redesign. Keep the old runtime as a temporary differential control during M1 and remove it after one successful validation/stabilization milestone.

The candidate is not a smaller codebase today: `reactive-runtime.ts` is 1,028 lines and Prototype A is 1,174 lines. The architectural gain is explicit local graph ownership and simpler hot paths; the cost is that RFSG would own and maintain more of the graph scheduler. The move is justified by measured common-path gains and existing parity coverage, provided the migration remains reversible and all M1 gates pass.

## Current production runtime inventory

Production construction is `core-runtime.ts` → `createReactiveRuntime()` → `alien-signals/system`. The package's public shallow `signal()` and `computed()` in `base.ts` wrap private runtime readables; public `effect`, `batch`, and `untracked` forward to the singleton. The supported dependency is `alien-signals` 3.2.1, and production imports its low-level `alien-signals/system` entry, not the high-level root API.

`deepSignal()` in `deep-signal.ts` lazily creates the shared `deep-signal-engine.ts` factory. Its adapter creates `SignalImpl` version sources and passes public `isSignal`, batching, active-subscriber state, and batch depth. This lazy boundary is why a signal-only consumer can omit the deep Proxy engine.

Runtime consumers found in `src/`:

| Consumer | Runtime contract used |
| --- | --- |
| `base.ts` public wrappers | `signal`, `computed`, `effect`, `batch`, `untracked` |
| `deep-signal.ts` adapter | `batch`, `hasActiveSubscriber`, `getBatchDepth`, runtime source liveness, public `isSignal` |
| React `use-signals.ts` and `hooks.ts` | render dependency versions/subscriptions, effects, computed and untracked reads, render/commit validation |
| JSX/runtime bindings | public signals and effects; direct host bindings subscribe through ordinary effect lifecycle |
| interop protocol | `ReadableInteropV1`, graph/render collectors, revisions, shared speculative scope and duplicate-copy context |
| transform runtime | managed render boundary (`useManagedSignals`) from `/runtime`; transform implementation itself is not a runtime-core consumer |
| tests, consumer fixtures, duplicate-copy fixtures | public behavior, runtime-private render/liveness contract, duplicate package interop |

The runtime-level `subscribe()` method exists on the current private interface but has no production call site outside the runtime/test surface; the readables themselves provide `subscribeRender()` to the React layer. Preserve the private interface for M1 compatibility, then remove an unused method only in a separate cleanup after consumer search and tests.

## Prototype A inventory and architecture delta

Prototype A currently lives in `benchmarks/prototypes/lean-runtime.ts`; its factory returns signal/computed/effect/batch/untracked plus speculative evaluation and deepSignal diagnostics. It is not exported from a package entry. It uses `alien-signals/system` for low-level flags/links but owns its local graph algorithm and scheduler.

| Difference | Assessment |
| --- | --- |
| Lean local source/computed/effect nodes with direct link tracking | Architectural improvement for the local path: ownership and transitions are explicit, without adapting every local operation through the generalized Alien node behavior. More RFSG scheduler code must be maintained. |
| Graph-native local watchers and reused queue | Architectural improvement: local graph subscriptions share propagation and lifecycle rules rather than maintaining a second observer graph. |
| Inline revisions | Useful implementation choice for render race checks; preserve the semantics, not necessarily the storage field. |
| Separate speculative dependency/cache state | Architectural improvement for abandoned renders and promotion policy; deliberately adds state and must remain covered. |
| `ExternalNode`, liveness, cold foreign pulls | Required interop architecture, not just an optimization. Avoid subscribing cold foreign computed nodes and release subscriptions as dependencies change. |
| Deep factory integration | Correctness study only. It currently constructs the shared engine as part of each Prototype A runtime and exposes metadata inspection; this must not be copied literally into production because it defeats the current lazy tree-shaking boundary. |
| Shared speculative scope handling | Required cross-copy safety; V1 context and exact save/restore are already accepted. Keep that contract. |

## Semantic parity matrix

`Equivalent` means existing production and Prototype A tests cover the same public result/lifecycle. `Intentionally different` identifies a private prototype choice or a known compatibility adaptation required at cutover. Every row is classified; no public behavior is proposed for redefinition.

| Behavior | Classification | Evidence / cutover note |
| --- | --- | --- |
| signal reads/writes, pending writes | Equivalent | core and prototype runtime suites |
| computed lazy read and cache | Equivalent | core/prototype tests |
| effect synchronous initial run and rerun | Equivalent | effect tests; initial speculative-scope regression added at the checkpoint |
| local batch | Equivalent | core/prototype tests |
| untracked | Equivalent | core/prototype tests |
| `peek()` | Equivalent | source/computed peek and batching tests |
| `Object.is` equality (`NaN`, `+0/-0`) | Equivalent | core and cross-copy tests |
| body/cleanup error containment and reporting | Equivalent | error suites; preserve reporter message/cause behavior |
| computed error cache, repeat errors, recovery | Equivalent | computed error suites |
| cleanup ordering and disposal | Equivalent | cleanup/lifecycle tests |
| self-disposal | Equivalent | production and Prototype A lifecycle tests |
| dynamic dependencies and pruning | Equivalent | runtime/deep tests |
| flat nested effects | Equivalent | nested ownership tests; returned disposer remains opt-in cleanup ownership |
| local computed cycles and recovery | Equivalent | runtime tests |
| React render tracking | Equivalent | production and Prototype A real-React suites |
| first-observed revisions | Equivalent | render race/change-and-revert tests |
| render/commit race | Equivalent | production and Prototype A React tests |
| change-and-revert notification | Equivalent | source revision and React tests |
| managed tracking | Equivalent | managed boundary/transform tests |
| StrictMode | Equivalent | React suites |
| Suspense/abandoned render | Equivalent | React suites |
| SSR | Equivalent | SSR suite and Prototype A coverage |
| computed equality suppression | Equivalent | core, React, and interop tests |
| identity-unstable computed freshness | Equivalent | speculative and foreign computed tests |
| speculative cache promotion | Equivalent | promotion, abandon, and deep speculative tests |
| foreign interop | Equivalent | V1 protocol and multiple runtime suites |
| foreign equality and error behavior | Equivalent | cross-runtime tests |
| foreign liveness and cold foreign computed | Equivalent | transition/liveness hardening tests |
| cross-runtime computed cycles | Equivalent | Prototype A interop and 3-copy smoke |
| deep property/existence/iteration tracking | Equivalent | same shared Proxy engine and production/prototype tests |
| deep arrays and metadata pruning | Equivalent | shared Proxy and deep runtime suites |
| foreign deep tracking | Equivalent | interop tests and duplicate smoke |
| speculative deep behavior | Equivalent | epoch, promotion, and durable-callback tests |
| duplicate-package behavior | Equivalent | Phase 4 public smoke plus 3-copy Prototype A smoke |
| public `isSignal()` brand semantics | Intentionally different | Prototype adapter currently treats any V1 readable as a signal. M1 must pass the real RFSG brand predicate; never widen public `isSignal()`. |
| cross-runtime batch atomicity | Equivalent | Neither design guarantees shared cross-runtime atomic batching. Keep this explicit contract; do not add a global scheduler. |
| `Object.keys()` descriptor/property reads | Equivalent | The shared Proxy descriptor trap also tracks candidate property versions during `Object.keys()`, while `Reflect.ownKeys()` is iteration-only. Preserve through cutover; do not change Proxy semantics here. |

Prototype A's remaining differences are private adapter/interface details, not a demonstrated public semantic gap: branding, `hasSubscribers`, and runtime factory separation are listed as M1 gates. Production and Prototype A public suites, transforms, consumer builds, and duplicate-package tests must both remain green through the transition.

## `Object.keys()`, signal brand, and wrapper decisions

**Object.keys: PRESERVE FOR CUTOVER.** The Proxy behavior is current production behavior: own-key iteration is collected and `getOwnPropertyDescriptor` may collect property versions. `Reflect.ownKeys()` remains iteration-only. There is no migration-only correctness reason to alter it. Any desired semantic change is a separate future task.

**Signal brand: BEFORE CUTOVER.** Extract the package-wide `SIGNAL_BRAND` constant (and only the mechanical brand contract helper if useful) into a tiny independent `signal-brand.ts` in an M0 preparation. Re-export from `base.ts` if needed to avoid churn. This removes the deep engine's dependency on the production wrapper module without changing the symbol or accepted versions. The M1 deep adapter must receive/pass the existing public `isSignal` semantics. A `ReadableInteropV1` carrier is not automatically a public signal.

**KEEP WRAPPERS FOR FIRST CUTOVER.** Replace the private runtime under `SignalImpl` and the computed wrapper first. This preserves identity, brand, `isSignal`, deep adapter behavior, and most public code. The experimental `lean-wrapped` benchmark uses a minimal forwarding object, not the exact branded/private-field class and interop setup; it indicates wrapper overhead can matter (read medians 20.7M ops/s versus 40.5M private candidate and 51.8M current public), but does not justify deleting wrappers. Cutover must retain them and report the real post-cutover result before considering wrapper work.

## Controlled performance review

Machine: Windows 11 (`win32`), x64, AMD Ryzen 7 PRO 6850U with Radeon Graphics; Node v24.21.0; alien-signals 3.2.1; React 19.2.8; same checkpoint and dependency install. Core/deep cases used an isolated Node process per runtime/case/round, 2 warmups, 7 timed samples per process, and 3 independent process rounds. Runtime order alternated. Iterations were adjusted by case: read 5M; unobserved write 1M; observed/computed 300k; batch/dynamic 100k; create/dispose 300k; cold computed 100k; hot computed 1M; deep cases 50k. React cases used an isolated process per variant, 10 deterministic sibling rows, 100 updates, 2 warmups, and 7 samples. Size used the repository's existing production Vite/Rollup harness.

Reproduction from PowerShell at this checkpoint:

```powershell
pnpm build
pnpm build:prototype-a
$env:FINAL_BENCH_ROUNDS = '3'
$env:BENCH_SAMPLES = '7'
$env:BENCH_WARMUPS = '2'
& .\benchmarks\prototypes\final-review-run.ps1
foreach ($variant in @('signals','lean','signals-managed','lean-managed','unrelated-current','unrelated-lean','equality-current','equality-lean','many-current','many-lean')) {
  $env:BENCH_VARIANT = $variant
  $env:BENCH_ROWS = '10'
  $env:BENCH_UPDATES = '100'
  $env:BENCH_WARMUPS = '2'
  $env:BENCH_SAMPLES = '7'
  $env:BENCH_OUTPUT = 'benchmarks/prototypes/results-final-2026-09-26.jsonl'
  node --expose-gc benchmarks/react-render.mjs
}
```

The core/deep runner resets the JSONL file and records its environment plus each isolated sample. React variants append their records afterward. The five foreign interop rows are Prototype A characterization only, obtained with `benchmarks/prototypes/bench.mjs` cases `foreignEffect`, `foreignComputed`, `foreignEffectComputed`, `foreignComputedComputed`, and `foreignDynamic` at 10,000 iterations, `BENCH_WARMUPS=2`, and `BENCH_SAMPLES=7`; they are not a controlled comparison against a current multi-runtime baseline.

Values below are the median of the three per-process medians; parentheses show the min–max of those three process medians. Throughput is M operations/s. The purpose is a controlled local comparison, not a cross-machine promise. The per-sample p25–p75 and full JSONL are saved in `benchmarks/prototypes/results-final-2026-09-26.jsonl`.

### Core graph cases

| Case | Current public | Prototype A private | A/current | Notes |
| --- | ---: | ---: | ---: | --- |
| signal read | 51.79 (49.86–57.11) | 40.49 (36.90–54.36) | 0.78× | candidate raw read is slower; broad ranges overlap |
| unobserved write | 8.52 (7.58–9.26) | 6.91 (5.30–9.53) | 0.81× | mixed/noisy, no claimed win |
| observed write | 1.25 (1.09–1.27) | 4.82 (3.77–4.89) | 3.87× | material local graph gain |
| computed update/read | 1.37 (1.11–1.38) | 2.24 (2.19–2.26) | 1.64× | consistent gain in these runs |
| two observed writes in batch | 0.44 (0.32–0.51) | 1.61 (1.61–2.14) | 3.63× | material local graph gain |
| dynamic dependency switch | 0.47 (0.40–0.49) | 1.60 (1.14–1.71) | 3.36× | same branch correctness asserted |
| effect create/dispose | 0.34 (0.33–0.38) | 8.66 (5.45–8.87) | 25.43× | unusually large; recheck after M1 before generalizing |
| cold computed create/read | 0.14 (0.13–0.17) | 0.23 (0.22–0.24) | 1.70× | setup path |
| hot computed read | 12.38 (10.51–12.87) | 45.10 (33.77–47.83) | 3.64× | cached read path |

The simple `lean-wrapped` forwarding approximation measured 20.69M read, 2.52M observed, 2.33M computed, and 1.18M batch ops/s at the median. It preserves the value/peek wrapper access in the loop, but omits exact public branding, private-field layout, and wrapper metadata. Treat wrapper attribution as directional only. It still retained gains in the tracked cases but did not preserve the raw-read advantage.

### React 19 cases

The actual React harness uses React 19 and the production `useSignalTracking`/`useManagedSignals` implementations for both sides. The Prototype A hooks are included in the same built module as its runtime, so the candidate exercises its module-local render path. Update values below are median ms (p25–p75); mount is separately timed from update work.

| Scenario | Current production | Prototype A | Result |
| --- | ---: | ---: | --- |
| initial mount, unmanaged | 3.935 (3.818–4.219) | 4.011 (3.823–4.033) | effectively equal |
| 100 subscribed counter updates, unmanaged | 24.401 (21.922–24.691) | 22.105 (20.720–24.998) | modest candidate gain; spreads overlap |
| initial mount, managed | 4.684 (4.304–4.810) | 4.095 (3.766–4.354) | no observed candidate penalty |
| 100 subscribed counter updates, managed | 21.555 (21.036–22.882) | 19.411 (17.885–20.347) | candidate modestly faster |
| 100 unrelated updates, unmanaged | 0.106 (0.080–0.358) | 0.049 (0.048–0.189) | component rendered once in both; timer dominated/no useful winner |
| 100 computed-equality updates | 3.983 (3.904–4.798) | 4.053 (3.873–4.369) | exactly 11 renders in both; effectively equal |
| 100 update rounds across 10 independent subscribers | 95.170 (90.457–108.400) | 64.045 (57.806–75.636) | candidate faster in this sample; each leaf rendered exactly 101 times |

There is no broad React throughput regression in these small-tree Node/jsdom samples. These samples do not include layout/paint and do not establish browser/application-level latency; use the browser harness as corroboration during M1. Existing browser tests remain correctness tests, not a throughput comparator.

### DeepSignal and foreign interop

Both deep runtimes use the same Proxy engine, so these cases isolate runtime adapter/graph work. Median M ops/s (min–max of process medians):

| Case | Current | Prototype A | A/current |
| --- | ---: | ---: | ---: |
| untracked nested read | 1.73 (1.05–1.80) | 1.63 (1.31–1.64) | 0.94× |
| tracked nested update | 0.30 (0.17–0.31) | 0.42 (0.33–0.51) | 1.41× |
| unrelated sibling update | 1.22 (1.02–1.26) | 0.90 (0.88–0.95) | 0.73× |
| deep computed update | 0.22 (0.20–0.23) | 0.36 (0.31–0.45) | 1.63× |
| tracked array index | 0.26 (0.25–0.27) | 0.32 (0.27–0.35) | 1.24× |

This is mixed and does not show a serious deep regression. Current shared-engine semantics and metadata pruning remain unchanged. Prototype A foreign cases were measured at 10k operations, 2 warmups and 7 samples: A effect from B source 1.12M ops/s; A computed from B source 2.60M; A effect from B computed 0.71M; A computed from B computed 1.05M; dynamic B/C branch 0.38M. There is no same-harness current-runtime comparison for multiple production runtime instances, so these numbers are characterization only. Existing cross-copy tests cover correctness, release, and bounded cycles; M1 should add a comparable foreign baseline only if the first run shows an application-relevant regression.

### Allocation and node shape

This is source inspection, not heap-profile evidence. Prototype A local source reads return before interop publication/collector allocation; ordinary local writes use the reused queue. Maps/sets remain on render collection, genuine speculative reads, foreign subscriptions, and liveness transitions. Computed evaluation uses temporary result records in some paths. The current production runtime uses a reusable effect queue too, plus Alien graph nodes, local protocol maps, speculative maps/sets, and result unions. No per-read foreign allocation was found on Prototype A's pure-local fast path. Do not start GC tuning from these observations; use a heap profile only if M1 profiling exposes a real issue.

Prototype A source, computed, effect, render watcher, and `ExternalNode` fields are initialized together and use direct graph links; no obvious repeated hot-path property deletion or late-shape field insertion was found. Production source/computed/reaction nodes inherit Alien graph fields and add RFSG revision/protocol/lifecycle bookkeeping; production also uses an internal external-node adapter. Prototype A's node model is more explicit, but its liveness and speculative fields are not simpler in total. Preserve stable fields and avoid exposing graph nodes through the private interface.

## Bundle size and tree-shaking

`pnpm size` passed on the current production build. Gzip / Brotli / raw sizes from the repository harness:

| Import scenario | gzip | Brotli | raw |
| --- | ---: | ---: | ---: |
| signal-only | 5.60 kB | 5.01 kB | 20.33 kB |
| core | 5.69 kB | 5.08 kB | 20.63 kB |
| core + hooks | 6.95 kB | 6.21 kB | 24.64 kB |
| deep | 9.88 kB | 8.83 kB | 37.75 kB |
| full index | 11.08 kB | 9.90 kB | 42.08 kB |
| JSX runtime | 8.48 kB | 7.60 kB | 28.71 kB |
| utils | 6.79 kB | 6.07 kB | 24.06 kB |

The size harness's structural marker checks prove the current deep engine is absent from signal-only/core bundles and present in the deep bundle. The unminified Prototype A study entry is 71.89 kB raw / 16.76 kB gzip and contains React tracking, the deep engine, and metadata diagnostics; it is not a production-like tree-shaken comparison. It confirms that transplanting the current Prototype A factory literally would put deep code on the runtime path. M1 must instead keep the runtime core free of a static deep-engine dependency and preserve the current lazy `deep-signal.ts` adapter boundary. Then rerun every size/absence check and compare the built artifacts. Main/runtime/JSX/utils/deep entry sizes after cutover are a completion gate, not assumed unchanged.

`alien-signals` remains a production dependency (not a peer dependency); keep only `alien-signals/system` in production runtime code. Do not reintroduce the high-level Alien root API.

## M0 + M1 implementation result (2026-09-27)

Implementation started from `848cc431c661e62163e100e834a0b229fc470554`, equal to `origin/main` at start. M0 mechanically extracted the unchanged `Symbol.for("react-fine-grained-signals.signal")` identity to `src/core/signal-brand.ts`; brand version acceptance, `isSignal()`, root exports, and deep Proxy semantics are unchanged. M1 replaced the internals of the existing private `ReactiveRuntime` with the lean graph runtime while retaining public wrappers, package exports, React tracking, V1 interop, the single shared deep engine, and its lazy adapter boundary. The production runtime has no static deep-engine import and no prototype-only factory/diagnostic surface.

M0 files: `src/core/signal-brand.ts`, `src/core/base.ts`, `src/core/deep-signal-engine.ts`. M1 production files: `src/core/reactive-runtime.ts`. M1 test/benchmark files: `tests/reactive-runtime.test.ts`, `tests/fixtures/phase4-duplicate-entry.ts`, `tests/phase4-duplicate-smoke.mjs`, `benchmarks/prototypes/final-review-run.ps1`, and `benchmarks/react-render.mjs`; raw results are in the adjacent `results-m1-2026-09-27.jsonl`, `results-m1-old-control-2026-09-27.jsonl`, `results-m1-old-react-control-2026-09-27.jsonl`, and `results-m1-react-recheck-2026-09-27.jsonl` files. The historical 2026-09-26 review above is otherwise unchanged.

The existing runtime suite covers local `signal`, `computed`, `effect`, batching, cleanup and error containment, cycles/recovery, render revisions, speculative cache/promotion, deep tracking and pruning, and interop V1. Two promoted regressions explicitly check non-function effect return values and dynamic foreign liveness/release. The public three-bundle smoke passes cross-copy source/computed behavior, equality, dynamic dependencies, release, React interop, fine-grained deep property updates, sibling isolation, and root replacement. The retained Prototype A three-bundle smoke also passes as a differential. `SignalImpl`, `computed`, `registerSignal`, and `isSignal` remain in place, and no wrapper protocol or root export changed. Cross-runtime cycle containment and bounded feedback remain covered by duplicate and runtime tests. The shared deep engine and adapter are unchanged apart from the M0 brand import.

The `ReactiveRuntime` contract maps directly to local graph `signal`, `computed`, `effect`, `batch`, and `untracked` operations. `subscribe()` uses a private graph-native render watcher rather than public `effect()`. `hasSubscribers()` checks current local graph/render liveness for owned runtime readables; foreign dependencies are represented by local `ExternalNode`s, subscribe while a downstream path is live, and release as that path is pruned/disposed. Cold foreign computed pulls reevaluate without persistent subscription. The local hot path links runtime nodes directly; V1 adapter lookups and external nodes are limited to actual foreign boundaries. Scheduler queueing, `Object.is` equality, synchronous effects, flat nested ownership, cleanup ordering, and local batch depth remain runtime-local. A same-day old-production control was temporarily built for comparison only and then removed from the production source; there is one shipped runtime.

`pnpm size` passes all configured budgets and structural tree-shaking assertions. Gzip deltas from the 2026-09-26 baseline are: signal-only 5.60→5.91 kB (+0.31), core 5.69→6.00 (+0.31), core+hooks 6.95→7.27 (+0.32), deep 9.88→10.27 (+0.39), full index 11.08→11.46 (+0.38), JSX 8.48→8.80 (+0.32), and utils 6.79→7.10 (+0.31). The deep engine is absent from signal-only/core output and present in deep output.

The controlled M1/old-runtime comparisons are three isolated process rounds with seven samples each on the same Windows 11, Ryzen 7 PRO 6850U, Node 24.21.0, React 19.2.8 setup. They are directional because process medians varied materially. In M ops/s, old→M1 medians were: raw read 22.44→24.05; unobserved write 6.62→6.03; observed write 0.72→3.21; computed update 0.17→0.28; batch 0.24→1.01; dynamic dependency switch 0.34→0.70; effect create/dispose 0.24→4.53; cold computed 0.08→0.13; hot computed 7.06→13.50. Tracked deep update was 0.14→0.25, sibling update 0.91→0.69, tracked array index 0.16→0.16, and untracked nested read 1.45→1.16. The local graph gains remain measurable in this run; deep untracked reads are somewhat slower and the tracked array case is flat.

React initial runs were visibly affected by host load, so a second M1 pass was recorded before evaluation. Against the same-day old production controls, M1 unmanaged update median was 18.787 ms vs 20.127 ms, managed 15.596 vs 21.531, unrelated update 0.077 vs 0.068, computed-equality 3.193 vs 3.186, and 10-subscriber rounds 72.231 vs 91.510. Render counts matched the expected contract in every case (including exactly 11 equality renders and 1,010 independent leaf renders). This recheck shows no broad React regression; initial mount medians were 3.539 ms unmanaged and 3.645 ms managed. Browser correctness passed 27/27; the browser suite is not a throughput benchmark. Foreign multi-runtime performance remains characterization-only rather than a controlled production comparison.

Final validation passed: `pnpm test` (355 runtime, 221 transform; 3 skipped), `pnpm typecheck`, `pnpm lint` (warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:prototype-a-duplicate`, `pnpm test:browser` (27/27), `pnpm size`, and `git diff --check`. The transform tests and browser compiler/SSR paths pass without transform or export changes. Remaining follow-up is to gather less noisy deep-read and foreign-runtime measurements during stabilization; neither is a correctness or architecture blocker. M2 stabilization is the next milestone and was not started here.

## Validation status

On the unchanged production checkpoint, these repository scripts passed during this review: `pnpm test` (runtime and transform suites), `pnpm typecheck`, `pnpm lint` (pre-existing warnings only), `pnpm build`, `pnpm test:consumer`, `pnpm test:phase4-duplicate`, `pnpm test:prototype-a-duplicate`, `pnpm test:browser` (27/27), and `pnpm size`. The benchmark runner completed 96 isolated core/deep samples plus 10 React variant records and five Prototype A foreign characterization rows. `git diff --check` passes. No files under `src/`, package exports, or production runtime implementation were changed in this review.

## Runtime-private interface and adapter gaps

Keep `ReactiveRuntime` as the clean private boundary: `signal`, `computed`, `effect`, `batch`, `untracked`, `subscribe`, `hasActiveSubscriber`, `getBatchDepth`, `hasSubscribers`. Readables continue to provide `value`, `peek`, `getRenderVersion`, and `subscribeRender`, and V1 interop remains on wrappers.

Prototype A already has matching readables, `signal/computed/effect/batch/untracked`, V1 protocol, revisions, and deep factory callbacks internally. Its public-private `LeanRuntime` object does not currently implement runtime-level `subscribe`, `hasActiveSubscriber`, `getBatchDepth`, or `hasSubscribers`; its deep factory captures those from internal closures instead. Add the smallest private adapter methods during M1: `subscribe` delegates to that runtime's render/node subscription; liveness checks the exact local graph consumer state (including render watcher state); active-subscriber and batch-depth methods return the runtime-local values. Do not expose graph nodes or approximate `hasSubscribers()` as permanently true.

`RenderDependency` maps directly to candidate `getRenderVersion()` / `subscribeRender()`. Keep the existing `RenderStore`, `subscribeRender`, and `getRenderVersion` behavior behind the adapter so React code does not depend on the new graph shape. No unplugin/plugin transform architecture change is required.

## Deep adapter migration

Use the same extracted `deep-signal-engine.ts` without changing Proxy traps, property/existence/iteration versioning, Map/Set views, array mutators, normalization, validation, raw mutation rules, or pruning. Recreate the factory lazily from the existing `deep-signal.ts` boundary. Its adapter must use the new runtime for root and per-key signal sources, batch, `hasActiveSubscriber`, batch depth, and exact subscriber/liveness lookup. Preserve factory-local caches, root V1 forwarding, per-key version sources, `markWatched`, speculative deep epoch behavior, and duplicate-copy context. Pass package `isSignal()` so the engine recognizes only brand-accepted RFSG public values.

## Duplicate-package and test migration

During M1, make the public `tests/phase4-duplicate-smoke.mjs` authoritative and extend it to cover the behaviors currently unique to Prototype A's 3-copy fixture: fine-grained foreign deep update, root replacement, release after disposal, computed equality, React foreign tracking, and bounded cross-runtime cycles. Keep the 3-copy prototype fixture only as a temporary differential smoke; delete it in M2 once those cases pass through built public bundles.

Test disposition:

| Test group | Migration action |
| --- | --- |
| Local runtime semantics in `tests/prototypes/lean-runtime.test.ts` | Promote missing contracts to production runtime suite; use one parameterized adapter suite only if it stays small |
| React/render and managed tests | Promote contract gaps; production `react-render-tracking` and `use-signals-managed` remain authoritative |
| Interop/liveness/cold-pull/cycle tests | Move unique behavior to production runtime and public duplicate smoke |
| deepSignal prototype tests | Keep shared-engine tests once; promote only runtime-adapter-specific cases |
| Prototype duplicate fixture | Temporary M1 differential control; delete in M2 |
| Prototype benchmarks/results | Keep architecture-study harness/data; never expose its entry through package exports |

Do not build a generic multi-runtime test framework. A small factory-based semantic suite is appropriate only where it removes substantial test duplication without obscuring the public contract.

## Error, scheduler, and React lifecycle review

Both implementations are tested to contain effect-body and cleanup failures, preserve computed error caching/recovery, and avoid propagating reporter failures. During cutover compare actual reported messages/cause and repeated errors rather than relying on similar implementation. Preserve synchronous effects, local batch behavior, reentrant writes, self-disposal, cleanup order, flat nested effect ownership, and queue containment. Prototype A's queue is simpler and shared with render watchers; this is a private implementation difference, not a reason to alter timing semantics.

Cross-runtime batches remain synchronous but non-atomic. No shared scheduler/global graph is needed or permitted. Keep `useSignalTracking`, managed transformed boundaries, `"use no memo"`, compiler bailout rules, StrictMode/Suspense/SSR tests, and transform tests. RSC is not newly promised by this migration.

## Cutover architecture and rollback

Preferred first boundary:

```text
src/core/reactive-runtime.ts -> lean local graph behind existing ReactiveRuntime
src/core/core-runtime.ts    -> same singleton construction point
src/core/base.ts            -> retain SignalImpl/computed wrappers and public semantics
src/core/deep-signal.ts     -> retain lazy adapter, route through private runtime interface
src/core/deep-signal-engine.ts -> unchanged shared Proxy semantics
src/core/interop.ts         -> retain V1 context/protocol
src/core/render-tracking.ts -> retain public React-facing dependency contract
src/react/*                 -> unchanged unless adapter wiring proves necessary
```

Alternative file structures that keep two production runtimes permanently are rejected. A temporary old runtime is allowed only in M1 tests/benchmarks. M2 deletes it after one full validation milestone. Wrapper removal is M3 only if post-cutover bundle/throughput evidence shows enough benefit to justify its separate identity/brand/deep-adapter risk.

Rollback boundary: M1 should be one focused runtime implementation replacement with no package export, public wrapper, Proxy, transform, or scheduler contract changes. If a semantic/size/performance gate fails, revert the single M1 implementation change; retain M0's mechanical brand-module extraction only if it is independently behavior-preserving and tested.

## Milestone plan

| Milestone | Goal and likely files | Required validation | Rollback boundary / completion gate |
| --- | --- | --- | --- |
| M0 — mechanical preparation | Extract `src/core/signal-brand.ts`; update `base.ts` and `deep-signal-engine.ts` imports only; add a small `ReactiveRuntime` conformance/differential entry if needed | brand/isSignal/deepSignal tests, typecheck, lint, build, `pnpm size`, exports unchanged | revert extraction alone if symbol/brand bytes or tree-shaking change; completion requires no semantic diff and clean build |
| M1 — runtime cutover | Replace `reactive-runtime.ts`; adapt exact private methods in `core-runtime.ts` / lazy `deep-signal.ts`; keep `base.ts`, hooks, interop, transforms, and Proxy engine behavior stable | full test/typecheck/lint/build/consumer/duplicate/browser/size gates; differential error/scheduler checks; controlled core/React/deep/interop run | revert only runtime replacement if any gate fails; success requires all public semantic, duplicate, size and throughput gates |
| M2 — stabilize and consolidate | Delete old runtime control and redundant prototype tests/duplicate smoke; promote unique tests into `tests/reactive-runtime`, React/deep suites and authoritative public duplicate smoke | full repository validation plus exact export and generated bundle inspection | deletion can be reverted without changing M1 behavior; finish after one clean release-like validation cycle |
| M3 — optional wrapper/internal simplification | Only if measured after M1; likely `base.ts`, `deep-signal.ts`, tests and size/bench scripts | identity/brand/deep/interop suite, consumer bundles, React and size comparisons | keep separate from M1; do nothing if benefit is not clear |

Old-runtime timing: retain as a temporary M1 benchmark/differential control, then delete in M2 after one successful validation milestone. Do not retain two production runtimes indefinitely.

## Likely file impact

Likely changes during M0/M1 are `src/core/reactive-runtime.ts`, `src/core/core-runtime.ts`, the mechanical `src/core/signal-brand.ts` / `src/core/base.ts` import, `src/core/deep-signal.ts` adapter, and focused tests/benchmarks. `src/core/deep-signal-engine.ts` Proxy behavior, `src/core/interop.ts` V1 contract, `src/core/render-tracking.ts`, `src/react/*`, JSX runtime, unplugin code, public exports, and package metadata should remain untouched unless a test demonstrates a concrete adapter need. Any extra file should be justified by that interface, not a broad restructure.

## Go/no-go gate and recommendation

Proceed to the runtime cutover milestone, but treat M0/M1 gates as mandatory. Correctness is sufficiently covered for a reversible cutover; observed/computed/batch gains are material, React updates are neutral-to-better in the tested cases, and deep results are mixed without a serious regression. This is not authorization to combine wrapper removal or deep Proxy changes.

Before declaring M1 complete, require: exact public `isSignal` brand behavior; all private runtime methods including exact subscriber liveness; lazy deep-engine tree-shaking preserved; public duplicate smoke authoritative; no public export/semantics change; full validation; and a repeated performance run on the cutover build. If the cutover build causes the deep marker to appear in signal-only/core bundles, causes a material managed React regression, or loses the tracked graph/deep gains, stop and roll back M1 for reassessment. The cross-runtime benchmark values above are characterization only; add a production baseline if the cutover run exposes a concrete interop concern.

Do not start Phase 6, remove wrappers, or change public documentation until the actual runtime cutover is separately implemented and validated.
