# Phase 9 benchmark harness

This private fixture has its own pinned dependencies and lockfile. `react-fine-grained-signals@0.1.1` is installed from the published package artifact; its source is never rebuilt here. Its Alien Signals peer and the direct Alien candidate are pinned to `3.2.1`. Vue is pinned to `@vue/reactivity@3.6.0-rc.9`.

Install the fixture and build the current runtime from the checked-out source:

```sh
pnpm --dir benchmarks/phase9 install --ignore-workspace --frozen-lockfile
pnpm build:runtime
```

Run the correctness/infrastructure smoke with:

```sh
pnpm --dir benchmarks/phase9 smoke
```

Smoke uses low iteration counts, writes to the OS temporary directory, and is labeled `smoke_validation`. Its timings are not performance evidence. Allocation rows contain a `kind` and `graphShape`; the orchestrator checks both against the requested workload and marks `shapeVerified: true` only when the shape and disposal assertion match. The three strict workload IDs are `signal-computed-effect-graph`, `one-source-many-effects`, and `deep-watched-leaves`. Unknown IDs fail in the worker rather than falling through to another graph.

## Runtime identity

`measure` and `calibrate` require production-relevant files to match baseline `c5d1796cfa2063db7eecb99e537209de185a530c`. The guard includes `src/**`, package and lock/workspace manifests, TypeScript and tsdown configuration, and the runtime declaration post-processing script. It permits benchmark and documentation changes. Each manifest also records a deterministic SHA-256 over the sorted relative paths and contents of the built `dist` files, along with the baseline guard result. The historical v0.1.1 artifact is never rebuilt.

For an explicitly identified M1.2 candidate only, `measure` also accepts `--runtime-inputs-sha256 <sha256>`. This compares the supplied hash with the deterministic SHA-256 of the current production input tree and records both the hash and `identityGuard: "explicit-runtime-inputs-sha256"` in the manifest. It does not relax calibration or silently redefine the M1b baseline. The analyzer rechecks the recorded input-tree hash and built-dist SHA-256. Compute the candidate hash with:

```sh
node --input-type=module -e "import { hashCurrentRuntimeInputs } from './benchmarks/phase9/runtime-identity.mjs'; console.log(await hashCurrentRuntimeInputs())"
```

Use this explicit guard only for the final M1.2 measurement after implementation and correctness validation; retain the normal baseline guard for M1b.

## M1b calibration (pilot only)

Do not start authoritative M1b until calibration is complete. Calibration runs are fresh-process pilots, stored separately under `benchmarks/phase9/calibration/` by default and labeled `calibration`; they are not performance evidence and must never be copied into M1b results.

Run a pilot using the config defaults, then group `samples.jsonl` rows by runtime, case, and size (and by `adapterVariant` for the adapter diagnostic). For each runtime/group, take the median of its samples within the process. For each case/size, use the shortest applicable process median across candidates/variants to choose one shared iteration count targeting roughly 20–30 ms:

```text
frozenIterations(case,size) = ceil(pilotIterations * targetNs / fastestRuntimeMedianNs)
```

Keep a floor of the current configured count, write one count for every case/size to a JSON file keyed as `caseId@size`, and use the exact same count for every compared runtime. Repeat calibration with that file to confirm the timing windows; adjust and freeze the file before M1b. For example:

```sh
pnpm --dir benchmarks/phase9 calibrate
pnpm --dir benchmarks/phase9 calibrate -- --iterations-file benchmarks/phase9/m1b-iterations.json
```

The calibration runner defaults to one process round, one warmup, and three samples. A frozen iteration file must cover every selected case/size exactly; the runner records its SHA-256 and the resolved counts in the manifest and each raw row. Calibration output remains separate from `results/`.

`mode=measure` refuses to start unless `--iterations-file` is provided. Use `--preflight-only` to validate a calibration file and runtime identity without creating output files or starting workers:

```sh
pnpm --dir benchmarks/phase9 calibrate -- --preflight-only
pnpm --dir benchmarks/phase9 measure -- --iterations-file benchmarks/phase9/m1b-iterations.json --preflight-only
```

The first command is an initial calibration preflight and does not need an iterations file. The second checks that the frozen file is a valid JSON object with complete case/size coverage and positive integer counts. `measure` without a file exits before starting workers and explains that a frozen calibration result is required.

## Controlled M1b run

Use a quiet, fixed machine and exact Node runtime. Build the runtime before starting; do not run other builds, tests, or CPU-heavy work during the matrix. After calibration, freeze the iteration file and run:

```sh
pnpm --dir benchmarks/phase9 measure -- --iterations-file benchmarks/phase9/m1b-iterations.json --rounds 8 --warmups 3 --samples 7 --sizes 1,16,64 --graph-count 1000 --allocations --allocation-rounds 3 --output benchmarks/phase9/results/m1b-<run-id>
```

The measurement-mode source guard must pass before workers start. The explicit `--allocations --allocation-rounds 3` flags collect the coarse retained-heap diagnostics; these are not allocation rates or a release score. The deep watched-leaf worker measures after its setup/disposal scope returns and GC runs, so dead locals in the worker activation do not appear as retained runtime state. Earlier M1b allocation rows predate this correction and must not be used to claim deepSignal retention.

Runtime order follows a deterministic four-round balanced cycle (`A=rfsg-v0.1.1`, `B=rfsg-current`, `C=alien-signals`, `D=vue-reactivity`): `A B D C`, `B C A D`, `C D B A`, `D A C B`. Each runtime occupies every position once, and each pair runs before/after one another twice per cycle. The authoritative eight throughput rounds repeat this cycle twice, balancing order around the paired current/v0.1.1 ratio. Custom round counts use the schedule's deterministic prefix; only complete four-round cycles claim pairwise balance. Allocation diagnostics use their separately configured three rounds and are not paired throughput evidence. The manifest records exact throughput and allocation order for every round. `node benchmarks/phase9/verify-runtime-order.mjs` checks position balance, pairwise order, and the eight-round repetition without running benchmarks.

Each run directory contains `manifest.json`, raw `samples.jsonl`, `allocations.jsonl`, and `failures.jsonl`. Durations and heap sizes are numeric. Abnormal exits, timeouts, assertion failures, and shape mismatches are failures, never zero-duration samples.

## M1b aggregation rule

Use fresh processes/rounds as the independent units. For each runtime/case/size (and adapter variant where applicable):

1. Take the median of that process's samples within each round.
2. Across the eight round medians, report the median and spread/IQR.
3. Derive case-specific ratios from the runtime medians. Do not pool all samples across rounds, rank runtimes globally, or create an overall score. Keep diagnostic, RFSG-only, React, and allocation records separate from common-core comparisons.

For the primary current/v0.1.1 comparison, pair the two process medians within each round and take the median of the eight `current / v0.1.1` ratios; report IQR, min/max, and direction counts. The balanced order makes the pair's run-before/run-after relationship equal over each four-round cycle. Treat `0.95–1.05` inclusive as the normal symmetric rough-parity region, subject to noise/spread. Above `1.05`, require the same repeatability before calling an improvement; noisy apparent gains remain rough parity or unstable/inconclusive. Improvements have no separate release gate.

Generate a deterministic summary only from one explicitly named authoritative result directory:

```sh
node benchmarks/phase9/analyze.mjs benchmarks/phase9/results/<run-id>
```

The analyzer rejects non-measure, incomplete, failed, or identity-mismatched runs, including an iterations-file SHA mismatch. It verifies sample coverage and the recorded eight-round schedule before printing JSON. Per-round quantiles use linear interpolation (R-7); allocation diagnostics remain separate and have no release threshold.

## M1.1b causal attribution

M1.1b uses one-variable temporary runtime ablations paired with unchanged-current control processes; it does not alter or reaggregate the authoritative M1b samples. The per-round raw diagnostic records, conclusions, semantic differences, and corrected deep-allocation check are indexed in [`attribution/README.md`](attribution/README.md). No temporary runtime variant is part of the accepted checkout.
