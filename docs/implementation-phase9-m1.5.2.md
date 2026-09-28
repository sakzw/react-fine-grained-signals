# Phase 9 M1.5.2 — Production-shaped Alien-derived runtime

## Decision and scope

Starting HEAD was `bbf82960de5efdb5d258218e477dcfdc43b4e286` (`feat: add Phase 9 M1.5.1 owner candidate`); local and `origin/main` agreed at the start. This milestone ports the M1.5.1 direction into the actual production source, package build, declarations, and consumer paths. No public API names changed and M2 did not begin.

**Decision C:** the production-shaped candidate is valid and substantially improves several old-production paths, but stable computed dirty-read/equality and effect-fanout regressions justify one narrow M1.5.x follow-up before the architecture is frozen. Target the extra production integration work on ordinary computed dirty reads/equality and effect fan-out, against the M1.5.1 owner candidate, while preserving render, interop, cleanup, and scheduler semantics. This is not a reason to reopen the graph architecture or redesign DeepSignal broadly.

## Production layout

```text
Public signal / React / DeepSignal APIs
                 |
     Alien-derived graph core (once)
       /          |            \
 execution    foreign-readable   render/speculative
   owner          bridge              adapter
       \          |             /
              React adapter
```

| Responsibility | Production files |
| --- | --- |
| Alien-derived graph and public signal/computed objects | `src/core/alien-derived-runtime-core.mts`, `src/core/alien-derived-types.ts` |
| Lexical shared execution owner | `src/core/execution-owner.ts` |
| Readable V1 bridge and owner context | `src/core/foreign-readable-v1.mts`, `src/core/interop-context.mts` |
| Attempt-local render/speculative state | `src/core/render-runtime.mts`, `src/core/render-tracking.ts` |
| React hooks and adapter | `src/react/react-adapter.mts`, `src/react/use-signals.ts` |
| DeepSignal adapter integration | `src/core/deep-signal.ts`, `src/core/base.ts` |

The graph core is derived from Alien Signals 3.2.1 (`8734d386d925025d0e99419bd9161c17b112c5ee`), imports only `alien-signals/system`, and is distributed with `LICENSE-ALIEN-SIGNALS.txt`. It retains Alien-style dependency links, cleanup/reuse, lazy computed invalidation, queue/flush, and pending/current values, with RFSG `Object.is`, error recovery/containment, and cleanup behavior. A public signal/computed stays one object plus a private graph node; graph fields are not exposed as enumerable public state.

The shared owner is the internal versioned V2 lexical contract (`graph`, `render`, `untracked`), with `try/finally` restoration. Foreign-readable V1 (`version`, runtime token, revision, subscribe) remains a separate protocol; foreign graph bridges are created lazily on consumption. Render snapshots, speculative computed values, promotion, and commit validation remain attempt-local. React adapters are imported by the hook entry rather than the signal-only graph entry, keeping React out of a signal-only import graph. DeepSignal continues to use `createDeepSignalFactory()` and derives subscriber/speculative behavior through the new adapter. The old RFSG graph/scheduler/lifecycle and render-watcher implementation was removed from production runtime modules after its consumers migrated. `alien-signals` remains a normal dependency because actual package output leaves `alien-signals/system` external; the consumer and duplicate-copy paths validate that topology.

Public root, `/runtime`, `/utils`, `/jsx-runtime`, `/jsx-dev-runtime`, and unplugin contracts remain intact. No benchmark-only modules are exported. Tests cover the established signal/computed/effect, React render/commit, DeepSignal, foreign-readable, duplicate-package, consumer, and browser semantics.

## Validation and package shape

The focused runtime/SSR run passed **56/56**. Final full validation after the effect fast-path correction passed: `pnpm typecheck`; `pnpm lint` (warnings only); `pnpm test` (**504 passed, 3 skipped**); `pnpm build`; `pnpm test:phase4-duplicate`; `pnpm test:consumer`; `pnpm test:browser` (**27 passed**); `pnpm size` (all budgets satisfied); and `git diff --check`.

The comparison uses the existing built pre-migration production package in `benchmarks/phase9/m15/current-dist` and the actual candidate `dist`, bundled with the same Vite scenario settings. Values are raw / gzip bytes:

| Entry scenario | Previous production | M1.5.2 | gzip change |
| --- | ---: | ---: | ---: |
| Signal only | 23,038 / 6,124 | 22,529 / 6,432 | +308 (+5.0%) |
| Core | 23,217 / 6,167 | 22,701 / 6,468 | +301 (+4.9%) |
| Core + hooks | 27,671 / 7,506 | 28,115 / 8,067 | +561 (+7.5%) |
| Deep | 41,583 / 10,630 | 42,457 / 11,235 | +605 (+5.7%) |
| Full index | 45,931 / 11,815 | 47,828 / 12,671 | +856 (+7.2%) |
| JSX runtime | 32,813 / 9,319 | 32,826 / 9,781 | +462 (+5.0%) |
| Utils | 27,397 / 7,434 | 27,783 / 7,923 | +489 (+6.6%) |

Tree-shaking marker checks pass. The added compressed size is consistent across entries and modest enough to accept for this candidate; it is not hidden by dependency bundling. `scripts/size-budget.json` reflects the updated candidate limits.

Allocation checks are coarse retained-heap diagnostics (three rounds), not allocation rates. Combined signal/computed/effect graph: candidate live median **1,677,856 B**, retained **301,840 B**; v0.1.1 **1,950,768 B**, retained **203,960 B**. One source + 1,000 effects: candidate live **422,512 B**, retained median **382,536 B**, but retained rounds (382,536 / 386,512 / 116,944) are noisy; v0.1.1 retained **83,120 B**. DeepSignal 1,000 watched leaves: candidate live **3,699,856 B**, retained **539,424 B**; v0.1.1 live **3,213,256 B**, retained **297,568 B**. DeepSignal retention is an optimization signal, not a release threshold by itself.

## Focused integration diagnostics

These are 24 paired fresh-process exploratory rounds, each with three warmups and seven samples, using frozen Phase 9 iteration counts. The ratios in this subsection are **duration ratios** (lower is faster), not the throughput ratios in the final matrix.

* Source/read: production / M1.5 core median **1.143x** (Q1 0.750, Q3 1.711); production / v0.1.1 **1.107x** (0.909, 1.307). Wide spread makes the source result inconclusive; the production integration did not clearly worsen the M1.5.1 source path. The getter now reuses its captured owner and avoids render dependency resolution when no render collector is active.
* Computed dirty-read: production / M1.5 core **2.672x** (2.067, 3.003); equality suppression **2.387x** (2.111, 3.155). A narrow fast-path experiment did not produce a meaningful paired gain and was reverted. Normal computed execution has no render-map lookup, but residual integration cost remains concrete.
* Effects after removing a redundant `checkDirty()` for already-dirty effects: observed write production / M1.5 core **2.263x**, dynamic dependencies **1.624x**, fan-out 16 **1.497x**, fan-out 64 **1.673x**. Against the M1.5.1 integrated owner candidate, fan-out 16/64 are **1.082x / 1.167x**. The fast-path correction materially narrows the gap, but the final matrix still shows fan-out regressions versus v0.1.1.

Raw diagnostic records and summaries are in `benchmarks/phase9/m15/m152-*-audit-*.json` and `m152-production-diagnostic-*`. The measured comparisons use the actual production build, not benchmark-only candidate modules.

## Final authoritative matrix

The final run is [`m1.5.2-2026-09-28-production-alien-derived-final`](../benchmarks/phase9/results/m1.5.2-2026-09-28-production-alien-derived-final/). It used eight balanced rounds, three warmups, seven samples, the frozen M1b iterations, and three allocation rounds. The manifest records the runtime hash and exact order. There were 958/958 tasks completed, 6,096 sample rows (5,992 successful and 104 expected N/A), 30 allocation rows, and zero failures. The primary values below are **paired throughput ratios / v0.1.1**: `1.00` is parity, greater than one is faster, less than one is slower. M1.5.2 values come from its final authoritative run. M1.5.1 values are reciprocals of the recorded M1.5.1 duration ratios against v0.1.1; they are not production-vs-M1.5.1 ratios. Old production values come from the earlier M1b throughput matrix. M1.5.1 did not include React cases, so those values are unavailable. Size-specific fan-in/fan-out rows are shown independently.

| Workload | Old production | M1.5.1 research | M1.5.2 production | Interpretation |
| --- | ---: | ---: | ---: | --- |
| source/create | 0.198 | 0.719 | 0.692 | Faster than old; slower than v0.1.1 |
| source/read | 0.698 | 0.706 | 0.761 | Similar to M1.5.1; stable gap to v0.1.1 |
| source/unobserved-write | 0.807 | 1.877 | 0.859 | Faster than old; parity gap remains |
| source/write-read | 0.751 | 1.330 | 0.768 | Similar to old |
| computed/create | 0.581 | 0.794 | 0.950 | Near parity; large improvement over old |
| computed/dirty-read | 0.654 | 1.033 | 0.571 | Material stable regression; follow-up |
| computed/dirty-unread | 1.388 | 1.728 | 1.153 | Noisy improvement; do not over-claim |
| computed/equality-suppression | 0.781 | 1.243 | 0.623 | Material stable regression; follow-up |
| effect/create | 0.967 | 0.883 | 0.738 | Slower than v0.1.1, faster than old |
| effect/observed-write | 0.764 | 1.194 | 0.687 | Similar to M1.5.1 and old |
| effect/dynamic-dependencies | 0.875 | 1.032 | 0.786 | Stable moderate regression |
| effect/fanout@1 | 0.678 | 0.988 | 0.575 | Material regression |
| effect/fanout@16 | 0.826 | 1.011 | 0.648 | Material regression; follow-up |
| effect/fanout@64 | 0.721 | 0.929 | 0.669 | Material regression; follow-up |
| batch/two-writes-one-reaction | 0.794 | 1.060 | 0.599 | Material regression |
| DeepSignal read | 1.222 | 1.172 | 0.955 | Near parity; M1.5.2 improves over M1.5.1 |
| DeepSignal watched leaf write | 0.875 | 0.969 | 0.929 | Near parity |
| React bare | 1.015 | n/a | 0.990 | Rough parity |
| React managed | 1.008 | n/a | 0.960 | Rough parity; wide spread |
| useSignalValue | 0.988 | n/a | 0.923 | Rough parity |
| JSX direct | 1.129 | n/a | 0.930 | Rough parity / small regression |
| computed/source-to-many@1 | 0.694 | 0.962 | 0.658 | Material regression |
| computed/source-to-many@16 | 0.732 | 1.150 | 0.808 | Improvement over M1.5.1 |
| computed/source-to-many@64 | 0.869 | 1.488 | 1.003 | Rough parity |
| computed/many-to-one@1 | 0.628 | 1.420 | 0.997 | Near parity |
| computed/many-to-one@16 | 0.836 | 0.932 | 0.926 | Small regression / broad spread |
| computed/many-to-one@64 | 0.843 | 0.935 | 1.233 | Noisy apparent improvement; broad spread |

The candidate is clearly better than old production in source creation, computed creation, DeepSignal reads, and several scaling cases; React remains around parity. It also retains material and repeatable deficits in ordinary computed propagation and effect fan-out/batching. The corrected M1.5.1 normalized ratios suggest stronger computed dirty-read/equality and some fan-out paths, but those are separate runs rather than direct paired M1.5.1-to-M1.5.2 comparisons. That comparison motivated the focused follow-up while retaining the selected graph core. Full round distributions and contextual Alien/Vue comparisons are in `analysis.json`; this table does not combine workloads into a score.

## Compatibility, validation, and next step

Alien stays in normal `dependencies`: generated package bundles leave `alien-signals/system` external, so consumers need the runtime package. Consumer installation and three-copy duplicate-package tests passed; removing it or making it peer-only would be inconsistent with the emitted package boundary. The pinned upstream license is included.

Final validation after the last runtime change:

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

The production architecture is accepted as the M1.5.x direction, with one focused computed/effect hot-path follow-up required before it is frozen. M2 should not begin yet. Once that follow-up resolves or explicitly accepts the repeatable core regressions and final architecture review is complete, M2 may begin. No M2 work is included here.
