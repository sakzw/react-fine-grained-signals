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

Define the common semantics, adapters, process isolation, deterministic order rotation, semantic assertions, machine-readable raw output, and lightweight allocation/object-model checks. Run only a small correctness/infrastructure smoke. Smoke values are explicitly non-comparable and are not performance evidence.

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

Use the same physical machine and exact Node version, fresh processes, warmup, multiple independent rounds, deterministic runtime-order rotation, semantic assertions, and raw results with machine/runtime metadata. Keep adapters out of hot loops where possible; use a native direct-call comparison before attributing a material difference to a common adapter. `benchmarks/core.mjs` remains directional unless it meets this evidence standard. Run measured processes serially and avoid competing builds, tests, or CPU-heavy analysis on the machine.

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

For each round, runtime order rotates deterministically through the four-candidate list. The orchestrator runs one child process per runtime/case/round, serially; that child performs preflight assertions, configured warmups, then configured samples. Each sample is validated outside its timing interval. Abnormal exits, timeouts, pin mismatches, and assertion failures are recorded in `failures.jsonl`; they never become zero-duration rows. Vue batch and unsupported RFSG-only cases are written to JSONL with `status: "na"` and a reason.

Each run directory has `manifest.json`, raw per-sample `samples.jsonl`, `allocations.jsonl`, and `failures.jsonl`. The manifest records runtime pins and artifact integrity, phase baseline SHA, harness HEAD and dirty paths, harness/lockfile hashes, Node and package-manager versions, OS/architecture/CPU, configuration, deterministic round order, and GC flags. Durations are numeric nanoseconds; rates and heap deltas are numeric values, not formatted console tables. The allocation diagnostic keeps the graph live for its live-heap reading, disposes it, verifies it no longer reacts, releases references, then measures retained heap after forced GC. It remains a coarse sanity check.

M1a smoke uses low operation counts and one round/sample, exercises every common case plus the supported RFSG-only cases, confirms the expected `N/A` rows, validates the manifest/raw JSONL, and runs graph/fan-out/deep-leaf allocation checks. It is labeled `SMOKE / HARNESS VALIDATION ONLY`; no smoke result is an authoritative performance number.

M1a implementation validation passed: `pnpm --dir benchmarks/phase9 smoke` completed all 102 planned tasks (83 sample rows, 13 expected `N/A` rows, 10 allocation rows, and zero failures); `node verify-pins.mjs` in the fixture directory, `pnpm build:runtime`, `pnpm typecheck`, `pnpm lint`, `git diff --check`, and syntax checks for the harness modules passed. Lint reported warnings in existing runtime/test files; the new harness files had no lint warnings. The smoke manifest and raw records were inspected for completion and are retained under the OS temporary directory for this local validation only. Their timings are not performance evidence and are not committed.

#### M1b proposed execution contract

1. Use a quiet, fixed machine and record its exact Node version. Ensure no other build, test, benchmark, or CPU-heavy work is running.
2. Install the frozen fixture and rebuild current `dist` from the c5 runtime source. Confirm the worktree/runtime baseline and package-lock integrity in the run manifest.
3. Run the controlled matrix serially with 8 process-level rounds, 3 warmups and 7 samples per worker, sizes `1,16,64` for fan-in/fan-out, and the per-case iteration defaults in `config.mjs`. Run allocation diagnostics at graph count `1000` for 3 rounds.
4. Keep the generated `manifest.json`, raw JSONL, and failures file together. Reject the run if any pin is wrong, any child fails, any semantic assertion fails, or the raw record set is incomplete.
5. Derive per-case summaries and ratios from raw records only. Keep RFSG-only and React cases separate from the four-runtime common comparison. Do not treat M1a smoke values as measurement evidence.

### Conditional M1.1 — Targeted attribution

Only proceed if M1 finds a material regression. Profile narrowly or use one-variable ablations for source reads/writes, effect execution, computed dirty checks, batch flush, revision/render bookkeeping, interop checks, and allocations/object shape. Classify each result as measurement noise, required semantic cost, avoidable implementation cost, correctness trade-off, or future optimization. “React support makes it slower” is not sufficient attribution.

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

## Proposed next step: M1

M1a harness work is complete. The next requested milestone is M1b: run the controlled procedure above and review the raw records for completeness before drawing any conclusions. Do not begin targeted M1.1 profiling unless M1b shows a material regression.
