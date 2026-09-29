# Phase 9 M2 — Release hardening closure

## Starting point and scope

Started from clean `main` at `ddf73bcca80407f70900162148cb37392a12718e` (`perf: confirm Phase 9 from clean HEAD`), with local and remote `main` aligned. Phase 9 performance validation was already closed. This milestone addressed only M0-API-01, M0-API-02, M0-DOC-01, and M0-PACK-01. It did not change runtime source or package versions; both packages remain `0.1.1`.

## Findings and decisions

- Added canonical [English](migration-v0.2.md) and [Japanese](migration-v0.2.ja.md) migration guides for both old `useSignals` imports: root `useSignals` becomes root `useSignalTracking` (bare/best-effort), while `/runtime` `useSignals` becomes `/runtime` `useManagedSignals` (managed/exact). The guides recommend the plugin's default exact managed transform when available and retain manual managed scopes as the plugin-free option.
- Linked the guides from both language variants of the root README and documentation index.
- Extended the clean packed-consumer check to typecheck the JSX development runtime and every published unplugin entry, then import the installed tarballs and verify `jsxDEV`/`Fragment`, generic raw plugin creation, and usable Vite, Rollup, webpack, Rspack, and esbuild plugin shapes.
- Left `src/core/**`, `src/react/**`, both package manifests, and runtime behavior unchanged. No public entry or API was added.

## Validation

- `pnpm typecheck` — passed.
- `pnpm lint` — passed with existing warnings.
- `pnpm test` — the initial default high-parallel run hit 12 Vitest worker-start timeouts after 155 tests passed. The following root-only `pnpm exec vitest run --maxWorkers=2` passed 21 files and 285 tests, but did not cover the transform package. The final M2 closure results below replace that incomplete test record.
- `pnpm build` — passed.
- `pnpm test:phase4-duplicate` — passed.
- `pnpm test:consumer` — passed against packed tarballs, including all new public-entry checks and the Vite fixture build.
- `pnpm prepare:e2e` — passed.
- `pnpm test:browser` — passed, 27/27 total: 18 Chromium/Firefox/WebKit browser tests, 2 production-build tests, and 7 React Router SSR/hydration/navigation tests.
- `pnpm size` — passed; all size budgets satisfied.
- `git diff --check` — passed.

No calibration or performance benchmark was run as part of M2.

## Final M2 closure — migration distinction and complete test record

Verified clean starting state: local HEAD, `origin/main`, and GitHub `main` all pointed to `5ba1c93fac6fb8495937a7facb67bbbba65b8d3a` (`docs: harden Phase 9 release readiness`).

The migration guides now show the old and new imports separately:

- Root: v0.1.1 `import { useSignals } from "react-fine-grained-signals"` → v0.2 root `useSignalTracking`, bare/best-effort.
- Managed runtime: v0.1.1 `import { useSignals } from "react-fine-grained-signals/runtime"` → v0.2 `/runtime` `useManagedSignals`, managed/exact.
- `scope.f()` → `scope.finish()` remains documented as a breaking migration. The default/recommended `transform: "managed"` exact automatic boundary remains documented.

The final normal retry of `pnpm test` again hit worker-start timeouts: 7 root files and 125 tests passed, with 14 worker-start errors. The bounded fallback confirmed both complete suites independently:

- Root runtime: `pnpm exec vitest run --maxWorkers=2` — 21 files passed, 285 tests passed.
- Transform package: `pnpm --filter unplugin-react-fine-grained-signals exec vitest run --maxWorkers=2` — 3 files passed, 221 tests passed, 3 skipped.

`pnpm test` itself did not pass. Both package scripts remain unchanged; the repeated normal-run timeout evidence is consistent with this environment's worker-spawn sensitivity, while both bounded suites pass. The docs-only closure also passed `pnpm typecheck`, `pnpm lint` (existing warnings), and `git diff --check`. Runtime source was unchanged, and both package versions remain `0.1.1`.

**M2 is complete. M3 is ready to begin as a separate next step; it was not started in this closure.**

## Remaining polish and M3 readiness

M0 API migration, documentation, and packed-entry coverage findings are closed. The normal `pnpm test` retry again encountered worker-start timeouts, but both complete suites passed independently with bounded worker concurrency as recorded above. **Decision A: M2 release hardening is complete and the repository is ready to begin M3 release-candidate freeze.** M3 still needs its explicit version update to `0.2.0` followed by its frozen release validation; this milestone did not perform that version change.
