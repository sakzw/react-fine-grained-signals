# Phase 9 benchmark harness

This is a private benchmark fixture with its own pinned dependencies and lockfile. `react-fine-grained-signals@0.1.1` is installed from the published package artifact; its source is never rebuilt here. Its Alien Signals peer and the direct Alien candidate are pinned to `3.2.1`. Vue is pinned to `@vue/reactivity@3.6.0-rc.9`.

Install fixture dependencies and build the current runtime once before a harness run:

```sh
pnpm --dir benchmarks/phase9 install --ignore-workspace --frozen-lockfile
pnpm build:runtime
```

Run only the small infrastructure/correctness smoke with:

```sh
pnpm --dir benchmarks/phase9 smoke
```

Smoke output is written under the operating system temporary directory and is labeled `smoke_validation`. It is not performance evidence.

The controlled measurement entry point is intentionally separate:

```sh
pnpm --dir benchmarks/phase9 measure -- --output results/<run-id>
```

Before M1b, select and record the exact iteration, warmup, sample, round, and graph-size configuration; use a quiet, fixed machine and exact Node runtime. The orchestrator launches one child process per runtime/case/round, serially. Do not run `measure` as part of M1a.

Each run directory contains `manifest.json`, raw `samples.jsonl`, and `failures.jsonl` (empty when no failure occurs). JSONL durations and heap sizes are numeric and unformatted. A failure, timeout, or failed semantic assertion is recorded as a failed run and is never treated as a zero-duration sample. Allocation sanity records are coarse post-GC diagnostics, not allocation rates or a release score.
