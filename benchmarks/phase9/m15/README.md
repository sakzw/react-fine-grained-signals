# M1.5 bare Alien-derived screening prototype

## M1.5.2 production-shaped candidate

The M1.5.2 production port, package/bundle and allocation reviews, 24-pair focused audits, final eight-round matrix, and architecture decision are documented in [m1.5.2.md](../../../development/phases/phase9/m1.5.2.md). The final authoritative artifacts are in [`results/m1.5.2-2026-09-28-production-alien-derived-final/`](../results/m1.5.2-2026-09-28-production-alien-derived-final/). These measurements use the actual built production runtime. The direction is accepted, with a narrow M1.5.x computed/effect hot-path follow-up; this does not start M2.

## M1.5.1 adapter architecture rebase

The benchmark-only M1.5.1 candidate keeps one Alien-derived graph core and places lexical V2 execution ownership, render/speculative behavior, cross-copy readable bridging, React hooks, and DeepSignal adaptation in separate modules. The graph core is not copied for render mode. Its V2 owner is shared across independent candidate copies; the per-readable bridge remains V1. No compatibility promise for a mixed v0.1.1/new-development graph protocol was found in the v0.1.1 tag or repository docs/tests.

Before the full matrix, 24 paired fresh-process rounds showed integration medians against M1.5 core of 1.11x source/read, 1.14x source/write-read, 1.22x observed effect writes, 1.22x dynamic effects, 1.18x/1.13x fanout 16/64, and 1.33x/1.40x computed dirty-read/equality. This cleared the exploratory gate: effect cost no longer resembles the prior ~1.93x render-integrated prototype. The full frozen-count, eight-round M1.5.1 matrix then completed with 3 warmups, 7 samples, and 3 allocation rounds. It is an architecture comparison, not an M1b release result.

The run manifest, JSONL samples, allocation data, and failures are in [`results/m151-owner-2026-09-28/`](results/m151-owner-2026-09-28/). The paired-round summary is [`owner-matrix-summary.json`](owner-matrix-summary.json), and the architecture, React screens, selected ratios, validation, and migration recommendation are in [m1.5.1.md](../../../development/phases/phase9/m1.5.1.md). The candidate is not production-selected; source/read and DeepSignal allocation remain review items.

This directory is a disposable benchmark-only experiment. Nothing here is imported by `src/` or package exports.

`alien-derived-runtime.mjs` is a small high-level port based on Alien Signals 3.2.1 commit `8734d386d925025d0e99419bd9161c17b112c5ee`. It imports only `alien-signals/system`; signal/computed expose RFSG-style `.value` and `.peek`, alongside `effect`, `batch`, and `untracked`. It retains Alien's pending/current values, push/pull links, linked-list dependency cleanup, high-level effect notification queue ordering, lazy computed evaluation, and child-effect disposal before parent reruns. The extra node `kind` discriminator and accessor wrappers are experiment implementation details. Additional files in this directory layer branding, `Object.is`, error handling, render tracking, cross-copy interop, and DeepSignal for architecture experiments; none are imported by production `src/` or package exports.

This is only a bare baseline. It does not implement RFSG render tracking, speculative reads, interop, deepSignal, Object.is equality, or RFSG error and teardown guarantees. It is not suitable for production use. The full upstream MIT license is included in `ALIEN-SIGNALS-LICENSE.txt`; derived files carry the source URL and pinned commit in their headers.

Run the Stage 2 behavior checks and focused screening from the repository root:

```sh
node benchmarks/phase9/m15/check.mjs
node benchmarks/phase9/m15/screen.mjs > benchmarks/phase9/m15/screen-results.json
node benchmarks/phase9/m15/summarize-screen.mjs
```

The early screen uses the frozen M1b counts for `source/read@1` and `source/write-read@1`, eight four-runtime order cycles, three warmups, seven samples per runtime/process, and a fresh Node process for each runtime/case/round. It is only a blocker screen. It is not the authoritative M1b run, a full M1.5 matrix, or a performance conclusion. `screen-results-raw.json` stores the raw per-process sample durations in JSON; the summary helper prints medians and paired M1.5/v0.1.1 ratios for inspection.

The structural follow-up is in `core-screen.mjs` / `core-screen-worker.mjs`. It screens all 22 common Alien/RFSG-compatible case-size workloads from `m1b-iterations.json`, excluding allocation, diagnostic, deep-signal, and React cases. It preflights every runtime/case mapping before timing, then runs four serial fresh-process rounds with three warmups and seven samples, checkpointing every round to `core-screen-results.json`. `notApplicable` is recorded in the JSON; this selected set had none.

`alien-derived-runtime-objectis.mjs` is an isolated minimal equality variant of the inline class candidate. Only signal pending/current equality and computed equality use `Object.is`; `objectis-check.mjs` covers NaN stability, signed-zero changes, and computed propagation. `objectis-screen.mjs` compares it to the original inline candidate on source write/read and computed equality suppression, using the exact frozen iteration counts and fresh processes; raw samples are in `objectis-screen-results.json`. Neither variant is production-integrated.

## Single-object public API/brand candidate screen

The first two-class public wrapper plus inner signal was rejected after the initial source/create screen showed roughly an order-of-magnitude regression; it was not measured further after that result. The next screen uses one class instance as the public signal/computed object:

1. `weakset-brand`: constructor registers the instance in a local `WeakSet` and stamps the immutable brand. `isSignal` checks the local set first and falls back to brand + `.peek()` for foreign package copies.
2. `helper-brand`: constructor calls a small shared helper that stamps only the immutable brand. `isSignal` checks brand + `.peek()`.
3. `direct-brand`: constructor stamps the immutable brand directly, without a registry or other metadata. `isSignal` checks brand + `.peek()`.

All three pass the required `value`/`peek`, writable signal, read-only computed, `.value`/`.peek` prototype shape, and own brand-only symbol checks. The cross-copy reactive protocol remains out of scope. Source create/read timings are in `brand-candidates-results.json`.

`alien-derived-runtime-core.mjs` is the Core Candidate layered on the helper-brand shape. It caches the exact thrown computed error, keeps dependencies read before failure, rethrows the same object on `.value`/`.peek`, recovers after a tracked source write, and contains a failing queued effect so later effects in the flush still run. `core-errors-check.mjs` verifies these semantics. The isolated delta screen for dirty-read, equality suppression, and effect observed-write is saved as `core-candidate-results.json`.

### Core Candidate measurements and semantic limits

The completed two-class wrapper diagnostic measured `public-create-results.json`: the wrapper-plus-inner-source candidate was 16.25x bare inline on the median of four paired `source/create@1` rounds (round ratios 9.83x, 16.25x, 22.01x, 7.69x). It was not used for more workloads. The single-object brand screen records four balanced rounds for `source/create@1` and `source/read@1`: versus bare, WeakSet+brand was 12.70x/1.12x, helper brand was 5.43x/1.03x, and direct brand was 5.90x/0.98x. These are exploratory ratios; differences between helper/direct are small and variable. The helper-brand shape was selected for the Core Candidate because it had the lowest median create cost among the single-object shapes, while preserving straightforward shared registration.

The computed-error delta screen compares helper-brand alone to the Core Candidate (helper-brand plus cached computed errors and effect-flush containment). Ratios by paired-round median were dirty-read 0.97x (rounds 0.86x, 0.59x, 0.97x, 1.65x), equality-suppression 0.92x (1.14x, 0.92x, 0.83x, 0.90x), and effect observed-write 1.07x (0.99x, 1.34x, 0.88x, 1.07x). Raw process samples are in `core-candidate-results.json`; this four-round delta screen is not an authoritative performance conclusion.

The error check also covers cleanup failures during effect rerun and explicit disposal, later queued effects still running, and reporters that throw. `reportFailure` guards both `console.error` and `globalThis.reportError`. The initial synchronous `effect(fn)` callback is also contained and reported; reads made before its first throw remain dependencies so a later source write retries the callback.

## Render adapter probe

`alien-derived-runtime-render.mjs` and `react-adapter.mjs` are a local render-stage prototype only. Signal reads during a React render record source revision/value without settling live Alien nodes. Computed reads use a `WeakMap` cache keyed by render attempt; their speculative dependencies/errors stay local and are promoted to normal graph subscriptions only after layout commit. Commit compares captured revisions and requests another render when a source changed between render and commit. `useSignalValue` uses `useSyncExternalStore` with a cached render snapshot; `useSignalTracking`/`useManagedSignals` use the local collector and reconcile committed dependencies.

Two subscription shapes were checked: `combined` keeps one graph bridge for the whole dependency set; `per-readable` keeps one bridge per readable. The local suite covers leaf updates, dynamic branch release, nested managed scopes, StrictMode cleanup, Suspense abandonment/retry, render-to-commit changes, speculative computed purity, a settled transition shared by tracked and leaf readers, and duplicate-copy render reads. It does not prove behavior under a scheduler-controlled mid-fiber yield.

## DeepSignal integrated candidate and package topology

`alien-derived-deep-signal-engine.ts` adapts the existing `src/core/deep-signal-engine.ts` factory to the isolated branded Alien-derived runtime. This reuses the engine's proxy, per-key dependency, collection view, descriptor/prototype, alias/cycle, and metadata-reclamation rules instead of keeping the earlier partial custom proxy. `deep-signal-engine.test.ts` copies `tests/deep-signal.test.ts` with only its imports redirected to the candidate adapter/runtime; all 35 tests pass.

`react-deep-signal-candidate.test.tsx` similarly copies the existing 27-test React DeepSignal suite and substitutes candidate runtime, React adapter, shared context, and a candidate `useDeepSignalValue` selector store. Three earlier alternatives (durable nested evaluation, boundary-only subscription, and shared speculative memo keyed by dependency revisions) did not meet the nested-computed render-count contract. The fourth alternative promotes eligible attempt-local computed results into the live Alien graph only from `RenderStore.commit`: it checks captured dependency revisions, links local dependencies, and makes subsequent clean reads restore ordinary graph linking/interop publication. Abandoned or suspended attempts are never promoted. DeepSignal speculative reads still block promotion if their epoch or dependency signature makes the result unsafe.

The repaired `keeps production nested computed deep reads behind a tracked computed boundary` test passes with the expected two outer evaluations and two component renders (mount plus one source update). The full candidate set passes 82/82 tests (18 candidate React adapter + 35 core DeepSignal + 2 focused DeepSignal React + 27 copied React DeepSignal), including speculative effect isolation, StrictMode, Suspense abandonment/retry, render-to-commit changes, selector error recovery, and deep selector tracking. Run only this candidate suite with:

```sh
pnpm exec vitest run --config benchmarks/phase9/m15/vitest.config.mjs
```

This is an integrated prototype, not a self-contained Alien-only distribution: the runtime is MJS, DeepSignal reuses the production TypeScript engine and its interop/render-tracking modules through an adapter, and React hooks are candidate-local. The current package already declares `alien-signals` as a runtime dependency and `react` as a peer dependency. Keeping React a peer is appropriate for a React adapter; whether to keep Alien as a runtime dependency depends on whether the derived baseline's `alien-signals/system` imports remain in shipped output. A bundled build must be checked before changing that topology. No primary package metadata or production source was changed.

## Balanced overhead diagnostic and bundle topology

`interop-overhead-screen.mjs` uses a deterministic six-round order for three runtime shapes: `ABC`, `BCA`, `CAB`, `ACB`, `CBA`, `BAC`. It places each runtime twice in each absolute position and balances every pair's before/after order 3:3. Two-runtime foreign comparisons alternate `AB`/`BA`. The saved `interop-overhead-results-balanced.json` contains fresh-process raw durations (3 warmups, 7 samples) and preflight rows. Paired round-median ratios versus `m15-objectis` were: source/read helper-call 1.91x (rounds 1.25–1.97), render-live 1.08x (0.83–1.34); observed-write helper-call 2.26x (1.74–2.97), render-live 1.93x (1.46–2.27). For foreign observed-write, `m15-render-foreign` was 2.53x the local helper-call shape (1.99–2.58). These are noisy, diagnostic-only measurements with six rounds, not an M1b or M1.5 performance conclusion. A dedicated React/DeepSignal timing case is not present; those features have semantic candidate tests, including the selector store, but have not been performance-screened.

`react-deep-screen.mjs` adds two same-semantics ReactDOM/JSDOM fresh-process cases, comparing the branded Object.is control adapter to the render candidate: `rfsg/react-useSignalValue@1` and `rfsg/react-deep-selector@1`. Both use four alternating paired rounds, three warmups, seven samples, and 250 updates from the frozen useSignalValue count; all four runtime/case preflights passed. After commit promotion, candidate/control paired round-median ratios were 1.13x for useSignalValue (rounds 1.23x, 0.87x, 1.03x, 1.29x; range 0.87–1.29) and 0.98x for deep selector (1.07x, 0.98x, 0.91x, 0.97x; range 0.91–1.07). Raw durations are in `react-deep-results.json`. This small four-pair diagnostic is noisy and is not a performance conclusion.

`package-topology-build.mjs` builds both control and candidate minified ESM with Vite/Rolldown, leaving React external and bundling other imports. After the fourth alternative, candidate output is 45,595 bytes raw and 11,302 bytes gzip; the control is 28,215 bytes raw and 7,542 bytes gzip. The fourth alternative increased the candidate by 993 raw bytes / 203 gzip bytes over the prior 44,602 / 11,099 build. Neither output has an external `alien-signals/system` import, and both retain an external `react` import. This supports keeping React as a peer and means Alien need not be a shipped runtime dependency if this bundling policy is adopted. The build does not itself establish the preferred production packaging policy; inspect license/provenance notices and the actual consumer bundle before changing package metadata.

The final candidate suite is semantically green, but this is not the complete M1.5 authoritative performance matrix: the measurements here are selected four-round diagnostic screens, not the full frozen matrix. The candidate remains benchmark-only and is not integrated into production; no migration or performance conclusion follows from these results.

## M1.5.4 source representation and interop cost closure

The M1.5.4 audit, pinned source comparison, direct C3/M1.5.3 verification, and final decision are documented in [m1.5.4.md](../../../development/phases/phase9/m1.5.4.md). The deterministic runner `m154-source-representation-screen.mjs` uses frozen M1b counts, 3 warmups, 7 samples, and serial fresh Node processes. Its direct screen compares C3 against the exact frozen M1.5.3 production artifact: 24 rounds for source create/read, 18 for selected source/effect controls, and 12 for graph/batch controls. The authoritative eight-round M1b run is retained at [`../results/m1.5.4-2026-09-29-representation-final/`](../results/m1.5.4-2026-09-29-representation-final/), with analysis JSON and allocation diagnostics. C3 is accepted; Phase 9 performance validation is closed and M2 may begin next. This benchmark directory remains research and evidence, not an imported production module.
