# M1.1b causal diagnostic records

These are diagnostic-only ablations against the unchanged current runtime at `07cdd91cafcbb1aef32348176b257140ae4cec0e` (runtime source baseline `c5d1796cfa2063db7eecb99e537209de185a530c`). They do not modify or replace the authoritative M1b raw data or paired aggregation in `../results/m1b-2026-09-27/`.

## Method

Each JSON file contains four fresh-process control/variant pairs, ordered control→variant, variant→control, control→variant, variant→control. Both sides use Node v24.21.0, the frozen M1b count for that workload, three warmups, seven timed samples per process, and the same worker. Runs were serial on the same Windows x64 machine (AMD Ryzen 7 PRO 6850U); the three research agents had finished before timing began. Each worker ran its semantic preflight and verification. Ratios are `variant throughput / control throughput`, calculated as control process median duration divided by variant process median duration. Quartiles use R-7 interpolation. A ratio above 1 is a faster variant. Raw per-sample durations, per-process medians, order, and paired ratios are retained in each record.

`paired-diagnostics.mjs` is the small runner used to produce these records. Variants were built one at a time in disposable source/computed/fan-out worktrees. The variant source is not part of the accepted checkout.

## Source

| Hypothesis / single change | Workload | Median ratio; Q1–Q3; direction | Conclusion | Semantic difference in the temporary variant |
| --- | --- | --- | --- | --- |
| Skip source `ReadableInterop` protocol construction | `source/create@1` | 1.160; 1.064–1.221; 3/4 faster | partially supported | New source lacks foreign `getRevision`/`subscribe` protocol. [Raw](source-create-protocol.json) |
| Skip `nodesByReadable.set` for source wrappers | `source/create@1` | 2.025; 1.398–2.929; 4/4 faster | supported | Internal readable-to-node resolution fails, including `deepSignal` node setup and runtime subscriber queries. Magnitude is noisy, but all four paired directions favor the variant. [Raw](source-create-map.json) |
| Skip public `registerSignal` on source creation (WeakSet plus brand) | `source/create@1` | 1.428; 1.265–1.633; 4/4 faster | supported | Local identity registration and cross-copy signal branding are absent. This tests the registration layer as a whole, not its two operations separately. [Raw](source-create-brand.json) |
| Add guarded local plain-read branch; retain `readSignalCore`/dirty settlement | `source/read@1` | 0.815; 0.789–0.876; 1/4 faster | not supported | The branch is active only when all local, speculative, render, and shared graph collectors are absent. It did not speed this workload. [Raw](source-read-fastpath.json) |
| Same read-only change, negative control | `source/unobserved-write@1` | 1.026; 0.990–1.109; 3/4 faster | not supported | Timed loop contains no reads; no meaningful code-path change. [Raw](source-write-fastpath.json) |
| Same read-only change | `source/write-read@1` | 0.823; 0.763–0.901; 1/4 faster | not supported | Read branch executes after each write but did not recover the combined case. [Raw](source-write-read-fastpath.json) |
| Skip source render-revision bump on writes | `source/unobserved-write@1` | 1.009; 0.976–1.054; 2/4 faster | not supported | Render revision safety is lost for source writes. [Raw](source-write-revision.json) |
| Same revision change | `source/write-read@1` | 1.029; 0.860–1.207; 2/4 faster | not supported | Same semantic loss; no measured recovery. [Raw](source-write-read-revision.json) |

The creation results prove substantial time is spent in current RFSG's source registration work, particularly the readable-to-node map and public brand registration. They do not assign the entire `0.198` M1b ratio to either operation: each removal breaks accepted behavior, their costs are not additive, and map timing magnitude has wide spread. Protocol setup alone is only a smaller, less repeatable effect. For read and write/read, the tested fast-path and revision candidates do not explain the M1b gaps; dirty reconciliation, wrapper/accessor dispatch, and other path costs remain unpartitioned.

## Computed

| Hypothesis / single change | Workload | Median ratio; Q1–Q3; direction | Conclusion | Semantic difference in the temporary variant |
| --- | --- | --- | --- | --- |
| Skip computed protocol construction | `computed/create@1` | 0.994; 0.964–1.106; 2/4 faster | not supported | Foreign computed-readable protocol unavailable. [Raw](computed-create-protocol.json) |
| Omit `withTrackedGraph` during normal computed evaluation | `computed/dirty-read@1` | 1.137; 1.076–1.187; 3/4 faster | partially supported | Foreign/cross-copy computed dependencies are not recorded. [Raw](computed-dirty-read-graph-scope.json) |
| Same graph-scope change, positive control | `computed/dirty-unread@1` | 0.996; 0.980–1.057; 2/4 faster | not supported | The getter is not rerun during timed writes; the graph-scope ablation has no repeatable effect. [Raw](computed-dirty-unread-graph-scope.json) |
| Same graph-scope change | `computed/equality-suppression@1` | 1.055; 0.928–1.231; 2/4 faster | inconclusive | Foreign dependency tracking is lost; spread is too wide to attribute recovery. [Raw](computed-equality-graph-scope.json) |
| Skip normal `settleComputedRevision` call | `computed/equality-suppression@1` | 1.122; 1.066–1.151; 3/4 faster | partially supported | React/render revision settlement is incomplete. [Raw](computed-equality-revision.json) |
| Same revision-settlement change | `computed/dirty-read@1` | 0.967; 0.856–1.074; 2/4 faster | not supported | Same semantic loss; no repeatable recovery. [Raw](computed-dirty-read-revision.json) |

Protocol setup did not account for computed creation in this test. Tracked-graph scope contributed to dirty/read, but the effect did not appear in dirty/unread, consistent with laziness and the M1b positive control (current/v0.1.1 `1.388`, 8/8 faster). Revision settlement showed a modest equality-case contribution, not a general dirty/read cost. These ablations leave dirty validation, relinking, liveness synchronization, and object initialization unpartitioned. Do not combine these ratios or interpret them as additive shares.

## Effect fan-out

| Hypothesis / single change | Workload | Median ratio; Q1–Q3; direction | Conclusion | Semantic difference in the temporary variant |
| --- | --- | --- | --- | --- |
| Omit effect `withTrackedGraph` scope | `effect/fanout@1` | 1.198; 1.190–1.263; 4/4 faster | supported | Cross-copy/foreign effect dependencies are not collected. [Raw](fanout-1-graph-scope.json) |
| Same graph-scope change | `effect/fanout@16` | 1.144; 1.123–1.182; 4/4 faster | supported | Same semantic loss. [Raw](fanout-16-graph-scope.json) |
| Same graph-scope change | `effect/fanout@64` | 1.094; 0.965–1.138; 3/4 faster | partially supported | Same semantic loss; magnitude/direction is less stable. [Raw](fanout-64-graph-scope.json) |
| Omit effect `withoutAllRenderCollection` scope | `effect/fanout@1` | 1.236; 1.097–1.299; 3/4 faster | partially supported | Effect callbacks can be captured by render/speculative collectors. [Raw](fanout-1-render-scope.json) |
| Same render-scope change | `effect/fanout@16` | 1.111; 1.095–1.162; 4/4 faster | supported | Same render/speculative isolation loss. [Raw](fanout-16-render-scope.json) |
| Same render-scope change | `effect/fanout@64` | 1.208; 1.162–1.230; 4/4 faster | supported | Same render/speculative isolation loss. [Raw](fanout-64-render-scope.json) |

Both scopes repeat per effect callback. Their unguarded removal gives a causal upper bound, not an admissible fix. Render-scope benefit grew from fan-out 16 to 64; graph-scope benefit did not, so graph scope alone does not explain the widening M1b gap. Alien's shared linked edges and synchronous notification remain common architecture, not the demonstrated source of this added overhead.

## Interpretation

- **Proven contributors:** source `nodesByReadable` insertion and whole public source-brand registration are expensive in `source/create`; effect graph-scope and render-scope isolation add repeatable per-callback cost in the tested fan-out workloads. Temporary variants deliberately break behavior, so this proves the work is performed, not that it can be removed safely.
- **Strong/partial evidence:** normal computed graph-scope work in dirty/read and computed revision settlement in equality suppression. Their direction is not consistent enough to estimate a share.
- **Rejected:** the tested guarded source read branch, source render-revision bump as a dominant write-only cost, computed eager protocol construction, and graph-scope cost as an explanation of dirty/unread.
- **Inconclusive:** source protocol construction's magnitude and computed graph-scope effect on equality suppression.
- No percentages are assigned. Source creation's map ablation had ratios from 1.10 to 4.06 despite all four rounds favoring the variant; report the direction as supported and the magnitude as unstable.

## Corrected deep allocation check

The corrected worker returned `status: ok`, the expected 1-root/1,000-watched-leaf shape, and `disposedEffectsStopped: true` for both runtimes. Current retained delta was 477,744 bytes; v0.1.1 was 297,544 bytes (about 1.61×, not the original 5.1×). This was a focused directional validation, not a release threshold. It supports closing the old 3.657 MB vs 0.715 MB claim as **P5 — measurement artifact**.
