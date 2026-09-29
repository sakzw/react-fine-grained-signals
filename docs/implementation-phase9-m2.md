# Phase 9 M2 — Release hardening closure

## Starting point and scope

Started from clean `main` at `ddf73bcca80407f70900162148cb37392a12718e` (`perf: confirm Phase 9 from clean HEAD`), with local and remote `main` aligned. Phase 9 performance validation was already closed. This milestone addressed only M0-API-01, M0-API-02, M0-DOC-01, and M0-PACK-01. It did not change runtime source or package versions; both packages remain `0.1.1`.

## Findings and decisions

- Added canonical [English](migration-v0.2.md) and [Japanese](migration-v0.2.ja.md) migration guides for the hook rename, managed-scope method rename, and Alien Signals dependency change. The guides recommend the plugin's default exact managed transform when available and retain manual managed scopes as the plugin-free option.
- Linked the guides from both language variants of the root README and documentation index.
- Extended the clean packed-consumer check to typecheck the JSX development runtime and every published unplugin entry, then import the installed tarballs and verify `jsxDEV`/`Fragment`, generic raw plugin creation, and usable Vite, Rollup, webpack, Rspack, and esbuild plugin shapes.
- Left `src/core/**`, `src/react/**`, both package manifests, and runtime behavior unchanged. No public entry or API was added.

## Validation

- `pnpm typecheck` — passed.
- `pnpm lint` — passed with existing warnings.
- `pnpm test` — the default high-parallel run hit 12 Vitest worker-start timeouts after 155 tests passed. Re-running the complete suite with `pnpm exec vitest run --maxWorkers=2` passed: 21 files, 285 tests.
- `pnpm build` — passed.
- `pnpm test:phase4-duplicate` — passed.
- `pnpm test:consumer` — passed against packed tarballs, including all new public-entry checks and the Vite fixture build.
- `pnpm prepare:e2e` — passed.
- `pnpm test:browser` — passed, 27/27 total: 18 Chromium/Firefox/WebKit browser tests, 2 production-build tests, and 7 React Router SSR/hydration/navigation tests.
- `pnpm size` — passed; all size budgets satisfied.
- `git diff --check` — passed.

No calibration or performance benchmark was run. No commit, push, or other Git history operation was performed.

## Remaining polish and M3 readiness

M0 API migration, documentation, and packed-entry coverage findings are closed. The initial `pnpm test` worker-start issue is recorded above; the same full test suite passed with bounded worker concurrency. **Decision A: M2 release hardening is complete and the repository is ready to begin M3 release-candidate freeze.** M3 still needs its explicit version update to `0.2.0` followed by its frozen release validation; this milestone did not perform that version change.
