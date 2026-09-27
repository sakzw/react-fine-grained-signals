# Phase 9 — v0.2.0 Release Readiness & Performance Validation

## Purpose and scope

Phase 9 determines whether the current implementation is ready for v0.2.0 and whether its performance is acceptable relative to the released v0.1.1 package, Alien Signals, and a pinned Vue reactivity implementation. It must distinguish release blockers, costs required by RFSG semantics, and opportunities for later optimization. npm publication is outside the completion gate; it may follow the frozen release candidate and additional dogfooding.

Phase 5 through Phase 8 remain frozen. Phase 9 is not a feature phase. During M0, make no production behavior changes and do not redesign `deepSignal`, scheduling, bare tracking, `ReadableInterop`, or cross-runtime semantics. Production continues to depend on `alien-signals/system`, not Alien Signals' high-level root API.

The starting production boundary is:

```text
RFSG public API
  ↓
coreRuntime
  ↓
createReactiveRuntime()
  ↓
RFSG-owned graph / scheduler / lifecycle
  ↓
alien-signals/system
```

## Verified starting points

| Candidate | Pin | Evidence / use |
| --- | --- | --- |
| Current RFSG | Commit `c5d1796cfa2063db7eecb99e537209de185a530c` (`Guard Alien runtime dependency boundary`), parent `329b6983d93a639beb9b801c5ce499a318b7133e`. At audit start, `main` and the local `origin/main` ref both pointed to this commit; the checkout was clean. | Identify the pre-release candidate by commit, not package version. Both manifests still say `0.1.1` until M3. |
| Released RFSG | Tag `v0.1.1` peels to `0e12bbf46ab098fbb2388704ab85c3c406189cbb`. | Prefer the actual published `react-fine-grained-signals@0.1.1` artifact for historical measurements, rather than rebuilding the old source with current tools. Pin its peer `alien-signals@3.2.1`. |
| Alien Signals | `alien-signals@3.2.1`. The current lockfile resolves `3.2.1`; current RFSG declares `^3.2.1`. | Compare Alien's high-level API to RFSG's runtime using the same underlying version. Pin it explicitly for historical RFSG comparisons because v0.1.1 declared it as a peer. |
| Vue reactivity | `@vue/reactivity@3.6.0-rc.9`; [Vue core tag `v3.6.0-rc.9`](https://github.com/vuejs/core/releases/tag/v3.6.0-rc.9), commit [`5be279570a844b953dd44b56bdc2426f7421aecd`](https://github.com/vuejs/core/commit/5be279570a844b953dd44b56bdc2426f7421aecd). The tag release and Vue core PR [#12349](https://github.com/vuejs/core/pull/12349) verify the Alien-derived reactivity port. | This was the newest Vue 3.6 prerelease listed when the audit pinned the target. Keep this exact target after benchmark records exist unless a clear reason requires changing it. |

## Milestones

### M0 — Release readiness audit

Audit package/API compatibility, docs, examples, JSX and transform entry points, dependencies, tarball contents, consumer coverage, and the release procedure. Inventory and classify findings before fixing them. Classifications are `blocker`, `release polish`, and `post-v0.2.0`. No production behavior changes belong in M0.

### M1 — Performance baseline and attribution

M1 is split into harness readiness and controlled measurement:

#### M1a — Benchmark harness design and implementation

Define the common semantics, adapters, process isolation, balanced deterministic runtime order, semantic assertions, machine-readable raw output, and lightweight allocation/object-model checks. Run only a small correctness/infrastructure smoke. Smoke values are explicitly non-comparable and are not performance evidence.

#### M1b — Controlled recorded measurement

Run the frozen harness under the controlled procedure documented below. Record raw samples and a run manifest. Make performance conclusions only from these results, never from M1a smoke output.

The common comparison candidates are:

Compare these implementations on semantically comparable common-core workloads:

1. RFSG v0.1.1 from its published artifact, with Alien Signals pinned to `3.2.1`.
2. Current RFSG, identified by the starting commit SHA and using its exact Alien Signals version.
3. Alien Signals high-level API at `3.2.1`.
4. The pinned Vue Alien-derived reactivity implementation above.

The central release question is whether current RFSG materially regressed against v0.1.1. Report case-specific ratios (`current / v0.1.1`, `current / Alien`, `current / Vue`); do not collapse them into a ranking or aggregate score.

Common workloads should include source creation/read/unobserved write/write-read; effect creation, single-source tracking, create/dispose, observed writes, fan-out, and dynamic dependencies; computed creation, dirty/read and dirty/unread paths, equality suppression, fan-in/fan-out; and batched writes with one downstream reaction. RFSG-only workloads should cover bare and managed render tracking, `useSignalValue`, JSX direct binding, `deepSignal`, cross-copy behavior, foreign computed/readable interop, and speculative render/render-to-commit behavior. Do not force RFSG-specific semantics onto Alien or Vue.

Use the same physical machine and exact Node version, fresh processes, warmup, multiple independent rounds, balanced deterministic runtime order, semantic assertions, and raw results with machine/runtime metadata. Keep adapters out of hot loops where possible; use a native direct-call comparison before attributing a material difference to a common adapter. `benchmarks/core.mjs` remains directional unless it meets this evidence standard. Run measured processes serially and avoid competing builds, tests, or CPU-heavy analysis on the machine.

Include lightweight allocation/object-model sanity as part of the M1 baseline. After forced GC, record heap use before creation, with the selected graph live, and after disposal plus GC for many sources/computeds/effects, one source with many subscribers, and RFSG watched `deepSignal` leaves. Verify disposed observers stop reacting. These are coarse directional retained-heap checks, not allocation rates, object-count claims, heavyweight snapshots, or release scores.

#### M1a harness design and implementation record

The harness lives in `benchmarks/phase9/` with a private pinned dependency fixture and lockfile. `run.mjs` is the serial orchestrator; `worker.mjs`, `react-worker.mjs`, and `allocation-worker.mjs` execute one candidate/workload in a fresh child process. Workers load only their selected runtime. The M1a runtime baseline is `c5d1796cfa2063db7eecb99e537209de185a530c`; the harness/documentation HEAD at M1a start is `acb49267af7141f6bb4182e06409b1264e1d1f70`. The latter changes docs only and is not the current-runtime performance baseline.

The fixture installs the published npm artifact `react-fine-grained-signals@0.1.1` without rebuilding old source, and pins its `alien-signals` peer to exactly `3.2.1`. Direct Alien is `3.2.1`; Vue is `@vue/reactivity@3.6.0-rc.9`, from Vue core commit `5be279570a844b953dd44b56bdc2426f7421aecd`. The lockfile integrity values are included in each manifest. `verify-pins.mjs` checks installed package versions and that the historical/current RFSG Alien resolutions are both `3.2.1`.

The semantic contract and exclusions are:

| Workload group | Compared candidates | Contract / exclusion |
| --- | --- | --- |
| Source create, read, unobserved write, write/read | All four | RFSG values use `.value`, Alien uses callable `s()` / `s(value)`, Vue uses `shallowRef().value`. Creation retains only the last source so earlier objects can be collected. |
| Effect create, create/dispose, single-source tracking, observed write, fan-out, dynamic dependency switching | All four | Effects run immediately and synchronously for these direct writes. Count runs and verify disposal/unsubscription; do not compare callback order. Vue disposes the runner with `stop(runner)`. Fan-out sizes are configurable. |
| Computed create, dirty/read, dirty/unread, equality suppression, one source to many computed, many sources to one computed | All four | Verify lazy evaluation, final values, and notification counts. Equality uses ordinary numeric values because Alien Signals uses `!==`, while RFSG and Vue use `Object.is`-style equality. |
| Two writes followed by one downstream reaction | RFSG v0.1.1, current RFSG, Alien | Vue is `N/A`: the standalone public reactivity API has no public multi-write transaction. Alien uses `startBatch()` / `endBatch()` in `try/finally`. |
| `deepSignal` read and watched leaf write | RFSG v0.1.1 vs current RFSG only | Directional RFSG-specific measurements; Alien and Vue are `N/A` because they do not implement RFSG's proxy contract. |
| Bare tracking, managed tracking, `useSignalValue`, JSX direct binding | RFSG v0.1.1 vs current RFSG only | Directional React/runtime cases, not part of the common-core score. Old bare `useSignals()` maps to current `useSignalTracking()`; old `/runtime` managed `useSignals()` maps to current `useManagedSignals()`. The React worker validates render/DOM results and cleans up each root. |
| Cross-copy, foreign computed/readable interop, speculative render, render-to-commit | Correctness characterization only; no throughput ratio | These depend on RFSG package/runtime protocols or React lifecycle semantics. Do not emulate them in Alien/Vue or force them into a common score. Cross-copy behavior remains covered by its existing smoke test. |

Adapters are small and created before timing. Timed loops use runtime-specific direct source reads where useful. `diagnostic/adapter-read-dispatch` records native direct and normalized adapter read paths separately, with both paths asserted to produce the same sum; diagnostic values are not subtracted from other timings. Effect callbacks do not return cleanup functions, avoiding different cleanup contracts across runtimes.

For each round, the orchestrator uses the four-round balanced schedule `A B D C`, `B C A D`, `C D B A`, `D A C B`, where `A=rfsg-v0.1.1`, `B=rfsg-current`, `C=alien-signals`, and `D=vue-reactivity`. Every runtime occupies each absolute position once per cycle, and each pair runs before/after equally often. This balances the paired current/v0.1.1 comparisons against systematic order effects. The authoritative eight rounds repeat the cycle twice; custom exploratory round counts deterministically truncate it and claim full pairwise balance only for completed four-round cycles. The manifest records the exact order per round. A round runs one child process per runtime/case, serially; that child performs preflight assertions, configured warmups, then configured samples. Each sample is validated outside its timing interval. Abnormal exits, timeouts, pin mismatches, and assertion failures are recorded in `failures.jsonl`; they never become zero-duration rows. Vue batch and unsupported RFSG-only cases are written to JSONL with `status: "na"` and a reason.

Each run directory has `manifest.json`, raw per-sample `samples.jsonl`, `allocations.jsonl`, and `failures.jsonl`. The manifest records runtime pins and artifact integrity, phase baseline SHA, harness HEAD and dirty paths, harness/lockfile hashes, Node and package-manager versions, OS/architecture/CPU, configuration, deterministic round order, and GC flags. Durations are numeric nanoseconds; rates and heap deltas are numeric values, not formatted console tables.

The allocation diagnostic uses one strict workload ID at both dispatch points and in the worker: `signal-computed-effect-graph`, `one-source-many-effects`, or `deep-watched-leaves`. Unknown IDs throw. Each allocation row records its expected `graphShape`; the orchestrator compares it with the shape emitted by the worker and writes `shapeVerified: true` only after it also confirms disposed observers stop reacting. The graph creates N sources, N computeds, and N effects; fan-out creates one source and N effects subscribed to that source; deep allocation creates one RFSG `deepSignal` root, N watched leaves, and N effects. The diagnostic records heap use before creation, while the graph is live, and after disposal plus forced GC. These remain coarse sanity checks.

Measurement and calibration modes verify that `src/**`, package/lock/workspace manifests, TypeScript and tsdown configuration, and the runtime declaration post-processing script still match baseline `c5d1796cfa2063db7eecb99e537209de185a530c`. Benchmark and documentation changes are allowed. All modes record a deterministic SHA-256 over sorted relative paths and contents under built `dist`; measurement/calibration manifests also record that production inputs passed the baseline guard. This identifies the built candidate independently of the harness HEAD.

M1a smoke uses low operation counts and one round/sample, exercises every common case plus the supported RFSG-only cases, confirms the expected `N/A` rows, validates the manifest/raw JSONL, and verifies all three allocation graph shapes plus disposal. It is labeled `SMOKE / HARNESS VALIDATION ONLY`; no smoke result is an authoritative performance number.

The earlier M1a smoke only established that allocation tasks completed; it did not verify workload dispatch or graph shapes. That result is superseded by the strict dispatch and shape-checked smoke recorded below. Smoke timings are not performance evidence.

The corrected M1a validation completed all 102 planned smoke tasks: 83 successful sample rows, 13 expected `N/A` rows, 10 allocation rows, and zero failures. Allocation rows split into four graph rows (N sources, N computeds, N effects), four fan-out rows (one source, N subscribed effects), and two RFSG deep-leaf rows (one `deepSignal`, N watched leaves/effects); all were `shapeVerified` and confirmed disposal. An unknown allocation ID was directly verified to fail. The measurement identity guard accepted this benchmark/docs-only worktree and recorded a SHA-256 for 26 built `dist` files. `pnpm typecheck`, `pnpm lint`, `git diff --check`, harness syntax checks, and the identity guard passed. Lint reports existing warnings in runtime/test files; no warnings point to the Phase 9 harness. Smoke outputs remain in the OS temporary directory and are not committed.

#### M1b-0 — Performance interpretation contract

Freeze these interpretation rules before running or reviewing authoritative M1b results.

**Primary comparison and statistic.** The release question is whether current RFSG materially regressed from released RFSG v0.1.1. Alien Signals and Vue are contextual baselines and cannot independently make v0.2.0 fail its performance gate. For each runtime/case/size and each fresh process round, let `T(runtime, round)` be the median throughput of that process's samples. For each of the eight paired rounds calculate `R(round) = T(current RFSG, round) / T(RFSG v0.1.1, round)`. The balanced runtime schedule makes the pair's before/after order equal across each four-round cycle, aligning the primary paired statistic with order control. The primary result is the median of those eight ratios. Report their IQR, minimum/maximum, and counts of `R < 1`, `R > 1`, and exact ties (each out of 8). Do not substitute `median(current) / median(v0.1.1)` for the paired statistic; it may appear only as a secondary check. Interpret ratios consistently: `1.00` is parity; `0.95` is about 5% slower, `0.90` about 10% slower, `0.75` about 25% slower, and `1.10` about 10% faster. Percentage delta is `(medianRatio - 1) * 100`.

**Workload importance.**

| Class | Cases | Use |
| --- | --- | --- |
| A — Core hot paths | `source/read`, `source/unobserved-write`, `source/write-read`, `effect/observed-write`, `effect/dynamic-dependencies`, `computed/dirty-read`, `computed/dirty-unread`, `computed/equality-suppression`, `batch/two-writes-one-reaction` | Primary steady-state regression cases; stable changes deserve strongest attention. |
| B — Construction and scaling | `source/create`, `effect/create`, `effect/create-dispose`, `effect/fanout`, `computed/create`, `computed/source-to-many`, `computed/many-to-one` | Important but distinct from hot paths. Interpret every graph size separately; do not combine sizes 1, 16, and 64. A size-dependent regression can warrant attribution even if size 1 is healthy. |
| C — RFSG-specific and diagnostic | `rfsg/deepSignal-read`, `rfsg/deepSignal-watched-leaf-write`, `rfsg/react-bare-tracking`, `rfsg/react-managed-tracking`, `rfsg/react-useSignalValue`, `rfsg/react-jsx-direct-binding`, `diagnostic/adapter-read-dispatch`, allocation diagnostics | Interpret separately; never merge into a common-core score. |

**Materiality and noise.** These are engineering thresholds, not statistical significance boundaries. Normally call `0.95 <= median paired ratio <= 1.05` rough parity, subject to round spread. Above approximately `1.05`, do not automatically claim an improvement: apply the same repeatability, IQR, and direction standards used for regressions. Classify a stable improvement as `improvement`; a noisy apparent improvement as rough parity or unstable / inconclusive as appropriate. There is no separate release gate for improvements. A ratio from `0.90` through below `0.95` is a small regression and does not alone require M1.1; elevate unusually stable results, especially 7/8 or 8/8 slower rounds with narrow IQR. A median below `0.90` is a material-regression candidate only when direction is repeatable and the effect exceeds observed spread. A repeatable Class A regression around 10% or more should generally enter M1.1. A consistent ratio below `0.75` is a high-priority severe candidate; around `0.50` or lower on a meaningful workload is an immediate high-priority attribution case if measurement validity holds. Apply the same repeatability and spread standards to claimed improvements. When the distribution substantially crosses parity or has wide spread, classify it unstable / measurement-sensitive instead of attributing it to runtime code. Report direction counts as supporting evidence; do not require a sign-test p-value.

**M1.1 and release decisions.** M1.1 is attribution, not an automatic release failure. Enter it for a stable ~10%+ Class A regression; a smaller exceptionally repeatable Class A change worth explaining; a large or scaling-dependent Class B change; any severe/multi-fold change; a coherent set of related regressions; or a large allocation/React diagnostic that supports throughput evidence. Attribute findings as measurement artifact, required semantic cost, avoidable implementation cost, correctness trade-off, or future optimization opportunity. A performance case is not a release blocker merely because it enters M1.1. A final performance blocker normally requires a valid, material, repeatable regression, M1.1 attribution, and evidence the cost is avoidable or unacceptable. A catastrophic multi-fold regression in a central primitive may be provisionally blocker-level before attribution, but still requires M1.1 before runtime changes.

**Contextual baselines and diagnostic cases.** Report `v0.1.1 / Alien` and `current / Alien` alongside the primary ratio where semantics match; this shows whether an Alien gap predates the migration. Do not assume every gap is avoidable because RFSG also owns React integration, revision/race handling, interop, error containment, and subscription behavior. Vue is a production-grade Alien-derived reference, not an equivalence target; report `v0.1.1 / Vue` and `current / Vue` only for comparable cases, and leave unsupported batch as `N/A`. The adapter diagnostic is not a product case: exclude it from Classes A/B and release judgment, and never subtract its cost from another measurement.

Allocation diagnostics are red-flag evidence only: set no percentage threshold, invent no object counts, and treat forced-GC `heapUsed` as noisy. Look for large absolute or multi-fold shifts, same-direction changes across rounds, retained heap after disposal, and agreement with throughput evidence; small or negative deltas are not exact zero retention. Keep React/jsdom results separate and require stronger repeatability for small claims; a small React-only difference does not establish a core regression, while coherent case patterns can guide attribution. `deepSignal` is RFSG-specific: compare v0.1.1 with current and keep read, watched write, and allocation evidence separate.

For each current-v0.1.1 case, classify as rough parity, small stable regression, small unstable difference, material regression candidate, severe regression candidate, improvement, unstable / inconclusive, or `N/A`. Separately state whether M1.1 is not required, required for attribution, or measurement investigation is required before attribution. The M1b phase decision is exactly one of: **A)** no material unexplained regression — M1.1 not required, proceed to M2; **B)** material repeatable regression(s) — M1.1 required for identified paths; **C)** measurement validity/instability problem — M1b is not accepted and measurement issues must be resolved before runtime attribution. Do not combine B and C.

#### M1b proposed execution contract

1. Use a quiet, fixed machine and exact Node version. Install the frozen fixture and build current `dist` from the c5 runtime source. Calibration is a separate pilot mode; use it to choose one shared per-case/size iteration count that gives the fastest candidate an approximately 20–30 ms timing window. Freeze the complete iteration file, then verify it with another calibration run. Pilot records are not performance evidence and stay under `calibration/`.
2. `mode=measure` requires a complete frozen `--iterations-file` and rejects omission before creating output or starting workers. Run the final matrix serially with that file, 8 process-level rounds, 3 warmups and 7 samples per worker, and sizes `1,16,64` for fan-in/fan-out. Eight rounds are two complete cycles of the balanced order above. For a custom exploratory count, the helper truncates deterministically and the manifest records each round; only complete four-round cycles are pairwise balanced. The explicit command is `pnpm --dir benchmarks/phase9 measure -- --iterations-file benchmarks/phase9/m1b-iterations.json --rounds 8 --warmups 3 --samples 7 --sizes 1,16,64 --graph-count 1000 --allocations --allocation-rounds 3 --output benchmarks/phase9/results/m1b-<run-id>`. The measurement guard rejects production-relevant source/configuration drift from c5 while allowing benchmark/docs-only commits. The manifest records the built `dist` SHA-256.
3. Keep `manifest.json`, raw JSONL, and failures together. Reject the run if any pin is wrong, any child fails, any semantic assertion or allocation-shape check fails, or the raw record set is incomplete.
4. For each runtime/case/size, take the median of samples within each fresh process round. Across round medians, report the median and IQR (or another declared spread measure). Derive case-specific ratios from these summaries. Do not pool individual samples across rounds, create an overall score, or rank implementations globally.
5. Keep diagnostic, allocation, React, and RFSG-only cases separate from the four-runtime common comparison. Do not treat M1a smoke or calibration values as measurement evidence.

### Conditional M1.1 — Targeted attribution

Proceed only for cases that meet the M1.1 entry policy frozen in M1b-0. Profile narrowly or use one-variable ablations for source reads/writes, effect execution, computed dirty checks, batch flush, revision/render bookkeeping, interop checks, and allocations/object shape. Classify each result as measurement noise, required semantic cost, avoidable implementation cost, correctness trade-off, or future optimization. “React support makes it slower” is not sufficient attribution.

### M2 — Release hardening

Implement only findings established by M0, M1, or M1.1: release blockers, small targeted performance hardening, docs/package inconsistencies, migration documentation, packaging issues, or consumer/tarball coverage. Do not add public APIs or start ReadableInterop V2, `deepSignal`, scheduler, bare-tracking, cross-runtime, or high-level Alien API redesigns. Tie each production change to a finding.

### M3 — v0.2.0 release-candidate freeze

Before final artifact validation, update both package versions to `0.2.0` so tarball validation can confirm the unplugin's `workspace:^` rewrite yields the intended v0.2.0 peer range. Then run:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:phase4-duplicate
pnpm test:consumer
pnpm test:browser
pnpm size
git diff --check
```

Pack both packages and validate the real tarballs from a clean consumer. `npm publish`, tagging, pushing, and GitHub release creation remain outside Phase 9. The documented release path is `pnpm publish`; do not bump versions during M0.

## M0 — Release readiness findings (2026-09-27)

The checkout matched the requested Phase 9 starting commit and its parent. The `v0.1.1` tag and resolved Alien Signals version were verified. The current architecture boundary test confines the `alien-signals/system` import to the private RFSG runtime. The API/declaration comparison found no other changes among the checked root exports, `/utils`, JSX runtime exports, or JSX declarations. Both package tarballs were packed and inspected: the runtime tarball contains its entry points, declarations, source maps, README files, and license; the unplugin tarball contains its declared exports, declarations, README files, and license. The packed unplugin manifest rewrites `react-fine-grained-signals: workspace:^` to `^0.1.1`. Both manifests still report `0.1.1`, as expected before M3.

### Blocker

None identified by this audit. The API changes below are source/type compatibility breaks that need to be treated and documented as deliberate v0.2.0 migrations before release.

### Release polish

| ID | Area | Evidence | Recommended action | Target |
| --- | --- | --- | --- | --- |
| M0-API-01 | Hook migration | v0.1.1 exported root `useSignals`; current root exports `useSignalTracking`. v0.1.1 also exported `useManagedSignals as useSignals` from `/runtime`; current `/runtime` exposes only `useManagedSignals`. These were different contracts: root was the bare/best-effort boundary, while the runtime alias was managed. Current generated declarations confirm both removals. | Add a v0.1.1 → v0.2.0 migration note that explains each import-path replacement and the bare-versus-managed behavior. | M2 |
| M0-API-02 | Managed scope type | v0.1.1's public `ManagedSignalsStore` exposed both `finish()` and `f()`; current source and generated declarations expose only `finish()`. | Decide whether `f()` removal is intentional; record the migration or compatibility decision in the same release note. | M2 |
| M0-DOC-01 | Migration docs | The English docs index and README link to usage/design documentation but do not provide a v0.1.1 → v0.2.0 migration note. This leaves the API changes above unexplained for consumers. | Add and link a concise migration note describing the API changes and Alien dependency change. | M2 |
| M0-PACK-01 | Clean-consumer entry-point coverage | `tests/consumer-smoke.mjs` packs both packages, installs them in a clean fixture, typechecks, builds with Vite, verifies the managed transform, and invokes the cross-copy smoke. The fixture covers the root, `/runtime`, `/utils`, `/jsx-runtime` through `jsxImportSource`, and the unplugin `/vite` adapter. It does not directly cover `/jsx-dev-runtime`, the unplugin root, or its `/rollup`, `/webpack`, `/rspack`, and `/esbuild` adapters. | Extend tarball/consumer coverage to the remaining public entries, or explicitly document which adapters are covered by other release checks. | M2 |

### Post-v0.2.0

No finding from this audit requires post-v0.2.0 work. Missing Changesets or an automated publish workflow is not a blocker: current release documentation specifies manual `pnpm publish`, and the unplugin has a `prepublishOnly` guard against non-pnpm publication. The current tarball inspection confirmed README/LICENSE inclusion and correct peer rewriting. The smoke does not directly import every public subpath; that is recorded as release polish above.

## M0 validation and limits

- `git status --short --branch`, `git rev-parse HEAD`, commit-parent inspection, and local `origin/main` inspection: clean `main` at `c5d1796`; local `origin/main` matched.
- `git rev-parse 'v0.1.1^{commit}'`: `0e12bbf46ab098fbb2388704ab85c3c406189cbb`.
- Lockfile inspection: `alien-signals@3.2.1`.
- `pnpm pack` for both packages plus tarball file/manifest inspection: passed; package contents and the unplugin peer rewrite are recorded above.
- `pnpm test:consumer`: passed. This command builds both packages, packs and installs the tarballs into a temporary fixture, checks the runtime dependency/React peer/`sideEffects` metadata, runs `tsc` and a Vite build, checks managed boundaries, and runs the separate cross-copy smoke. It does not test every public entry point.
- `git diff --check`: run after this document is added.

## M1b — Authoritative controlled measurement (2026-09-27)

### Run identity and validity

- Starting main and remote origin/main: 01ce5517dc7281cd3b19e1cf86afe9c046f2ff3e (fix: balance Phase 9 runtime order); the starting worktree was clean.
- Frozen production runtime baseline: c5d1796cfa2063db7eecb99e537209de185a530c.
- Environment: Node v24.21.0, pnpm 12.6.0, Windows 10.0.26340.0, win32/x64, AMD Ryzen 7 PRO 6850U with Radeon Graphics.
- Fixture installation from the frozen lockfile, pnpm build:runtime, runtime identity guard, dependency pin verification, and balanced-order verification passed before calibration.
- Calibration pilot 2026-09-27T06-48-22-857Z-31244 completed all 116 tasks with no failures. It was used only to set iteration counts, targeting 25 ms for the fastest applicable runtime/adapter variant and retaining every configured minimum.
- Confirmation calibration 2026-09-27T06-51-24-089Z-36784 completed all 116 tasks: 321 successful sample rows, 13 expected N/A rows, and zero failures. All 107 process/runtime/variant medians exceeded 2 ms; semantic assertions and iteration coverage passed.
- Frozen shared iteration configuration: [benchmarks/phase9/m1b-iterations.json](../benchmarks/phase9/m1b-iterations.json), SHA-256 fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056. It contains all 29 selected case/size keys; compared runtimes share the same count.
- Authoritative result directory: benchmarks/phase9/results/m1b-2026-09-27 (run ID 2026-09-27T06-53-37-041Z-32896). The measured dist artifact SHA-256 is 360375039e6b9550f6dbefec3f677becc05fc8f444245daa855e6c767a015266.
- The run completed all 958/958 planned tasks: 6,096 raw sample rows (5,992 successful and 104 expected N/A), 30 allocation rows with shapeVerified true, all disposal checks passed, and failures.jsonl is empty. The manifest matches the frozen runtime baseline, dependency pins, dist hash, and iteration-file SHA.
- The exact round1RuntimeOrder through round8RuntimeOrder arrays match the frozen schedule, forming two complete balance cycles. The manifest's descriptive deterministicOrder string still said “runtime index rotated” when the run was recorded; that label did not control execution, and the per-round order fields are the checked evidence. The harness label has since been corrected for future runs.

The deterministic analyzer is [benchmarks/phase9/analyze.mjs](../benchmarks/phase9/analyze.mjs). It requires one explicit authoritative result directory, verifies completeness and iteration-file identity, then emits the full per-round summaries as JSON. It uses each process's median of seven sample throughputs, pairs the current/v0.1.1 round values, and summarizes the eight ratios. Quartiles use linear interpolation (R-7). The full JSON summary is retained as analysis.json beside the raw results.

### Current RFSG versus v0.1.1

Each row reports median paired ratio, IQR, range, then slower/faster/tied round counts. Sizes are independent. Labels and actions apply the frozen M1b-0 contract; no aggregate score was calculated.

| Class | Case / size | Median ratio (IQR) | Range | Direction | Classification | Action |
| --- | --- | ---: | ---: | ---: | --- | --- |
| A | source/read@1 | 0.698 (0.153) | 0.485–0.882 | 8/0/0 | material regression candidate | M1.1 required for attribution |
| A | source/unobserved-write@1 | 0.807 (0.272) | 0.690–1.263 | 6/2/0 | unstable / inconclusive | measurement investigation required before attribution |
| A | source/write-read@1 | 0.751 (0.225) | 0.567–0.926 | 8/0/0 | material regression candidate | M1.1 required for attribution |
| A | effect/observed-write@1 | 0.764 (0.238) | 0.587–1.065 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| A | effect/dynamic-dependencies@1 | 0.875 (0.230) | 0.700–1.155 | 5/3/0 | unstable / inconclusive | measurement investigation required before attribution |
| A | computed/dirty-read@1 | 0.654 (0.237) | 0.475–0.963 | 8/0/0 | material regression candidate | M1.1 required for attribution |
| A | computed/dirty-unread@1 | 1.388 (0.477) | 1.122–1.939 | 0/8/0 | improvement | M1.1 not required |
| A | computed/equality-suppression@1 | 0.781 (0.133) | 0.492–0.909 | 8/0/0 | material regression candidate | M1.1 required for attribution |
| A | batch/two-writes-one-reaction@1 | 0.794 (0.468) | 0.592–1.242 | 5/3/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | source/create@1 | 0.198 (0.058) | 0.115–0.320 | 8/0/0 | severe regression candidate | M1.1 required for attribution |
| B | effect/create@1 | 0.967 (0.316) | 0.836–1.440 | 5/3/0 | small unstable difference | M1.1 not required |
| B | effect/create-dispose@1 | 1.104 (0.196) | 0.767–1.266 | 1/7/0 | unstable / inconclusive | M1.1 not required |
| B | effect/fanout@1 | 0.678 (0.229) | 0.496–1.136 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | effect/fanout@16 | 0.826 (0.149) | 0.682–0.975 | 8/0/0 | material regression candidate | M1.1 required for attribution |
| B | effect/fanout@64 | 0.721 (0.083) | 0.483–0.779 | 8/0/0 | severe regression candidate | M1.1 required for attribution |
| B | computed/create@1 | 0.581 (0.258) | 0.412–0.857 | 8/0/0 | severe regression candidate | M1.1 required for attribution |
| B | computed/source-to-many@1 | 0.694 (0.228) | 0.461–1.221 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | computed/source-to-many@16 | 0.732 (0.180) | 0.614–1.088 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | computed/source-to-many@64 | 0.869 (0.106) | 0.642–1.091 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | computed/many-to-one@1 | 0.628 (0.242) | 0.288–1.129 | 7/1/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | computed/many-to-one@16 | 0.836 (0.288) | 0.619–1.771 | 5/3/0 | unstable / inconclusive | measurement investigation required before attribution |
| B | computed/many-to-one@64 | 0.843 (0.230) | 0.542–1.131 | 6/2/0 | unstable / inconclusive | measurement investigation required before attribution |

### RFSG-specific, React, and diagnostic evidence

| Case | Median ratio (IQR) | Range | Direction | Classification | Action |
| --- | ---: | ---: | ---: | --- | --- |
| rfsg/deepSignal-read@1 | 1.222 (0.245) | 0.954–1.301 | 1/7/0 | unstable / inconclusive | M1.1 not required |
| rfsg/deepSignal-watched-leaf-write@1 | 0.875 (0.224) | 0.617–1.153 | 6/2/0 | unstable / inconclusive | measurement investigation required before attribution |
| rfsg/react-bare-tracking@1 | 1.015 (0.139) | 0.679–1.359 | 4/4/0 | small unstable difference | M1.1 not required |
| rfsg/react-managed-tracking@1 | 1.008 (0.180) | 0.872–1.562 | 3/5/0 | small unstable difference | M1.1 not required |
| rfsg/react-useSignalValue@1 | 0.988 (0.537) | 0.607–2.062 | 4/4/0 | small unstable difference | M1.1 not required |
| rfsg/react-jsx-direct-binding@1 | 1.129 (0.178) | 0.678–1.619 | 2/6/0 | unstable / inconclusive | M1.1 not required |

The adapter diagnostic was analyzed separately. The normalized adapter path had median time overhead relative to a direct native call of 24.3% for v0.1.1 and 61.6% for current RFSG. This is large enough to qualify cross-library read comparisons as adapter-inclusive. It does not isolate the adapter's share of a product workload, and no synthetic overhead was subtracted.

Allocation rows were shape-verified and passed disposal checks. For the graph workload, current retained heap was about 0.331 MB versus 0.207 MB for v0.1.1; for one source with 1,000 effects it was about 0.109 MB versus 0.086 MB, with noisier current live-heap results. For 1,000 deep watched leaves, current retained heap was about 3.657 MB versus 0.715 MB (about 5.1×), with the same direction in all three rounds. These are coarse heap-use deltas, not object counts or an allocation-rate score. The deep-leaf retention is a red flag that aligns with the mostly slower watched-leaf throughput direction, but does not establish cause.

Alien and Vue remain contextual baselines. Alien is much faster for source/computed creation, while the source-read gap versus Alien predates this current implementation: v0.1.1/Alien was 1.832 and current/Alien was 1.289. Current/Vue source-read was 0.581 versus 0.827 for v0.1.1/Vue. Effects and computed paths vary by case; Vue is close to RFSG on effect creation but not on observed writes. Vue batch remains N/A. Full case-specific round-aware ratios are in analysis.json; these comparisons do not set release thresholds or rank runtimes.

### M1b decision and next milestone

**Decision B — M1.1 required for attribution.** The repeatable Class A candidates are source/read, source/write-read, computed/dirty-read, and computed/equality-suppression. Class B attribution targets are source/create, computed/create, effect/fanout@16, and effect/fanout@64. The deep watched-leaf allocation delta is also a targeted red flag to examine alongside rfsg/deepSignal-watched-leaf-write. This decision does not make any result a release failure.

M1.1 is the next milestone. Attribute only these named paths and related subsystem behavior; do not optimize them during this measurement milestone. Investigate the unstable rows separately before drawing runtime conclusions. Stop here: do not start M2 or change production runtime behavior.
