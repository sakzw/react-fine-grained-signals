# Phase 9 M1.2 — Runtime Representation Optimization

## Scope and starting state

M1.2 started on `main` at `daa4a2dc4ac974e10921c30906fd8da7cc10179f` (`docs: add M1.2 reference architecture study`). The branch pointed to `origin/main`. The checkout had the M1.2 diagnostic directory as untracked input from the prototype work; it was preserved and recorded in the final run's start-state manifest. Production continued to use `alien-signals/system`.

Competing work used the isolated `m12-source-a`, `m12-source-c`, and `m12-scope` worktrees; a separate read-only test audit checked the required contracts. The final selected code was applied to the main checkout without Git history operations. Candidate C and scope experiments were measured serially, with no benchmark running alongside builds or tests.

## Source prototypes and decision

Candidate A made the public signal itself an Alien-compatible graph node and removed the wrapper/node split. Its focused runtime suites passed, but the existing runtime-surface suite failed two of three checks: internal graph fields became reflectable through the public object, and the public readable became the render dependency object. This changes observable shape and render tracking identity, so A was rejected.

Candidate C retained the public wrapper and private node. It removed the `nodesByReadable` `WeakMap` and its per-readable entry. Internal lookup now uses the wrapper classes' private `#node` brand. It replaced two per-readable protocol closures with shared `RuntimeReadableInterop` prototype methods. The separately allocated protocol object remains frozen and retains `version`, `runtimeToken`, `getRevision()`, and receiver-bound `subscribe()` behavior. Public signal branding and same-copy `WeakSet` identity remain in place.

| Candidate C vs unchanged current | Median paired throughput | Q1–Q3 | Faster pairs | Interpretation |
| --- | ---: | ---: | ---: | --- |
| `source/create@1` | 2.957× | 2.517–3.306 | 4/4 | Strong repeatable creation improvement; magnitude varies. |
| `source/read@1` | 1.004× | 0.959–1.013 | 3/4 | Parity. |
| `source/unobserved-write@1` | 1.103× | 0.973–1.554 | 2/4 | Noisy/inconclusive. |
| `source/write-read@1` | 0.935× | 0.814–1.232 | 2/4 | No repeatable material regression. |
| `computed/create@1` | 2.010× | 1.770–2.254 | 4/4 | Strong repeatable creation improvement. |
| `computed/dirty-read@1` | 0.987× | 0.810–1.112 | 2/4 | No clear change. |
| `computed/dirty-unread@1` | 0.807× | 0.681–0.944 | 1/4 | Candidate-C diagnostic slower; final v0.1.1 comparison below remained faster but noisy. |
| `computed/equality-suppression@1` | 0.891× | 0.776–1.039 | 2/4 | Inconclusive, wide spread. |

Candidate C was selected: it preserved the split public surface and source semantics while repeatedly improving source and computed construction. It did not establish a safe reason to change computed node state, so computed fields and lazy/equality behavior were retained. The selected architecture is a structural improvement, not a claim that all hot paths were recovered.

## Effect and inactive-scope experiment

The experiment guarded `withoutAllRenderCollection` when both local render and speculative collectors were inactive, while still running `withoutComponentRenderCollection` for local/shared collector isolation. The paired medians (guard/control throughput) were:

| Workload | Median | Q1–Q3 | Faster pairs | Decision |
| --- | ---: | ---: | ---: | --- |
| `effect/fanout@1` | 1.030× | 0.983–1.075 | 3/4 | Noisy. |
| `effect/fanout@16` | 1.027× | 0.785–1.393 | 2/4 | Noisy. |
| `effect/fanout@64` | 0.974× | 0.920–1.079 | 1/4 | No repeatable benefit. |

The guard was removed from production code because none of the three results passed the repeatability gate. The added React regression test remains: it checks that untracked reads do not leak into active render/speculative collectors and that collection resumes after a throwing callback.

## Final M1.2 measurement

The final run is `benchmarks/phase9/results/m1.2-2026-09-27-candidate-c/`. It used the frozen M1b iteration file, Node `v24.21.0`, Windows x64 on AMD Ryzen 7 PRO 6850U, eight rounds, three warmups, seven samples, sizes 1/16/64, and three 1,000-node allocation rounds. The four-runtime schedule was two complete balanced cycles. All 958 planned tasks completed, with zero failures. `analysis.json` passed the strict analyzer. The manifest records start HEAD, start-of-run dirty paths, input-tree SHA-256 `50256c2282e1b44ac8f8971c2c87f4b61f18a82f2e234bf5c7e00cbe3991d4d7`, built-dist SHA-256 `bd3d508e768b275980d1cb6c896117e05a269de8ad4d10b0024b1485d618cd93`, and the unchanged frozen iteration-file hash.

The primary ratio is the median of paired per-round process medians (`current / v0.1.1`). “Faster” is the number of paired rounds above 1. IQR is across the eight paired ratios. M1b values below are read from the accepted authoritative M1b analysis; the raw M1b directory was not modified.

| Case | M1b ratio | M1.2 ratio | M1.2 faster rounds | M1.2 IQR | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| `source/create@1` | 0.198 | 0.606 | 1/8 | 0.065 | Recovered about 3.1× relative throughput; still 39% below v0.1.1. |
| `source/read@1` | 0.698 | 0.645 | 1/8 | 0.067 | Small recovery; still 35% below. |
| `source/unobserved-write@1` | 0.807 | 0.879 | 2/8 | 0.078 | Improved relative to M1b; remains below parity. |
| `source/write-read@1` | 0.751 | 0.886 | 3/8 | 0.389 | Improved relative to M1b; spread is wide and it remains below parity. |
| `computed/create@1` | 0.581 | 1.624 | 7/8 | 0.619 | Large recovery; improvement direction is repeatable, magnitude varies. |
| `computed/dirty-read@1` | 0.654 | 0.631 | 0/8 | 0.316 | No recovery; stable regression remains. |
| `computed/dirty-unread@1` | 1.388 | 1.264 | 5/8 | 0.937 | Positive result preserved, but high spread makes direction unstable. |
| `computed/equality-suppression@1` | 0.781 | 0.994 | 4/8 | 0.361 | Median is in rough parity; noisy/inconclusive by spread and direction. |
| `effect/fanout@1` | 0.678 | 0.789 | 2/8 | 0.236 | Still below parity; noisy. |
| `effect/fanout@16` | 0.826 | 0.728 | 0/8 | 0.152 | Repeatable regression; worse ratio than M1b. |
| `effect/fanout@64` | 0.721 | 0.583 | 0/8 | 0.189 | Large repeatable regression; worse ratio than M1b. |
| `effect/observed-write@1` | 0.764 | 0.914 | 3/8 | 0.236 | Partial recovery; remains below parity. |
| `effect/dynamic-dependencies@1` | 0.875 | 0.878 | 3/8 | 0.374 | Unchanged and noisy. |
| `batch/two-writes-one-reaction@1` | 0.794 | 0.749 | 3/8 | 0.655 | Unstable; no supported regression or improvement claim. |
| `rfsg/deepSignal-read@1` | 1.222 | 1.005 | 4/8 | 0.333 | Median rough parity, no repeatable direction. |
| `rfsg/deepSignal-watched-leaf-write@1` | 0.875 | 0.924 | 3/8 | 0.411 | Partial recovery, noisy and still below parity. |
| `rfsg/react-bare-tracking@1` | 1.015 | 0.914 | 3/8 | 0.368 | Modest regression with broad spread. |
| `rfsg/react-managed-tracking@1` | 1.008 | 0.879 | 1/8 | 0.089 | Repeatable modest regression. |
| `rfsg/react-useSignalValue@1` | 0.988 | 0.985 | 4/8 | 0.435 | Rough-parity median; high spread. |
| `rfsg/react-jsx-direct-binding@1` | 1.129 | 1.043 | 4/8 | 0.742 | Rough-parity median; high spread. |

Rough parity is symmetric: `0.95 <= median current/v0.1.1 <= 1.05`, subject to spread and direction. Ratios above 1.05 are not automatic improvements; this run's computed creation gain is repeatable, while no separate improvement release gate applies. Alien and Vue remain contextual only. For example, current source creation remains much slower than both; computed creation improved substantially but remains slower than Alien/Vue; current fan-out at 16/64 is slower than both contextual references. Those ratios do not alter the paired release comparison.

## Allocation, bundle, and representation impact

The coarse GC/heap diagnostic medians are directional only, not allocation rates or a release score. The combined 1,000-source/computed/effect graph's live/retained deltas moved from 1,858,056/331,328 bytes in M1b to 1,466,936/264,440 bytes in M1.2. Corrected `deep-watched-leaves` moved from 3,731,280/3,657,464 to 3,352,272/411,000 bytes. The post-setup-frame retained value is much lower; do not treat these process-heap estimates as exact per-object allocations.

Structural changes: the public wrapper, internal node, frozen protocol object, public brand, local-identity `WeakSet`, and deepSignal identity sets remain. The wrapper-to-node `WeakMap` entry is removed; two per-readable protocol closures are removed. There is no computed feature sidecar and no public API or production Alien boundary change.

`pnpm size` passed every existing budget. The full entry's gzip size is 11.48 kB against 11.69 kB; JSX runtime is 9.06 kB against 9.38 kB; deep entry is 10.32 kB against 10.38 kB. The runtime build reports 367.93 kB across generated files. No accepted byte-for-byte pre-M1.2 bundle snapshot was available for a direct delta comparison.

## Correctness and validation

- Candidate C targeted suites: 120 tests passed across core, runtime surface, subscription, and deepSignal files; typecheck and candidate build passed.
- Candidate A failed two of three existing runtime-surface checks and was rejected.
- Final full runtime suite: 21 files / 283 tests passed.
- Transform plugin suite: 3 files / 221 passed / 3 skipped.
- Consumer package smoke passed, including a genuine three-copy interop/effect smoke; Phase 4 duplicate-runtime smoke passed.
- Playwright browser/production/React Router suite: 27 passed.
- `pnpm typecheck`, `pnpm lint`, runtime build, `pnpm size`, and Phase 9 smoke passed. Lint reports existing warnings but no errors. The final `git diff --check` is recorded with the delivery validation.

## Outcome and M2 recommendation

| Subsystem | Classification |
| --- | --- |
| Source wrapper/node lookup and protocol setup | Structurally improved and accepted; meaningful creation gain, with read/write gaps remaining. |
| Computed node state | Current structure retained; protocol/lookup changes improve creation without a separate computed rewrite. |
| Computed dirty read | Remaining unexplained optimization opportunity. |
| Effect fan-out 16/64 | Remaining unexplained optimization opportunity; repeatable and material. The tested safe inactive-scope guard was not retained. |
| React paths | Mixed: two hook paths have rough-parity medians, while bare/managed paths show modest negative medians and spread varies. |
| Bundle/allocation | Bundle budget satisfied; heap diagnostics directional. |

M1.2 recovered source creation materially and computed creation beyond v0.1.1 parity. It did not resolve the repeatable fan-out 16/64 regression, source creation/read gaps, computed dirty-read gap, or managed React regression. These are not proven semantic costs, and no tested safe one-line scope fix passed. **Recommendation: proceed to M2 before release hardening, starting with a narrow causal investigation of effect fan-out and then source read/creation and managed React tracking.** Keep alien-signals/system, public semantics, render/speculative isolation, and dependency tracking intact. Do not treat M1.2's descriptive medians as a new release gate and do not begin M2 as part of this report.
