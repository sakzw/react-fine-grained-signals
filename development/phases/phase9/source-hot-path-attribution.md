# Phase 9 — Source Hot-Path Cost Attribution

## 1. Motivation and decision

This experiment isolates RFSG-specific work paid by ordinary source reads and writes. The current production runtime removed Alien's high-level signal wrapper but still trailed RFSG v0.1.1 in the M1.5.4 authoritative matrix. The prior ratios were approximately `0.802` for source creation, `0.876` for source reads, `0.936` for unobserved writes, and `0.949` for write/read.

**Decision A:** ordinary read dispatch and the per-write DeepSignal classification lookup explain most of the measured read and unobserved-write regression. When those paths are stripped in benchmark-only copies, the current Alien-derived graph is at least in the same performance class as v0.1.1 and Alien 3.2.1. This does not justify removing ownership, render, or DeepSignal semantics. It supports moving uncommon bookkeeping off the ordinary source hot path.

No production behavior changed. M2 and DeepSignal redesign remain out of scope.

## 2. Starting identity and measurement integrity

- Verified local `main` and `origin/main`: `a6afcbc1e79573272b25740a5066d8429d32e1f5` (`perf: investigate DeepSignal with paired A/B benchmarks`).
- Released reference: tag `v0.1.1`, commit `0e12bbf46ab098fbb2388704ab85c3c406189cbb`.
- Runtime: Node `v24.21.0`, Windows x64, AMD Ryzen 7 PRO 6850U.
- Frozen Phase 9 iterations: [`benchmarks/phase9/m1b-iterations.json`](../../../benchmarks/phase9/m1b-iterations.json), SHA-256 `fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`.
- Current production runtime inputs SHA-256: recorded in [`manifest.json`](../../../benchmarks/phase9/source-hot-path/results/diagnostic-2026-09-29/manifest.json) as `sourceRuntime.inputsSha256`.
- Current built control JavaScript artifact SHA-256: recorded in the same manifest as `sourceRuntime.controlArtifactSha256`.
- Each worker was a fresh Node process with 3 warmups, 7 measured samples, and `global.gc()` immediately before each warmup and sample. Pairs used balanced AB/BA order. Iteration counts were shared and frozen across runtimes. No outlier removal was performed.
- The runner rechecked production source inputs, the R0 built artifact, and the frozen iteration file before and after every pair. All benchmark workers completed successfully. R5's write/read semantic preflight was correctly rejected and marked not applicable because that upper bound intentionally skips graph settling.

The harness and raw observations are under [`benchmarks/phase9/source-hot-path/`](../../../benchmarks/phase9/source-hot-path/). The full run manifest and raw rows are in [`results/diagnostic-2026-09-29/`](../../../benchmarks/phase9/source-hot-path/results/diagnostic-2026-09-29/). The confirmation screen logs and filtered V8 trace artifacts are also preserved in `results/`.

## 3. Exact source read paths

### Current RFSG, owner-free local source read (R0)

The source getter in `src/core/alien-derived-runtime-core.mts` executes this path for the ordinary benchmark workload:

1. Read the private `this.#node` field.
2. Read `executionContext.owner` and compare it with `undefined`.
3. In the owner-free branch, call `readSource(node)`.
4. `readSource` reads `source.flags`, masks `Dirty`, and branches. For the clean ordinary source, it skips `updateSource` and propagation.
5. Read the module-level `activeSub` and branch. It is undefined for this unobserved local read, so skip `linkNode`.
6. Read and return `source.currentValue`.
7. Read the module-level `activeRenderCollector` and branch. It is undefined, so skip `trackRenderDependency` and `getRenderDependency`.

Per ordinary read, the executed work includes one private-field read, one execution-owner module/object read and branch, one `readSource` function call, a dirty test, one active-subscriber module read and branch, one `currentValue` field read, and one render-collector module read and branch. No WeakSet or WeakMap lookup is made on this path. The owner/render operations are present even when their semantics are inactive.

### RFSG v0.1.1 source read

`SignalImpl.value` in `src/core/base.ts` executes:

1. Read the private `#renderSubscription` field and call `RenderSubscription.track()`.
2. `track()` calls `trackRenderDependency(this)`.
3. `trackRenderDependency` reads `activeRenderCollector` and branches. With no collector it returns `false`.
4. Call the private Alien signal function `this.#source()` to record graph tracking or return its cached value.
5. Read and return `#currentValue`, which preserves RFSG's `Object.is` value semantics.

Thus v0.1.1 has a subscription method call, a render tracking function call and branch, the Alien callable read, and a private cached-value read. It does not perform the current runtime's execution-owner check or make an RFSG `readSource` call.

### Alien Signals 3.2.1 high-level source read

`signal(initialValue)` returns `signalOper.bind(node)`. An ordinary read calls that bound function with no arguments. `signalOper` takes its read branch, checks the Dirty flag and updates only if dirty, reads `activeSub`, links only when there is a subscriber, and returns `this.currentValue`. It has no RFSG public getter, private-field access, owner dispatch, render collector dispatch, or separate `readSource` helper. Its callable API and equality semantics are not identical to RFSG's.

## 4. Read operation comparison

| Cost | Current R0 | v0.1.1 | Alien 3.2.1 |
| --- | --- | --- | --- |
| Private field reads | `#node` once | `#renderSubscription`, then `#source`, then `#currentValue` | None at RFSG layer; bound `this` node fields |
| Module/global state reads | `executionContext.owner`, `activeSub`, `activeRenderCollector` | `activeRenderCollector` through `track()` | `activeSub` |
| Inactive-dispatch branches | owner check, dirty check, subscriber check, render collector check | collector check, Alien dirty check | argument/read-vs-write, dirty check, subscriber check |
| WeakSet / WeakMap | None | None | None |
| Calls on ordinary read | `readSource` (plus property getter entry) | `track`, `trackRenderDependency`, Alien signal function | Bound `signalOper` |
| Revisions / flags | Dirty read; no revision write | None on read | Dirty read; no revision write |
| Subscriber checks | `activeSub` branch | Alien `activeSub` branch | `activeSub` branch |
| Interop / render | owner dispatch and collector dispatch checks | collector check | None |

The current `readSource` helper is not expensive merely because it is a helper: R0 still benefits from V8 optimization. R4 tests the function boundary while holding its graph logic constant.

### Executed-operation counts for an ordinary clean read

Counts below describe one successful source read in the benchmark's owner-free, render-free, graph-untracked state. They include conditional branches required to select this path, but not the public accessor entry or benchmark loop.

| Operation | Current R0 | v0.1.1 | Alien 3.2.1 |
| --- | ---: | ---: | ---: |
| RFSG private-field reads | 1 (`#node`) | 3 (`#renderSubscription`, `#source`, `#currentValue`) | 0 |
| Module/global state reads | 3 (`owner`, `activeSub`, collector) | 2 (collector and Alien `activeSub`) | 1 (`activeSub`) |
| Conditional branches on executed path | 4 (owner, Dirty, activeSub, collector) | 5 (track result, collector, argument/read selector, Dirty, activeSub) | 3 (argument/read selector, Dirty, activeSub) |
| Function calls | 1 (`readSource`) | 3 (`track`, `trackRenderDependency`, Alien callable) | 1 (bound `signalOper`) |
| WeakSet / WeakMap lookups | 0 / 0 | 0 / 0 | 0 / 0 |
| Subscriber checks | 1 (`activeSub`) | 1 (`activeSub`) | 1 (`activeSub`) |
| Ownership / render dispatch checks | 1 owner; 1 collector | 0 owner; 2 render tracking decisions | 0 / 0 |
| Revision or flag writes | 0 / 0 | 0 / 0 | 0 / 0 |

The v0.1.1 count has one extra branch versus the getter's visible `if` because `RenderSubscription.track()` itself calls the collector check; its Alien call also takes a read-versus-write branch.

## 5. Exact source write paths

### Current RFSG, ordinary unobserved write (W0)

1. Enter the public setter and read `this.#node`.
2. Call `inlineWrite(node, value)`.
3. `inlineWrite` calls `deepSignalNodes.has(node)`. For an ordinary source it returns false, but the WeakSet lookup and branch are still paid. `deepWatchedNodes.delete(node)` is not called for ordinary nodes.
4. Evaluate `Object.is(node.pendingValue, node.pendingValue = value)`. The pending value is written even before the equality branch is taken.
5. For a changed value, read `node.renderRevision`, branch on undefined, and increment it. Ordinary sources have `renderRevision: 0`, so the increment happens.
6. Write `node.flags = Mutable | Dirty`.
7. Read `node.subs` and branch. For an unobserved source it is undefined, so skip `propagate` and `flush`.

The ordinary write therefore pays the helper call, a `WeakSet.has` lookup and branch, `Object.is`, a pending-value write, the render-revision check and increment, the flag write, and a subscriber read and branch. It does **not** pay `deepWatchedNodes.delete` on the ordinary-source path.

### RFSG v0.1.1 source write

1. Read `#currentValue` and call `Object.is`; return early only for the same value.
2. For a changed value, compare the old value with `===` to detect `0` versus `-0` and select Alien's manual trigger path.
3. Write `#currentValue`, reset `#watchedSinceWrite`, and call the Alien signal function with the next value (or call `trigger` for signed-zero changes).
4. In `finally`, call `RenderSubscription.notify()`, which bumps its version and checks whether there are React listeners.

Alien's `signalOper` write branch writes `pendingValue`, sets Mutable/Dirty flags, checks subscribers, and conditionally propagates and flushes. v0.1.1 also performs its render subscription version notification on each write. It has no DeepSignal WeakSet classification and no current-runtime `renderRevision` property write.

### Alien Signals 3.2.1 high-level source write

The bound source function calls `signalOper(nextValue)`: its argument-count branch selects the write path; it compares and assigns `pendingValue` using strict inequality; then it writes flags, checks `subs`, and conditionally propagates and flushes. Alien uses its own equality behavior, so its result is contextual.

### Executed-operation counts for a changed, unobserved write

These counts describe one unique numeric write with no graph subscriber, no render listener, no active batch, and no DeepSignal classification. Calls include built-ins such as `Object.is`; they exclude the public setter entry.

| Operation | Current W0 | v0.1.1 | Alien 3.2.1 |
| --- | ---: | ---: | ---: |
| RFSG private-field reads | 1 (`#node`) | 6 across setter and render notification | 0 |
| Module/global state reads | 1 (`deepSignalNodes` binding) | 0 on the empty-subscriber path | 0 on the empty-subscriber path |
| Conditional branches | 4 (DeepSignal classification, equality, revision state, subs) | 6 (Object.is, signed zero, write selector, equality, subs, render listeners) | 3 (write selector, equality, subs) |
| Function calls | 3 (`inlineWrite`, `deepSignalNodes.has`, `Object.is`) | 4 (`Object.is`, Alien callable, `notify`, `bumpVersion`) | 1 (bound `signalOper`) |
| WeakSet / WeakMap lookups | 1 / 0; DeepSignal delete is skipped | 0 / 0 | 0 / 0 |
| Revision writes | 1 render revision | 1 render subscription version | 0 |
| Other flag writes | 1 node flag; pending value assigned | 1 watched flag; Alien pending value and node flag | Alien pending value and node flag |
| Subscriber checks | 1 graph `subs` check | 1 graph `subs` plus 1 render-listener check | 1 graph `subs` check |
| Ownership / interop checks | 0 | 0 | 0 |

The v0.1.1 private-field count is 2 cached-value reads, 1 source-function read, 1 render-subscription read, and the version/listener reads inside its notification. W1 removes the ordinary-path `WeakSet.has` call plus the `inlineWrite` call's classification branch; `deepWatchedNodes.delete` is not reached for ordinary sources in W0.

## 6. Write operation comparison

| Cost | Current W0 | v0.1.1 | Alien 3.2.1 |
| --- | --- | --- | --- |
| Private reads / writes | Setter `#node`; RuntimeNode `pendingValue`, `renderRevision`, `flags`, `subs` | `#currentValue`, `#watchedSinceWrite`, `#source`; render subscription fields | Bound node's `pendingValue`, `flags`, `subs` |
| Module/global state | `deepSignalNodes`, `runDepth`, `batchDepth` if subscribers exist | Alien's `activeSub`, queue/batch state as needed | `runDepth`, `batchDepth` as needed |
| Unconditional calls | `inlineWrite` | `Object.is`; signal function; render `notify` / version bump | bound `signalOper` |
| Equality | `Object.is` | `Object.is`, then `===` signed-zero check | strict inequality in Alien |
| Weak collection | `deepSignalNodes.has`; `deepWatchedNodes.delete` only if classified DeepSignal | None | None |
| Revisions / flags | Render revision increment, then Mutable/Dirty flags | Watched flag reset; render subscription version bump | Mutable/Dirty flags |
| Subscriber check | `node.subs` branch | Alien `subs` branch and render-listener branch | `subs` branch |
| Interop / render | Unconditional revision bookkeeping; propagation may flush | Unconditional render notification | None |

## 7. Ablation definitions

The builder starts with the current production `dist` JavaScript chunks and creates isolated copies under `benchmarks/phase9/source-hot-path/variants/`. It makes guarded, exact string replacements in the built core chunk; production source files are not edited. Each variant receives its own chunk files and SHA-256 manifest.

| Variant | Structural change | Semantic status |
| --- | --- | --- |
| R0 | Exact current production artifact | Control |
| R1 | Replaces the source getter's owner read with `undefined`; leaves the owner branch and all graph/render logic present | Owner-free diagnostic |
| R2 | Removes the source getter's active render collector lookup/branch | Diagnostic |
| R3 | Combines R1 and R2 | Owner-free, render-free diagnostic |
| R4 | R3 plus inlines the exact `readSource` dirty check, `activeSub` link check, and current-value return into the ordinary getter branch | Diagnostic, graph operations retained |
| R5 | R3 plus returns `node.currentValue` directly, skipping graph settling/linking | Unsafe read upper bound; only plain reads apply |
| W0 | Exact current production artifact | Control |
| W1 | Removes `deepSignalNodes.has` and its conditional from `inlineWrite` | Diagnostic; ordinary write no longer classifies DeepSignal nodes |
| W2 | Removes the `renderRevision` check and increment | Diagnostic; render/interoperability revisions are lost |
| W3 | Combines W1 and W2, keeping `Object.is`, flags, subscribers, propagate, and flush | Diagnostic |
| W4 | W3 bookkeeping-free write body moved into the setter, eliminating the `inlineWrite` call while retaining `Object.is` | Diagnostic graph-shaped write upper bound |

R1, R2, R3, R4, R5 and W1–W4 are diagnostic artifacts only. None was copied into production source.

The optional source-creation variants were not repeated: M1.5.4 already investigated representation and creation costs, and this task's main open attribution was read/write dispatch.

## 8. Screening results

Ratios are candidate/current throughput. Each measured row is 12 fresh-process pairs, 3 warmups and 7 samples per process. `Q1–Q3` and range are across paired candidate/current process-median ratios. Higher than 1 means the candidate was faster.

| Ablation | Workload | Median | Q1–Q3 | Min–max | Candidate faster |
| --- | --- | ---: | ---: | ---: | ---: |
| R1 | source/read | 1.150 | 1.120–1.230 | 1.010–1.650 | 12/12 |
| R1 | source/write-read | 1.010 | 0.970–1.050 | 0.810–1.110 | 7/12 |
| R2 | source/read | 1.050 | 0.960–1.310 | 0.620–2.460 | 7/12 |
| R2 | source/write-read | 0.900 | 0.800–1.160 | 0.680–1.370 | 5/12 |
| R3 | source/read | 1.310 | 1.040–1.460 | 0.670–1.850 | 9/12 |
| R3 | source/write-read | 1.080 | 0.860–1.180 | 0.650–1.780 | 7/12 |
| R4 | source/read | 1.400 | 1.250–1.590 | 0.830–2.100 | 11/12 |
| R4 | source/write-read | 1.030 | 0.930–1.160 | 0.850–1.330 | 7/12 |
| R5 | source/read | 2.830 | 2.500–3.360 | 1.720–4.760 | 12/12 |
| W1 | source/unobserved-write | 2.900 | 2.340–3.320 | 1.320–3.740 | 12/12 |
| W1 | source/write-read | 1.560 | 1.430–1.670 | 1.160–2.870 | 12/12 |
| W1 | effect/observed-write | 1.210 | 1.100–1.310 | 0.900–1.570 | 10/12 |
| W1 | computed/dirty-read | 1.030 | 0.730–1.250 | 0.640–1.490 | 6/12 |
| W1 | batch/two-writes-one-reaction | 0.980 | 0.780–1.310 | 0.590–1.680 | 6/12 |
| W2 | source/unobserved-write | 1.070 | 0.870–1.240 | 0.690–1.840 | 8/12 |
| W2 | source/write-read | 1.140 | 1.060–1.200 | 0.920–1.950 | 10/12 |
| W2 | effect/observed-write | 0.950 | 0.830–1.060 | 0.740–1.380 | 3/12 |
| W2 | computed/dirty-read | 0.960 | 0.860–1.130 | 0.550–1.320 | 5/12 |
| W2 | batch/two-writes-one-reaction | 1.120 | 0.780–1.220 | 0.580–1.440 | 7/12 |
| W3 | source/unobserved-write | 2.400 | 2.140–2.650 | 1.630–4.540 | 12/12 |
| W3 | source/write-read | 1.550 | 1.520–1.830 | 1.480–2.160 | 12/12 |
| W3 | effect/observed-write | 1.320 | 1.060–1.370 | 0.740–1.800 | 9/12 |
| W3 | computed/dirty-read | 1.120 | 0.860–1.420 | 0.710–1.530 | 8/12 |
| W3 | batch/two-writes-one-reaction | 1.140 | 1.030–1.390 | 0.810–1.580 | 9/12 |
| W4 | source/unobserved-write | 2.690 | 2.440–2.950 | 2.140–4.200 | 12/12 |
| W4 | source/write-read | 1.660 | 1.580–1.730 | 1.310–2.320 | 12/12 |
| W4 | effect/observed-write | 1.110 | 1.010–1.300 | 0.810–1.980 | 9/12 |
| W4 | computed/dirty-read | 1.110 | 0.910–1.170 | 0.840–1.580 | 7/12 |
| W4 | batch/two-writes-one-reaction | 1.190 | 0.780–1.430 | 0.650–1.740 | 8/12 |

R5 write/read was marked not applicable after its correctness preflight showed that direct cached-value reads do not settle the pending value. It is an upper bound, not a viable runtime. Its plain-read ratio must not be interpreted as a production improvement.

## 9. Ranked causal table

| Cost component | Read gain when removed | Write gain when removed | Confidence |
| --- | ---: | ---: | --- |
| Execution owner lookup (R1) | +15% median | — | High for owner-free workload; 12/12 faster, then captured inside R3/R4 confirmation |
| Render collector lookup (R2) | +5% median, noisy | — | Low alone; Q1 below parity and broad range |
| Owner + render dispatch (R3) | +31% median | — | Directionally strong; 9/12 screen pairs faster |
| Inlined `readSource` after R3 (R4) | R4 +40% vs R0; roughly +7% over R3 medians | — | Medium/high; R4 won 11/12 screen pairs and was faster in each confirmation median |
| DeepSignal WeakSet classification (W1) | — | +190% unobserved-write median; +56% write/read | High; all 36 confirmation unobserved-write pairs favored W1 |
| Render revision update (W2) | — | +7% unobserved-write; +14% write/read | Low/moderate; write/read Q1 > 1 but other affected controls were noisy or near parity |
| W1 + W2 (W3) | — | +140% unobserved-write | High direction; screen intervals overlap W1 and the measured combined median was below W1 |
| Direct setter body (W4) | — | +169% unobserved-write; +66% write/read | High screen direction, but it combines write bookkeeping removal and call-shape change |

Do not add these percentages. R3 exceeds the separate R1 and R2 medians, indicating dispatch interaction and/or V8 specialization effects. W3 was slower than W1 in the unobserved-write screen despite removing additional work; that difference is within the broad screening spread and points to interaction or JIT sensitivity. The confirmation isolates W1 as the reliable write-side cause.

## 10. Three-session confirmation

Each cell shows median ratio (Q1–Q3; min–max; candidate faster pairs). The ratio is confirmed candidate/current. Each session used 24 AB/BA fresh-process pairs per workload.

| Candidate/workload | Session 1 | Session 2 | Session 3 |
| --- | --- | --- | --- |
| R4 source/read | 1.400 (1.240–1.520; 1.040–2.530; 24/24) | 1.200 (1.010–1.320; 0.730–1.950; 18/24) | 1.300 (1.210–1.450; 0.900–1.950; 22/24) |
| R4 source/write-read | 1.130 (0.980–1.250; 0.800–1.800; 16/24) | 1.110 (0.930–1.290; 0.540–1.980; 16/24) | 1.090 (0.980–1.190; 0.620–2.390; 17/24) |
| W1 source/unobserved-write | 2.400 (2.190–2.570; 1.400–3.620; 24/24) | 2.130 (1.900–2.520; 1.510–3.220; 24/24) | 2.240 (1.780–2.450; 1.050–2.950; 24/24) |
| W1 source/write-read | 1.440 (1.280–1.660; 0.930–2.670; 23/24) | 1.610 (1.130–1.770; 0.820–3.040; 21/24) | 1.530 (1.390–1.660; 1.060–2.720; 24/24) |

R4 source reads beat current in all 72 paired rounds pooled across sessions, although session 2 was smaller and noisier. W1 unobserved writes beat current in all 72 paired rounds, with all three session medians between `2.13` and `2.40`. W1 write/read medians were also consistently faster, but spreads were wider.

## 11. Fresh comparison against v0.1.1

These are fresh-process comparisons, not historical absolute throughput. R4 and W1 were compared independently against a freshly loaded `react-fine-grained-signals@0.1.1` package artifact.

| Candidate/workload | Pairs | Candidate/v0.1.1 median | Q1–Q3 | Min–max | Candidate faster |
| --- | ---: | ---: | ---: | ---: | ---: |
| R4 source/read | 24 | 1.220 | 1.057–1.379 | 0.597–1.909 | 19/24 |
| R4 source/write-read | 24 | 0.934 | 0.785–1.050 | 0.558–1.562 | 7/24 |
| W1 source/unobserved-write | 24 | 1.892 | 1.728–2.041 | 1.300–3.324 | 24/24 |
| W1 source/write-read | 24 | 1.487 | 1.347–1.751 | 0.955–2.308 | 23/24 |

The direct fresh current/v0.1.1 baseline measured `0.885` for source/read, `0.881` for source/unobserved-write, and `0.978` for source/write-read. The first two confirm the historical regression direction; write/read was near parity in this session. R4's source read exceeds the fresh v0.1.1 median; W1 exceeds it substantially for both tested write workloads.

## 12. Alien 3.2.1 contextual comparison

Alien is contextual; its callable API and equality semantics differ from RFSG. The following ratios are candidate/Alien, with 12 fresh-process pairs each.

| Candidate/workload | Candidate/Alien median | Q1–Q3 | Min–max | Candidate faster |
| --- | ---: | ---: | ---: | ---: |
| R4 source/read | 2.218 | 1.961–2.493 | 1.186–2.748 | 12/12 |
| R4 source/write-read | 0.766 | 0.513–1.065 | 0.404–1.371 | 4/12 |
| W1 source/unobserved-write | 2.109 | 1.883–2.170 | 1.214–3.000 | 12/12 |
| W1 source/write-read | 1.042 | 0.891–1.532 | 0.664–2.424 | 7/12 |

For reference, current R0 measured `1.745` vs Alien on source/read, `0.882` on unobserved-write, and `0.966` on write/read. Thus the current graph is already faster than Alien for this read, and W1 moves ordinary unobserved writes well past Alien's performance class. Mixed write/read comparisons remain noisy and should not be treated as API-equivalent.

## 13. V8/JIT investigation

Filtered `--trace-opt --trace-deopt` runs used 200,000 operations and one measured sample after three warmups. In R0, both `readSource` and the source getter reached Maglev/TurboFan optimization; R4 optimized the getter with the read body inline. In W0 and W1, both `inlineWrite` and the setter optimized. Both write traces also showed optimized dependent code being marked for deoptimization with reason `embedded weak objects cleared` around forced-GC cycles. No trace showed a shape deoptimization unique to W0 or W1, nor did the traces establish a distinct inlining failure that explains the paired ratios.

The traces show that V8 optimizes both sides; they do not prove that WeakSet cost alone accounts for the full 2× result. The direct WeakSet lookup and branch are real ordinary-write operations, and W1's all-pair confirmation is causal evidence for their removal. The exact magnitude remains workload- and V8-version-specific. Raw logs are retained as `v8-W0.log`, `v8-W1.log`, `v8-R0.log`, `v8-R4.log`, and `v8-summary.txt` in the result directory.

## 14. Why removing the wrapper did not automatically make source operations faster

The wrapper removal took away one high-level object but the replacement's public getter and setter now host RFSG-specific requirements directly. Ordinary reads still inspect global owner state, enter a generic graph read helper, inspect active graph subscription state, and inspect React's render collector. Ordinary writes still classify every source through a DeepSignal WeakSet and update render revisions on every changed value. The simpler representation therefore paid more policy dispatch on the common path even after the extra wrapper object disappeared.

The old `SignalImpl` getter was not an expensive extra graph wrapper: its render collector check and direct call to Alien's bound `signalOper` were compact. The measurements confirm that removing an object layer alone does not establish a faster hot path.

## 15. Production-safe structural options

1. **Split ordinary writes from DeepSignal internal version writes.** Public sources should call a source write primitive that never performs `deepSignalNodes.has`. DeepSignal's internal per-key version signals can opt into the classification/liveness protocol at creation time and use a separate specialized writer. Preserve `Object.is`, current flush ordering, and the internal watched-node lifecycle.
2. **Revisit eager render revision state.** Current ordinary sources begin with `renderRevision: 0` and increment it on every write. Prototype revision state that is materialized only when a render/interop/foreign subscriber needs it. Prove render, foreign ownership, speculative render, and duplicate-copy correctness before adoption.
3. **Move uncommon read dispatch away from the owner-free common path.** R1/R2/R3 show the opportunity, but production still has to preserve same-copy graph tracking, foreign ownership, React render ownership, speculative render, `untracked`, and duplicate copies. Do not resurrect the rejected activity-mask design. A fast branch is viable only if its structural owner/collector guarantees are compatible with all those modes.
4. **Retain the graph read operations.** R4 still performs Dirty settling and active-subscriber linking inline and exceeds v0.1.1 and Alien on this source-read workload. The graph architecture is not the immediate read bottleneck.

These are directions for a separate implementation task. This report does not change production semantics.

## 16. Final answers

1. **Starting HEAD:** `a6afcbc1e79573272b25740a5066d8429d32e1f5`, verified equal to `origin/main`.
2. **v0.1.1 identity:** `0e12bbf46ab098fbb2388704ab85c3c406189cbb`.
3. **Read path:** current getter does private node read, owner read/branch, `readSource` call, dirty/subscriber checks and current value read, then collector read/branch. v0.1.1 calls `RenderSubscription.track`, checks the collector, calls Alien's source function, then returns its private cached value.
4. **Write path:** current setter calls `inlineWrite`, which classifies each source via `deepSignalNodes.has`, applies `Object.is`, writes render revision and flags, then checks subscribers. v0.1.1 applies `Object.is`, updates its cached value/watched flag, calls Alien, and bumps/notifies its render subscription in `finally`.
5. **R1:** `1.150×` source/read; `1.010×` write/read.
6. **R2:** `1.050×` source/read, noisy; `0.900×` write/read.
7. **R3:** `1.310×` source/read; `1.080×` write/read.
8. **R4:** `1.400×` source/read; `1.030×` write/read.
9. **R5 upper bound:** `2.830×` source/read; write/read is intentionally not applicable because it fails graph-settling semantics.
10. **W1:** `2.900×` unobserved-write; `1.560×` write/read.
11. **W2:** `1.070×` unobserved-write; `1.140×` write/read.
12. **W3:** `2.400×` unobserved-write; `1.550×` write/read.
13. **W4:** `2.690×` unobserved-write; `1.660×` write/read.
14. **Strongest read cause:** owner/render dispatch is the largest combined cost, with inlining `readSource` adding a further gain. R2 alone is noisy; R1 and R3 show the owner/dispatch effect.
15. **Strongest write cause:** unconditional `deepSignalNodes.has` classification on every ordinary write. It is the dominant screen and confirmation effect. Render revision updates are secondary and less stable.
16. **Three-session confirmation:** R4 read medians were `1.400`, `1.200`, `1.300`; W1 unobserved-write medians were `2.400`, `2.130`, `2.240`. W1 won all 72 paired write comparisons.
17. **Stripped candidate vs v0.1.1:** R4 read `1.220×`, W1 unobserved write `1.892×`, W1 write/read `1.487×`; R4 write/read remained `0.934×` and noisy.
18. **Stripped candidate vs Alien:** R4 read `2.218×`, W1 unobserved write `2.109×`, W1 write/read `1.042×` and noisy.
19. **Is the low-level graph itself exonerated?** Yes for ordinary source reads and unobserved writes in these workloads: stripped candidates outperform both v0.1.1 and Alien while retaining current graph read/propagation mechanics. The graph is not exonerated for every workload or semantic path.
20. **Do owner/render/DeepSignal checks explain the regression?** Mostly. Owner/render dispatch explains the read gap; DeepSignal classification explains most of the unobserved-write gap. Revision bookkeeping contributes less. The v0.1.1 gap is recovered in the stripped read and write candidates.
21. **Smallest production-safe direction:** split ordinary public-source writes from DeepSignal version-source writes so ordinary signals avoid `deepSignalNodes.has`. Separately prototype structurally safe owner/render read dispatch changes while retaining all ownership modes.
22. **Another implementation task before v0.2?** Yes: a focused, correctness-gated hot-path implementation task is justified before v0.2. Keep DeepSignal's representation unchanged in that task unless new evidence requires a separate proposal.
23. **Files changed:** this report, the benchmark-local variant builder and runner/worker, variant artifacts/manifests, and raw results. `src/**` and production semantics remain byte-identical; no commit or push was made.
