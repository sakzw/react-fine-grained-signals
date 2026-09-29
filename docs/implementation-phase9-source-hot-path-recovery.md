# Phase 9 — Source Hot-Path Production Recovery

## Starting identity and attribution evidence

The work starts at `6d18a71be72a3a26f09a6b541a8bd2534b110553`; local `main`, `origin/main`, and GitHub `main` matched before source changes. The exact source-path measurements and prior Phase 9 interpretation are in [the attribution report](implementation-phase9-source-hot-path-attribution.md), [the DeepSignal A/B report](implementation-phase9-deep-signal-ab.md), and [M1.5.4](implementation-phase9-m1.5.4.md).

The strongest write diagnostic removed only the DeepSignal `WeakSet.has` classification from ordinary writes. It won all 72 confirmation pairs and measured at 1.892× v0.1.1 for unobserved writes and 1.487× for write/read. The strongest read diagnostic R4 measured 1.220× v0.1.1 for source/read, but it bypassed required owner/render dispatch and is not a production design. Fresh current/v0.1.1 source ratios were 0.885 read, 0.881 unobserved-write, and 0.978 write/read.

## Stage 0 — Source and DeepSignal relationships

| Entry point | Readable represented | Required behavior |
| --- | --- | --- |
| `signalClassBrandHelper` → `createBrandedSignal` | Public ordinary signal backed by a local `RuntimeSource` | Ordinary setter must preserve `Object.is`, Dirty/Mutable flags, graph propagation/flush, render revision, ReadableInterop publication, and `peek()`. It has no DeepSignal liveness metadata. |
| DeepSignal factory `createSignal` → `coreRuntime.createDeepSignal` | Root source behind the public `DeepSignalImpl` wrapper | Root reads/writes retain the shared execution-owner, render, graph and interop behavior. Root replacement is distinct from per-property metadata. |
| DeepSignal factory `createVersionSignal` → `coreRuntime.createDeepSignalVersion` | Internal property-value, existence, and iteration version sources | Writes clear their `deepWatchedNodes` marker before equality handling, then preserve the ordinary graph write semantics. The version source stays identifiable for post-notification pruning. |
| Deep engine `track` | Per-property/existence version source | When graph or render tracking is active, marks the version watched and reads it. Re-running after a removed property can re-arm this marker. |
| Deep engine `sweepPrunedKeys` | Removed property/existence metadata | After the batch flush, retains entries with graph subscribers or a re-armed DeepSignal watched marker; drops entries that have become unreachable. Array truncation uses the same path. |
| `getRenderDependency` / `attachProtocol` | Public and internal local readables | Attach a per-readable protocol lazily for render revisions/subscription and cross-copy ReadableInterop; foreign publication uses the readable protocol from the node. |

`deepSignalNodes` is a membership set used by the pruning fallback in `hasDeepSignalSubscribers`; it must not classify every public source write. `deepWatchedNodes` is a transient liveness marker for version signals. Ordinary signals need neither set. Root sources and per-property version sources both have DeepSignal semantics, but only version sources back prunable metadata.

## Read-mode matrix (frozen before read-path edits)

| Execution state | Current behavior to preserve | Candidate path |
| --- | --- | --- |
| Owner-free read with no render collector | Settle a dirty local source, link `activeSub` if present, return `currentValue` | Common local path; no ownership publication |
| Owner-free read with an independently installed local render collector | Perform the graph read, resolve/create the render dependency, and collect the current revision | Keep this fallback; tests install a collector without an execution owner |
| Same-copy graph owner | Use local graph settling and dependency linking; do not publish a foreign protocol | Cold owned helper, `readSource` semantics unchanged |
| Same-copy render owner with active attempt, managed or bare | Observe render revision and use the render adapter's speculative `pendingValue` path; do not link the live graph | Cold render helper |
| Same-copy render owner without active attempt | Use the local graph read and current subscriber behavior | Cold owned helper |
| Foreign graph owner | Read/settle locally and publish the local readable protocol/revision to the foreign owner | Cold foreign helper |
| Foreign render owner, managed or bare | Read/settle locally and publish the readable protocol/revision to the foreign render attempt | Cold foreign helper |
| `UNTRACKED_OWNER` | Read/settle locally without foreign publication or render-collector tracking | Cold owned helper; preserve owner identity |
| Duplicate package copies | Use the shared v2 execution owner and each copy's own graph/collector state; bridge through ReadableInterop V1 | Same owner checks and protocol publication |
| `untrackedRender` inside graph execution | Suppress render collection while preserving the enclosing graph owner/subscriber | Existing collector pause/owner semantics |

The read prototype may only move dispatch into a cold helper or inline the exact local graph read. It must not bypass any row in this matrix, introduce an activity mask, or change ReadableInterop or render revisions.

## Write-path implementation

The first production change removes `deepSignalNodes.has(node)` from the ordinary setter path. Ordinary signals call the normal graph write directly. A distinct internal DeepSignal source class uses a specialized writer that clears `deepWatchedNodes` and then performs the same graph write. DeepSignal root creation and per-key version creation are separate adapter operations; metadata pruning continues to recognize internal version nodes.

## Focused write evidence

The write A/B used frozen counts, fresh Node processes, three warmups, seven samples per process, 24 balanced AB/BA pairs per session, and three independent sessions for each primary. W0 is the built runtime before this production change; P0 is the structurally specialized candidate.

| Workload | P0/W0 session medians | Direction |
| --- | --- | --- |
| `source/unobserved-write` | 2.32×, 2.33×, 2.20× | 24/24 P0 wins in every session |
| `source/write-read` | 1.59×, 1.43×, 1.54× | 22/24, 21/24, 22/24 P0 wins |
| `effect/observed-write` | 1.13× | 14/24 P0 wins; noisy |
| `effect/fanout@16`, `@64` | 0.97×, 0.97× | Rough parity/noisy |
| `computed/dirty-read`, `equality-suppression` | 1.30×, 1.30× | No material regression |
| `batch/two-writes-one-reaction` | 1.12× | No material regression |
| `deepSignal/watched-leaf-write` | 0.97× | Rough parity/noisy |
| `deepSignal/many-watched-leaves@64`, `@1000` | 0.96×, 1.02× | Rough parity/noisy |

The direct fresh v0.1.1 write comparison used three sessions for each primary. `source/unobserved-write` medians were 1.99×, 2.09×, and 1.89×, with 24/24 P0 wins in every session. `source/write-read` medians were 1.41×, 1.41×, and 1.44×, with 22/24, 21/24, and 18/24 wins. The safe split materially recovers both ordinary write paths and does not show a repeatable control or DeepSignal write regression.

## Read candidates and decision

P1 moved the owner/render/foreign handling into `readOwnedSource` while leaving owner-free graph reads and the independently installable render collector intact. Against P0, `source/read` medians were 0.91×, 1.02×, and 1.03×; `source/write-read` was 0.98×. Controls did not show a consistent change.

P2 inlined the exact dirty-settle, `activeSub` link, and `currentValue` steps into the owner-free getter. Against P1, `source/read` medians were 0.98×, 1.02×, and 1.00×; controls remained near parity with broad spread. Both prototypes were rejected and removed from production source. P2 confirms that the `readSource` call boundary itself did not provide a repeatable recovery.

The owner-free path still has to distinguish an active execution owner and an independently installed render collector. Tests exercise collector installation without an execution owner, so removing that collector check would strand render dependencies. The owned path must preserve speculative render revision handling, foreign publication, duplicate-copy bridging, and `UNTRACKED_OWNER` behavior. The P1/P2 measurements support retaining these checks and stopping read-path experimentation in this task; no unsafe R4 behavior was copied.

## Full validation and artifacts

Focused correctness covered `tests/core.test.ts`, `tests/deep-signal.test.ts`, `tests/reactive-runtime.test.ts`, `tests/react-render-tracking.test.tsx`, `tests/runtime-surface.test.ts`, and `tests/cross-instance.test.tsx`: 134 tests passed. The full `pnpm test` passed 285 runtime tests plus 221 transform tests (3 skipped). One earlier concurrent run timed out one 5-second fan-out test while typecheck/lint ran alongside it; the isolated full rerun passed.

`pnpm typecheck`, `pnpm lint`, `pnpm build` (through `test:consumer`), `pnpm test:phase4-duplicate`, `pnpm test:consumer`, `pnpm test:browser`, `pnpm size`, and `git diff --check` passed. Lint retained existing warnings; new errors were fixed. Duplicate-runtime smoke passed with three independently bundled Alien systems. Consumer smoke passed its clean tarball and cross-copy tests. Browser e2e passed all 27 tests across Chromium, Firefox, WebKit, production bundle, and React Router.

The built P0 distribution is 379,307 bytes across all files versus 373,949 for W0 (+5,358 bytes). Across emitted JavaScript, raw size is 119,400 versus 117,558 bytes (+1,842); summed gzip is 32,952 versus 32,682 bytes (+270). All configured `pnpm size` budgets passed.

Three-run W0/P0 retained-heap checks at graph count 1,000 found median retained deltas of 225,416/226,632 bytes for a source-computed-effect graph, 91,000/91,280 for one-source fanout, and 460,904/461,544 for DeepSignal watched leaves. These coarse forced-GC values are directional and do not establish per-object costs. The P0 deltas from W0 are small; full candidate-v0.1.1 DeepSignal retention remains a separate historical architecture gap, not a new regression from this write split.

## Full eight-round candidate matrix

The final source candidate was measured against v0.1.1, Alien 3.2.1, and Vue 3.6.0-rc.9 using the frozen `m1b-iterations.json`, eight balanced rounds (two cycles), three warmups, seven samples, 1/16/64 graph sizes, and three allocation rounds. Because production runtime inputs differ from the c5 M1b baseline, this named candidate run used the documented `--runtime-inputs-sha256` identity guard and a new output directory; the original M1b run was not overwritten. The report is [the analyzer output](../benchmarks/phase9/results/source-hot-path-recovery-2026-09-29/analysis.json), backed by the manifest and raw JSONL in that directory.

The analyzer accepted all 958/958 planned tasks, 5,992 successful timing samples, 104 expected N/A records, 30 allocation rows, and zero failures. Paired current/v0.1.1 summaries for selected Class A paths were:

| Case | Median ratio | IQR | Faster rounds |
| --- | ---: | ---: | ---: |
| `source/read` | 0.84 | 0.31 | 2/8 |
| `source/unobserved-write` | 2.18 | 0.69 | 8/8 |
| `source/write-read` | 1.58 | 0.33 | 7/8 |
| `effect/observed-write` | 1.23 | 0.37 | 6/8 |
| `effect/dynamic-dependencies` | 0.90 | 0.28 | 2/8 |
| `computed/dirty-read` | 1.21 | 0.48 | 6/8 |
| `computed/dirty-unread` | 1.53 | 0.15 | 8/8 |
| `computed/equality-suppression` | 1.37 | 0.65 | 7/8 |
| `batch/two-writes-one-reaction` | 1.26 | 0.69 | 5/8 |

Two stable non-write regressions remain in the full matrix: `source/create` is 0.69× (IQR 0.10; 8/8 slower rounds), and `effect/create-dispose` is 0.80× (IQR 0.11; 8/8 slower rounds). Source read is below v0.1.1 at 0.84× but its wide IQR and 6/8 direction do not establish a stable material regression in this candidate run. The remaining creation regressions are not explained by this write split and require a separate M1.1 attribution before Phase 9 performance can be closed.

DeepSignal current/v0.1.1 results were noisy: read 1.06× (IQR 0.25), watched write 1.10× (IQR 0.46), each with 5/8 faster rounds. No new DeepSignal correctness blocker was found; watched-write behavior, property pruning, array truncation, duplicate-copy tracking, and React behavior passed the tests above.

## Phase 9 status

**Decision B — write recovery accepted, read behavior retained.** The ordinary writer no longer executes `deepSignalNodes.has()` or `deepWatchedNodes.delete()`; only the structurally specialized DeepSignal root/version writer clears liveness before the common graph write. The write recovery is safe and repeatable. Read specializations P1/P2 were rejected because neither materially helped. Owner and collector checks remain to preserve required render, ownership, speculative, interop, and duplicate-copy semantics.

Phase 9 performance is not closed: the full matrix also has stable source/effect creation regressions without causal attribution. Run targeted M1.1 attribution for those rows before release hardening. M2 must not begin from this result. No M2 or M1.1 implementation is included here.
