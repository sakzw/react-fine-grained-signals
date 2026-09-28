# Phase 9 DeepSignal A/B Investigation

## 1. Purpose and decision

This investigation compares the current `deepSignal` implementation with the published RFSG v0.1.1 package. It is a focused measurement follow-up to M1b-0, not a new release gate. The result is **Decision C: a material, repeatable regression in watched-leaf writes**, with a scale-specific signal in the many-watched-leaves workload. The read workload is at parity or slightly faster on current, so this is not an across-the-board regression.

The evidence justifies prototyping a Vue-inspired direct-Dep representation in an isolated branch **before v0.2**. This report does not implement that design. M2 and broad release hardening remain unstarted.

## 2. Compared artifacts and normal-harness verification

- Baseline: the actual npm package `react-fine-grained-signals@0.1.1`, pinned to tag commit `0e12bbf46ab098fbb2388704ab85c3c406189cbb` and loaded in each fresh worker process.
- Candidate: the production build from source HEAD `df56eb98fe1235963b60fa04d5f114ca6605aec5`. Runtime input SHA-256: `756b420b611e800883e30fe5e864e78fc0e9d35650c61e3a7deae3fdf95254ed`; dist SHA-256: `946e86786f36718f45b792d5d19e0e02e06b2183c21168490ae52fbb87198787` (26 files).
- The regular Phase 9 harness also starts a fresh process and loads the pinned v0.1.1 package for each baseline execution. Its comparison is not a lookup of previously cached timings. The focused runner used here follows the same fresh-process property and verifies the pins before running.
- The frozen primary iteration counts were read from `benchmarks/phase9/m1b-iterations.json` and its SHA-256 (`fb549096642e48eda6ba9f50485e67b41079d2178dbd2ba607c6931106d5f056`) is recorded in the run manifest.

No production runtime source or behavior was changed for this investigation.

## 3. Why the earlier eight-round result was insufficient

The accepted M1b result used eight paired rounds and showed broad spread, especially for reads. That is enough for its frozen interpretation contract, but not enough to distinguish a stable watched-write effect from workstation noise with high confidence. This follow-up adds three temporally separated sessions, more paired rounds, auxiliary workload shapes, and a focused allocation comparison. It retains every observation, including outliers.

## 4. Method and semantic preflight

Each runtime execution used a fresh Node process with `--expose-gc`, three warmups, then seven measured samples. `global.gc()` was called immediately before each warmup and measured execution. Each pair ran one A and one B process; order followed a deterministic schedule balanced to 12 `AB` and 12 `BA` in every 24-pair primary session, and six of each in the 12-pair auxiliary and allocation comparisons. No pause was inserted between pair processes. For each process, the median of its seven sample durations was converted to throughput; the pair ratio is current throughput divided by baseline throughput. A value above 1 means current is faster.

Before timed work, both runtimes passed the same semantic preflight: nested property updates; unread sibling isolation; add/delete invalidation for value, existence (`in`), and key iteration; array index extension and length truncation invalidation; alias/cycle preservation; and effect disposal. Each measured workload also checks its final state and exact reaction counts where applicable.

Primary counts are the frozen M1b counts: 50,000 reads and 8,657 watched-leaf writes. Auxiliary counts are recorded in the manifest. Every process retained all seven samples. No outlier was deleted.

## 5. Primary results by independent session

Values are throughput ratios `current / v0.1.1`. Each row reports median, Q1–Q3, IQR, full min–max, and pair directions (`current faster / v0.1.1 faster`).

| Workload | Session | Pairs | Median | Q1–Q3 | IQR | Min–max | Direction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Read | 1 | 24 | 1.058 | 0.970–1.165 | 0.196 | 0.721–1.438 | 16 / 8 |
| Read | 2 | 24 | 1.037 | 0.912–1.140 | 0.227 | 0.717–2.003 | 13 / 11 |
| Read | 3 | 24 | 1.066 | 1.005–1.163 | 0.158 | 0.853–1.454 | 18 / 6 |
| Watched-leaf write | 1 | 24 | 0.814 | 0.729–0.967 | 0.238 | 0.598–1.316 | 4 / 20 |
| Watched-leaf write | 2 | 24 | 0.861 | 0.760–0.948 | 0.188 | 0.585–1.761 | 4 / 20 |
| Watched-leaf write | 3 | 24 | 0.830 | 0.809–0.895 | 0.087 | 0.569–1.066 | 2 / 22 |

Descriptive pooling of all 72 pairs gives read median `1.060` (Q1–Q3 `0.971–1.163`, IQR `0.192`, range `0.717–2.003`, direction `47 / 25`) and watched-write median `0.837` (Q1–Q3 `0.783–0.949`, IQR `0.166`, range `0.569–1.761`, direction `10 / 62`). Pooling is descriptive; the three session results remain the primary repeatability check.

## 6. Read interpretation

Read medians are modestly above 1 in all sessions, but the session IQRs are wide and their ranges include substantial values on both sides of parity. The pooled direction favors current 47 to 25, while the size and spread do not support a strong improvement claim. Classify the read result as parity / slight possible improvement, with notable measurement noise.

## 7. Watched-write interpretation

All three session medians are below `0.90` (`0.814`, `0.861`, `0.830`), and baseline is faster in 20/24, 20/24, and 22/24 pairs respectively. The third session's entire Q1–Q3 interval is below parity. Although sessions 1 and 2 include some candidate-faster outliers, the direction and median deficit repeat across all three sessions. This is a material, repeatable watched-write regression, not just a pooled effect.

## 8. Auxiliary workloads

Each auxiliary row has 12 pairs, three warmups and seven samples per process. The measurements are diagnostic and do not independently define a release gate.

| Workload | Median | Q1–Q3 | IQR | Min–max | Direction (current / baseline faster) | Reading |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Create representative graph | 0.806 | 0.708–0.928 | 0.220 | 0.557–1.572 | 3 / 9 | Candidate slower; spread is substantial. |
| Nested tracked read on trigger update | 0.888 | 0.765–1.012 | 0.247 | 0.626–1.277 | 3 / 9 | Noisy; Q3 crosses parity. |
| Unwatched sibling write | 0.915 | 0.880–0.945 | 0.066 | 0.779–1.309 | 2 / 10 | Small repeatable deficit, with an outlier. |
| Many watched leaves, 16 | 0.946 | 0.894–0.975 | 0.081 | 0.806–1.031 | 2 / 10 | Small deficit. |
| Many watched leaves, 64 | 0.969 | 0.872–1.117 | 0.245 | 0.646–1.592 | 5 / 7 | Inconclusive/noisy. |
| Many watched leaves, 256 | 0.544 | 0.471–0.942 | 0.471 | 0.185–3.315 | 2 / 10 | Candidate appears slower, but extreme spread makes magnitude uncertain. |
| Many watched leaves, 1,000 | 0.635 | 0.602–0.816 | 0.214 | 0.486–1.154 | 1 / 11 | Large, directionally repeatable scale-specific deficit. |

The create case constructs representative input objects before timing and times only wrapping them with `deepSignal`. The nested tracked-read case times trigger updates, effect reruns, and nested reads together. The many-leaf cases keep a graph with one effect per leaf and distribute 20,000 writes round-robin over the selected leaf count; exact per-leaf reaction counts are checked.

## 9. Scaling signal

At 16 leaves the many-leaf median is near parity; 64 leaves is too noisy to interpret; 256 leaves has an apparent large deficit but extreme tails. At 1,000 leaves, median throughput is `0.635` of baseline, Q3 remains below parity (`0.816`), and baseline wins 11/12 pairs. This is useful evidence of a scaling target, while the 256-leaf spread cautions against fitting a precise scaling curve from these points.

## 10. Allocation comparison

The focused allocation check compared one root with 1,000 watched properties over 12 paired rounds using the existing Phase 9 forced-GC `deep-watched-leaves` methodology. All 12 observations for both runtimes verified graph shape and confirmed disposed effects stopped.

| Heap delta | v0.1.1 median (Q1–Q3; min–max) | Current median (Q1–Q3; min–max) | Paired current minus baseline median (Q1–Q3; min–max) |
| --- | --- | --- | --- |
| Live | 3,213,192 B (3,213,192–3,213,232; 3,213,168–3,213,256) | 3,317,540 B (3,317,416–3,317,728; 3,317,352–3,317,728) | +104,348 B (+104,214–+104,496; +104,160–+104,560) |
| Retained | 297,504 B (297,504–297,544; 297,480–297,568) | 460,968 B (460,904–461,216; 460,840–461,216) | +163,476 B (+163,390–+163,666; +163,288–+163,736) |

These are coarse heap deltas under this graph and methodology, not exact object counts or per-property costs. Their consistent positive paired differences support an allocation/representation investigation but do not establish a universal memory cost.

## 11. Noise and limits

All sessions ran on the same Windows x64 workstation and day, with approximately one minute of idle time between primary session invocations. They are separate runs, not separate machines or days. No CPU-load snapshot was collected. The manifest and raw JSONL retain timestamps, process IDs and durations, Node version, CPU model, exact pair order, and all samples. The wide read spread and the 64/256-leaf tails show that workstation noise remains material. No samples were excluded.

Environment: Node `v24.21.0`, Windows x64, AMD Ryzen 7 PRO 6850U. The measurements describe this environment and these workloads; they do not prove the same ratios on other machines or applications.

## 12. Direct-Dep decision before v0.2

**Yes: prototype a focused direct-Dep design before v0.2.** The justification is the repeatable watched-write deficit across three sessions, the 1,000-leaf scaling signal, and the higher measured live/retained heap deltas for the tested graph. Keep the prototype isolated and compare it against this workload suite and semantic preflight before considering adoption. This decision is a direction for the next engineering investigation, not approval to change public APIs or production behavior in this report.

M2 remains unstarted. This work does not begin broad M2 hardening, and it does not prescribe Vue's full implementation or a `DirectDep` production rewrite.

## 13. Decision and artifacts

**Final decision: C — material repeatable regression**, specifically for watched-leaf writes and the 1,000-leaf auxiliary workload. Reads remain near parity / possible slight current improvement. The results support a targeted representation prototype before v0.2, with no separate improvement release gate and no broad claim that every workload regressed.

The run completed with zero worker failures: 144 primary pairs, 84 auxiliary pairs, 3,192 measured sample rows, 24 allocation observations, and 12 allocation pairs. Raw inputs, manifest, exact process order, samples, pair ratios, failures, and generated summaries are preserved in [`benchmarks/phase9/results/deep-signal-ab-2026-09-29/`](../benchmarks/phase9/results/deep-signal-ab-2026-09-29/). The focused harness is in `benchmarks/phase9/deep-signal-ab-{runner,worker}.mjs`; integrity checks and summary generation are in `benchmarks/phase9/analyze-deep-signal-ab.mjs`.

This report and harness are local working-tree changes. No commit, push, rebase, merge, amend, or tag operation was performed.
