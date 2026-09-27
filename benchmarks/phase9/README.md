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

## Controlled M1b run

Use a quiet, fixed machine and exact Node runtime. Build the runtime before starting; do not run other builds, tests, or CPU-heavy work during the matrix. After calibration, freeze the iteration file and run:

```sh
pnpm --dir benchmarks/phase9 measure -- --iterations-file benchmarks/phase9/m1b-iterations.json --rounds 8 --warmups 3 --samples 7 --sizes 1,16,64 --graph-count 1000 --allocations --allocation-rounds 3 --output benchmarks/phase9/results/m1b-<run-id>
```

The measurement-mode source guard must pass before workers start. The explicit `--allocations --allocation-rounds 3` flags collect the coarse retained-heap diagnostics; these are not allocation rates or a release score.

Each run directory contains `manifest.json`, raw `samples.jsonl`, `allocations.jsonl`, and `failures.jsonl`. Durations and heap sizes are numeric. Abnormal exits, timeouts, assertion failures, and shape mismatches are failures, never zero-duration samples.

## M1b aggregation rule

Use fresh processes/rounds as the independent units. For each runtime/case/size (and adapter variant where applicable):

1. Take the median of that process's samples within each round.
2. Across the eight round medians, report the median and spread/IQR.
3. Derive case-specific ratios from the runtime medians. Do not pool all samples across rounds, rank runtimes globally, or create an overall score. Keep diagnostic, RFSG-only, React, and allocation records separate from common-core comparisons.
