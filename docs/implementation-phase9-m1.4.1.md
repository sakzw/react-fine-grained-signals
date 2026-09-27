# Phase 9 M1.4.1 — Promising Candidate Refinement

## Scope and decision

Started from clean `main` and `origin/main` at `234634aedca02d30578126c49bb229464675f915` (`docs: record Phase 9 M1.4 investigation`). Runtime prototypes were reconstructed only in disposable worktrees. No production runtime change was accepted, no M1b matrix or calibration was run, and M2 was not started.

**Selection: neither candidate.** The effect helper retained a promising observed-write median but its IQR crossed parity, dynamic dependencies regressed, and its bundle grew slightly beyond two existing budgets. The computed dispatch reduced bundle bytes, but dirty-read was near parity with a wide spread and equality's IQR crossed parity. No combined candidate was warranted.

## Effect callback context

The reconstructed M1.4 helper replaced the nested `withoutInteropSpeculativeMode` → `withTrackedGraph` → `withoutAllRenderCollection` wrappers in `run()` with a helper that saves the graph/speculative/render context once, runs `effect.fn()`, and restores all context in `finally`.

Three code shapes were inspected: the original named helper, an inline save/restore block, and an isolation option folded into the existing `withTrackedGraph` helper. The named helper was the smallest. The inline form was larger; integrating the option into `withTrackedGraph` was also slightly larger, and added branches to a helper used by computed evaluation. No shape reduced the original helper's bundle cost.

### Exact package-entry gzip sizes

The clean baseline and smallest helper were measured with the same `check-size.mjs` scenarios. Every tree-shaking marker passed. Budget-only failures were signal-only and deep; no budget was changed.

| Consumer entry | Baseline bytes | Smallest effect helper | Delta | Relative change |
| --- | ---: | ---: | ---: | ---: |
| signal-only | 6,067 | 6,152 | +85 | +1.40% |
| core | 6,110 | 6,196 | +86 | +1.41% |
| core+hooks | 7,467 | 7,560 | +93 | +1.25% |
| deep | 10,580 | 10,661 | +81 | +0.77% |
| index-full | 11,776 | 11,862 | +86 | +0.73% |
| jsx-runtime | 9,290 | 9,392 | +102 | +1.10% |
| utils | 7,395 | 7,478 | +83 | +1.12% |

The integrated `withTrackedGraph` shape measured 6,156 signal-only and 10,664 deep bytes, so it was 4 and 3 bytes larger than the named helper. It also did not produce a stable enough observed-write improvement to justify accepting its extra branch. Exact runs are reproducible with `node scripts/check-size.mjs --exact`.

### Paired effect diagnostics

The following use the best-size named helper, frozen M1b iterations, Node v24.21.0, three warmups and seven samples per fresh worker. Control/variant process order alternated. Ratios are **duration variant/control**; below 1.00 is faster. Throughput equivalent is `1 / median duration ratio`. Pairs were not pooled at the sample level.

| Workload | Pairs | Median duration ratio (Q1–Q3) | Faster | Throughput equivalent | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| observed-write@1 | 24 | 0.885 (0.812–1.004) | 18/24 | 1.129× | Apparent 11% median gain, but upper quartile reaches parity. Not repeatable enough to accept. |
| fanout@16 | 24 | 0.954 (0.910–1.032) | 16/24 | 1.048× | Near parity with a broad spread. |
| fanout@64 | 24 | 0.972 (0.918–1.051) | 16/24 | 1.029× | Near parity with a broad spread. |
| fanout@1 | 8 | 0.841 (0.669–0.974) | 6/8 | 1.189× | Positive but exploratory. |
| dynamic-dependencies@1 | 8 | 1.230 (1.087–1.338) | 2/8 | 0.813× | Clear adjacent-workload regression. |
| two-writes-one-reaction@1 | 8 | 0.925 (0.836–1.058) | 5/8 | 1.081× | Inconclusive. |

The dynamic-dependencies regression and the wide primary spreads outweigh the observed-write median. The small gzip growth alone would not have rejected a stable material gain. If the helper were later selected, the smallest exact limits needed would be signal-only 6,152 (+8 bytes) and deep 10,661 (+37 bytes); no size budget change is justified for this rejected candidate.

## Ordinary computed dispatch

The reconstructed candidate routes reads with no local render, speculative, or shared graph collector directly through cache promotion and `readComputedCore`. Render/speculative reads retain the previous bookkeeping path, including foreign graph publication. It introduces no node state; the now-unused dispatch helper was removed.

All consumer-entry gzip budgets passed and every tree-shaking marker remained valid. Compared with baseline, bytes changed by −27 signal-only, −24 core, −15 core+hooks, −21 deep, −13 index-full, −23 jsx-runtime, and −17 utils.

| Workload | Pairs | Median duration ratio (Q1–Q3) | Faster | Throughput equivalent | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| dirty-read@1 | 24 | 0.975 (0.816–1.143) | 13/24 | 1.026× | Near parity; wide spread. |
| equality-suppression@1 | 24 | 0.933 (0.853–1.012) | 18/24 | 1.072× | Apparent 7% median gain; upper quartile crosses parity. |
| dirty-unread@1 | 8 | 1.009 (0.976–1.078) | 4/8 | 0.991× | Remains near parity; lazy behavior is preserved. |
| create@1 | 8 | 1.103 (0.867–1.252) | 3/8 | 0.907× | No supported gain. |
| source-to-many@1 | 8 | 1.046 (0.874–1.147) | 3/8 | 0.956× | Inconclusive. |
| source-to-many@16 | 8 | 0.880 (0.829–0.949) | 7/8 | 1.136× | Positive exploratory result. |
| source-to-many@64 | 8 | 0.948 (0.868–1.002) | 6/8 | 1.055× | Near parity. |

The equality median does not justify a change while dirty-read, the other required primary target, remains unproven. Dirty-unread stayed healthy, but that alone is not sufficient for selection.

## Correctness and remaining work

Both isolated candidates passed typecheck, lint, the full test suites (runtime: 283 tests; transform: 221 passed, 3 skipped), build, duplicate-copy smoke, consumer smoke, and browser tests (27/27). `pnpm size` passed for computed. For effect, structural marker checks passed, while the existing signal-only and deep budgets failed by 8 and 37 bytes respectively in the final build output; the exact measurement scenarios showed +85 and +81 bytes versus clean baseline. These are separate budget representations because the package size command rounds display values and its budgets are quantized. `git diff --check` was also run on each isolated candidate.

No combined candidate or authoritative M1b matrix was run because neither candidate passed its targeted evidence gate. No production code or budget file changed. The source/read median remains approximately 0.654 versus v0.1.1 in the M1.3 record. Cross-copy-aware ordinary-read context remains a high-priority open question for M1.4.2; M2 should not begin before that path is assessed.

Raw serial paired records are linked from the [attribution README](../benchmarks/phase9/attribution/README.md#m141-promising-candidate-refinement). The frozen iterations file SHA-256 was `FB549096642E48EDA6BA9F50485E67B41079D2178DBD2BA607C6931106D5F056`.
