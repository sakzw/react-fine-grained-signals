# v0.2.1 Safe Lint Cleanup

**Status: READY_FOR_FREEZE.** This cleanup changes no runtime behavior, public API, signal tracking, React lifecycle, ownership, or benchmark measurement inputs.

## Baseline and final warning inventory

Baseline: `5ed8d42d6141520282ec0162f5da978f74012645` (`origin/main` at start). `pnpm lint` passed with 100 warnings. The count was independently read from oxlint JSON output.

| Rule | Before | After | Classification and disposition |
| --- | ---: | ---: | --- |
| `eslint(no-underscore-dangle)` | 4 | 0 | SAFE: renamed private HMR page metric `window.__hmrMetrics` to `window.hmrMetrics`. |
| `react(hooks)` | 1 | 0 | FALSE_POSITIVE: `useFirst` was a boolean data property, not a Hook. Renamed it `selectFirst` in `tests/react-render-tracking.test.tsx`. |
| `unicorn(no-array-sort)` | 8 | 0 | CONDITIONAL, verified safe: all affected calls sorted a fresh `Object.getOwnPropertyNames()` array or a copied/summary input. Switched to `toSorted()`. |
| `unicorn(no-array-reverse)` | 2 | 0 | CONDITIONAL, verified safe: both schedule paths reversed a fresh copy. Switched to `toReversed()`. |
| `eslint(preserve-caught-error)` | 2 | 0 | FALSE_POSITIVE: these are independent first-run usage/integrity checks inside the ENOENT setup branch, not wrappers that discard the caught error. Kept the original messages and added line-only suppressions with reasons. |
| `eslint(no-shadow)` | 56 | 56 | KEEP: 49 are in Alien-derived benchmark implementations whose local `effect` / `computed` node names intentionally match the reference algorithm; 7 are effect-node locals in the production Alien-derived core that shadow its internal `effect` factory name. Renaming the production locals would touch core runtime source and trigger required runtime/performance comparison without changing behavior. |
| `unicorn(consistent-function-scoping)` | 27 | 27 | KEEP: includes runtime-factory-local functions in `src/core/alien-derived-runtime-core.mts`, `src/core/render-runtime.mts`, and `src/react/react-adapter.mts`, where moving functions could change per-runtime identity/initialization. The remaining nested test/benchmark component helpers can affect React component identity or benchmark fidelity. |
| **Total** | **100** | **83** | **17 warnings removed** (15 behavior-preserving code/name changes and 2 narrow false-positive suppressions). |

The array edits do not modify benchmark input arrays or the measurement schedule: median/quantile calculations still sort a copy, own-property checks still compare sorted fresh arrays, and reverse schedule branches still return the same values in the same order. No raw benchmark measurement was changed or regenerated.

## Validation

- Final `pnpm lint`: passed with 83 warnings, down from 100.
- `pnpm typecheck`: passed (runtime and transform packages).
- `pnpm test`: passed; runtime 37 files / 531 tests, transform 5 files / 358 passed / 3 skipped. The transform suite includes `react-compiler.test.ts` and the runtime-behavior coverage for compiled components.
- `pnpm build`: runtime and transform builds passed.
- `node tests/consumer-smoke.mjs`: passed for packed runtime/plugin entries, TypeScript, Vite production build, and duplicate-runtime interop. Set a temporary empty `VOLTA_HOME` to bypass the stale local Volta executable path.
- `node development/phases/phase10/fast-refresh-harness/run.mjs`: 24 cases completed with exit code 0; 15 passed and 9 currently reproduced Oxc signature limitations, all six Vite servers closed. The harness metrics rename preserved expected counts and classifications.
- `node benchmarks/phase9/m15/public-check.mjs` and `node benchmarks/phase9/m15/brand-shapes-check.mjs`: both passed after array API changes.
- GitHub Actions for the reviewed cleanup code: Test run `38219478209` and E2E run `38219478348` both passed, including `pnpm test:browser`.

## Freeze decision

No runtime, API, lifecycle, ownership, correctness, or benchmark measurement behavior changed. The previously qualified v0.2.1 freeze remains **READY_FOR_FREEZE**, conditional on accepting the documented pre-existing managed-mode Hook placement / Fast Refresh limitation. No publish, Git tag, or GitHub Release was created.
