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
| Vue reactivity | `@vue/reactivity@3.6.0-rc.9`; [`vuejs/core` tag `v3.6.0-rc.9](https://github.com/vuejs/core/releases/tag/v3.6.0-rc.9), commit [`5be279570a844b953dd44b56bdc2426f7421aecd`](https://github.com/vuejs/core/commit/5be279570a844b953dd44b56bdc2426f7421aecd). The tag release and Vue core PR [#12349](https://github.com/vuejs/core/pull/12349) verify the Alien-derived reactivity port. | This was the newest Vue 3.6 prerelease listed when the audit pinned the target. Keep this exact target after benchmark records exist unless a clear reason requires changing it. |

## Milestones

### M0 — Release readiness audit

Audit package/API compatibility, docs, examples, JSX and transform entry points, dependencies, tarball contents, consumer coverage, and the release procedure. Inventory and classify findings before fixing them. Classifications are `blocker`, `release polish`, and `post-v0.2.0`. No production behavior changes belong in M0.

### M1 — Performance baseline and attribution

Compare these implementations on semantically comparable common-core workloads:

1. RFSG v0.1.1 from its published artifact, with Alien Signals pinned to `3.2.1`.
2. Current RFSG, identified by the starting commit SHA and using its exact Alien Signals version.
3. Alien Signals high-level API at `3.2.1`.
4. The pinned Vue Alien-derived reactivity implementation above.

The central release question is whether current RFSG materially regressed against v0.1.1. Report case-specific ratios (`current / v0.1.1`, `current / Alien`, `current / Vue`); do not collapse them into a ranking or aggregate score.

Common workloads should include source creation/read/unobserved write/write-read; effect creation, single-source tracking, create/dispose, observed writes, fan-out, and dynamic dependencies; computed creation, dirty/read and dirty/unread paths, equality suppression, fan-in/fan-out; and batched writes with one downstream reaction. RFSG-only workloads should cover bare and managed render tracking, `useSignalValue`, JSX direct binding, `deepSignal`, cross-copy behavior, foreign computed/readable interop, and speculative render/render-to-commit behavior. Do not force RFSG-specific semantics onto Alien or Vue.

Use the same physical machine and exact Node version, fresh processes, warmup, multiple independent rounds, deterministic runtime-order rotation, semantic assertions, and raw results with machine/runtime metadata. Keep adapters out of hot loops where possible; use a native direct-call comparison before attributing a material difference to a common adapter. `benchmarks/core.mjs` remains directional unless it meets this evidence standard. Run measured processes serially and avoid competing builds, tests, or CPU-heavy analysis on the machine.

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

Start M1 by specifying and implementing the dedicated comparison harness and adapters, then record a pinned run manifest before measuring. Use the exact baselines above and the listed common/RFSG-only cases; validate semantic assertions and raw-result capture first. Use the actual v0.1.1 package artifact for historical RFSG, and execute benchmark processes serially. Do not begin targeted M1.1 profiling unless the M1 results show a material regression.
