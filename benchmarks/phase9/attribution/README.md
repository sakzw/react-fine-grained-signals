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

## M1.3 focused attribution

These are fresh-process paired diagnostics against unchanged current at `b4fc12a48b25266dcdd62ef0fb171e760a7d98ed`, with the M1b frozen iteration count, three warmups, seven samples, and alternating control/variant process order. Each first pass used four pairs; selected computed candidates were repeated and combined as eight pairs. Ratios are variant/control throughput. They are separate from the full M1.3 current/v0.1.1 matrix.

| Hypothesis / single change | Workload | Median ratio; Q1–Q3; direction | Conclusion |
| --- | --- | --- | --- |
| Return without saving/resetting/restoring speculative depth when current depth is zero | `effect/fanout@1` | 0.941; 0.903–0.998; 1/4 faster | Rejected; slower direction. [Raw](m13-spec-depth-fanout-1.json) |
| Same change | `effect/fanout@16` | 0.988; 0.873–1.037; 2/4 faster | Rejected; no supported gain. [Raw](m13-spec-depth-fanout-16.json) |
| Same change | `effect/fanout@64` | 1.002; 0.945–1.037; 2/4 faster | Rejected; no supported gain. [Raw](m13-spec-depth-fanout-64.json) |
| Skip promotion helper in caller when the cache flag is false | `computed/dirty-read@1` | 1.127; 1.055–1.177; 7/8 faster | Rejected because the equality control regressed. [First](m13-promotion-guard-computed-dirty-read.json), [repeat](m13-promotion-guard-repeat-computed-dirty-read.json) |
| Same caller change | `computed/equality@1` | 0.933; 0.835–0.993; 1/8 faster | Repeatable regression. [First](m13-promotion-guard-computed-equality.json), [repeat](m13-promotion-guard-repeat-computed-equality.json) |
| Check promotability once in `promoteSpeculativeCache` and pass the known fact to dependency validation | `computed/dirty-read@1` | 1.352; 1.236–1.629; 7/8 faster | Accepted narrow optimization. [First](m13-promotion-helper-computed-dirty-read.json), [repeat](m13-promotion-helper-repeat-computed-dirty-read.json) |
| Same helper change | `computed/equality@1` | 0.997; 0.809–1.080; 4/8 faster | Rough parity; no direction. [First](m13-promotion-helper-computed-equality.json), [repeat](m13-promotion-helper-repeat-computed-equality.json) |
| Same helper change | `computed/dirty-unread@1` | 1.059; 0.914–1.145; 5/8 faster | No directional change; lazy positive control. [First](m13-promotion-helper-computed-dirty-unread.json), [repeat](m13-promotion-helper-dirty-unread-repeat.json) |
| Same helper change | `computed/source-to-many@1` | 0.985; 0.874–1.755; 4/8 faster | Inconclusive. [First](m13-promotion-helper-fanout-1.json), [repeat](m13-promotion-helper-repeat-fanout-1.json) |
| Same helper change | `computed/source-to-many@16` | 1.111; 0.899–1.545; 5/8 faster | Inconclusive. [First](m13-promotion-helper-fanout-16.json), [repeat](m13-promotion-helper-repeat-fanout-16.json) |
| Same helper change | `computed/source-to-many@64` | 1.200; 1.077–1.335; 6/8 faster | Repeatable improvement at this size. [First](m13-promotion-helper-fanout-64.json), [repeat](m13-promotion-helper-repeat-fanout-64.json) |

The depth-zero guard preserves graph/render isolation but did not recover fan-out. The caller-only promotion guard gave a dirty-read gain but harmed equality, so it was discarded. The accepted helper change removes a redundant eligibility check only after that check has already succeeded; revision validation is unchanged. Wide spreads in other computed workloads remain visible in the raw values and are not converted into a causal percentage. The final full M1.3 matrix is stored independently in [`../results/m1.3-2026-09-27-promotion-helper/`](../results/m1.3-2026-09-27-promotion-helper/).

## M1.3.1 hot-path closure

These fresh-process paired diagnostics compare one temporary change at a time against unchanged current at `fb14d01ad990d56cf920e8350c015175ce3897a4`. Every worker used the frozen M1b iteration count, three warmups, seven samples, and four serial process pairs in alternating order. Ratios are variant/control throughput. All worker preflights and workload assertions passed. The temporary runtime changes were confined to a disposable worktree and none was retained.

| Temporary candidate | Workload | Median ratio (Q1–Q3) | Faster pairs | Decision |
| --- | --- | ---: | ---: | --- |
| Enqueue leaf effects directly, bypassing the general notification loop | effect/fanout@1 | 1.071 (1.001–1.149) | 3/4 | Inconclusive; spread is broad. [Raw](m131-notify-leaf-1.json) |
| Same candidate | effect/fanout@16 | 1.017 (0.942–1.087) | 2/4 | Rejected; no repeatable gain. [Raw](m131-notify-leaf-16.json) |
| Same candidate | effect/fanout@64 | 1.041 (0.980–1.122) | 2/4 | Rejected; no repeatable gain. [Raw](m131-notify-leaf-64.json) |
| Return after linking a source dependency, skipping remaining computed/external classification checks | effect/fanout@1 | 1.046 (0.952–1.116) | 2/4 | Inconclusive. [Raw](m131-track-source-1.json) |
| Same candidate | effect/fanout@16 | 0.959 (0.940–0.979) | 1/4 | Rejected; slower direction. [Raw](m131-track-source-16.json) |
| Same candidate | effect/fanout@64 | 0.966 (0.904–1.131) | 2/4 | Rejected; no supported gain. [Raw](m131-track-source-64.json) |
| Return a clean ordinary read after foreign graph publication, avoiding `readSignalCore`/`track` | source/read@1 | 1.024 (0.979–1.087) | 2/4 | Rejected; no repeatable read gain. [Raw](m131-clean-read-read.json) |
| Same candidate | source/write-read@1 | 0.932 (0.903–0.983) | 1/4 | Rejected; slower direction. [Raw](m131-clean-read-write-read.json) |
| Same candidate | source/unobserved-write@1 | 0.989 (0.929–1.004) | 1/4 | No supported adjacent-workload gain. [Raw](m131-clean-read-unobserved-write.json) |
| Inline foreign graph collector lookup/publication at the ordinary-read caller | source/read@1 | 1.013 (0.955–1.062) | 2/4 | Rejected; no repeatable read gain. [Raw](m131-inline-foreign-check-read.json) |
| Same candidate | source/write-read@1 | 0.992 (0.926–1.012) | 2/4 | No directional change. [Raw](m131-inline-foreign-check-write-read.json) |
| Same candidate | source/unobserved-write@1 | 1.054 (0.996–1.090) | 3/4 | Partial signal only; the target read did not improve repeatably. [Raw](m131-inline-foreign-check-unobserved-write.json) |

The queue-leaf and track-classification variants did not improve fanout at 16/64. The two source/read variants did not produce a repeatable target gain; the clean-read bypass also regressed write-read. No production change passed the paired evidence gate, so the full M1.3 matrix was not rerun. See [`../../../docs/implementation-phase9-m1.3.1.md`](../../../docs/implementation-phase9-m1.3.1.md) for the path maps and closure decision.

## M1.4 structural prototypes

These fresh-process diagnostics compare each temporary variant against unchanged current at `091b4ac5a4e71156db5c2e22836de64e9d21df75`. Workers used the exact M1b iterations, three warmups, seven samples, and alternating process order. The stored ratio is **duration variant/control** (`<1` means faster). Selected noisy/promising candidates were extended beyond the initial four pairs. These are attribution records, not M1.4 release statistics.

| Prototype and case | Pairs | Median (Q1–Q3) | Faster | Raw record |
| --- | ---: | ---: | ---: | --- |
| Ordinary computed dispatch — create@1 | 8 | 0.852 (0.477–1.011) | 6/8 | [first](m14-computed.json), [repeat](m14-computed-repeat.json) |
| Same — dirty-read@1 | 16 | 0.943 (0.724–1.039) | 11/16 | [first](m14-computed.json), [repeat](m14-computed-repeat.json), [extended](m14-computed-repeat2.json), [final](m14-computed-repeat3.json) |
| Same — dirty-unread@1 | 8 | 1.021 (0.857–1.060) | 3/8 | [first](m14-computed.json), [repeat](m14-computed-repeat.json) |
| Same — equality-suppression@1 | 16 | 0.852 (0.777–1.003) | 12/16 | [first](m14-computed.json), [repeat](m14-computed-repeat.json), [extended](m14-computed-repeat2.json), [final](m14-computed-repeat3.json) |
| Consolidated effect callback context — observed-write@1 | 16 | 0.791 (0.660–0.960) | 13/16 | [first](m14-effect.json), [repeat](m14-effect-repeat.json), [extended](m14-effect-repeat2.json), [final](m14-effect-repeat3.json) |
| Same — fanout@1 | 8 | 0.936 (0.823–1.003) | 6/8 | [first](m14-effect.json), [repeat](m14-effect-repeat.json) |
| Same — fanout@16 | 16 | 0.974 (0.786–1.112) | 10/16 | [first](m14-effect.json), [repeat](m14-effect-repeat.json), [extended](m14-effect-repeat2.json), [final](m14-effect-repeat3.json) |
| Same — fanout@64 | 16 | 0.905 (0.843–1.036) | 11/16 | [first](m14-effect.json), [repeat](m14-effect-repeat.json), [extended](m14-effect-repeat2.json), [final](m14-effect-repeat3.json) |

The computed path rewrite did not show a stable dirty-read/equality result. The effect helper had a promising observed-write signal, but its signal-only and deep gzip entries exceeded the existing size budgets; the clean baseline passed those budgets. It was reverted. No full M1.4 matrix was run. `m14-paired-diagnostic.mjs` reproduces the serial, four-pair blocks using the frozen iterations file and worker; multiple `m14-*-repeat*.json` blocks provide the 8–16 pair totals above.

## M1.4.1 promising candidate refinement

These diagnostics compare the M1.4 effect helper and computed-dispatch candidates against unchanged current at `234634aedca02d30578126c49bb229464675f915`. Every process used the frozen `m1b-iterations.json`, three warmups, seven samples, and alternating control/variant order. The runner now accepts `--pairs=N` to extend the independent process-pair count; it retains the individual samples and each process median in the raw JSON. Ratios are **duration variant/control** (`<1` is faster), and throughput equivalent is the inverse of the median duration ratio. Do not pool worker samples across processes.

The smallest effect code shape was the reconstructed named context helper. Its 24-pair primary and 8-pair secondary results are in [primary](m141-effect-helper-primary-24.json) and [secondary](m141-effect-helper-secondary-8.json). The initial four-pair reconstruction check is [here](m141-effect-reconstructed.json). An alternative that integrates isolation into `withTrackedGraph` has separate [primary](m141-effect-primary-24.json) and [secondary](m141-effect-secondary-8.json) records; it was slightly larger and was not the selected size shape. The computed-dispatch candidate's [24-pair primary](m141-computed-primary-24.json) and [8-pair secondary](m141-computed-secondary-8.json) records include dirty-read/equality and the dirty-unread/create/fanout guard workloads.

Reproduce or extend one diagnostic serially:

```sh
node benchmarks/phase9/attribution/m14-paired-diagnostic.mjs \
  . <candidate-root> benchmarks/phase9/attribution/local.json \
  effect-observed-write@1 effect-fanout@16 effect-fanout@64 --pairs=24
```

The helper records raw paired durations, not an authoritative M1b comparison. M1.4.1 selected neither candidate; no combined candidate or final Phase 9 matrix was run. See [`implementation-phase9-m1.4.1.md`](../../../docs/implementation-phase9-m1.4.1.md) for the bundle-byte comparison and decision.
