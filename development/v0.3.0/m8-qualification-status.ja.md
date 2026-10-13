# M8 — Final qualification status (2026-10-13)

## Qualification that passed

- Runtime: `vitest run --reporter=dot --pool=threads --maxWorkers=1` — 38 files, 555 tests passed. The two concurrent-render audit tests also pass when isolated. A reused-module run produced two order-dependent failures, so the qualification result uses per-file isolation.
- Transform package: 371 passed, 3 skipped in the full serial suite before the final M4 regression was added. Its dedicated React Compiler suite previously had 71 passed, 3 skipped; an additional focused runtime test passed for managed capture with `reactCompiler: "off"` (72 passed / 3 skipped cumulatively). `tsc --noEmit` passed for runtime and transform package.
- Build: runtime `tsdown` succeeded; transform `tsdown` and its `tests/build-smoke.mjs` succeeded. Production Vite browser build succeeded.
- Lint: root and transform package `oxlint` exited successfully. Root lint emits existing warnings, including `no-shadow` and `consistent-function-scoping` warnings.
- Package size: all seven gzip app-graph budgets pass with `node scripts/check-size.mjs`.
- Browser: production bundle ran in Chromium, Firefox, and WebKit. Counter, allowlisted host properties, form reset, and signal-bound style tests passed in each engine (12/12).
- Cross-copy: three independent bundled runtimes passed `tests/phase4-duplicate-smoke.mjs`.
- Mixed generation: `tests/mixed-version-smoke.mjs` passed with the installed v0.1.1 artifact; foreign signals remain explicitly unsupported and are rejected/recorded as such.
- Consumer artifact: clean v0.3.0 runtime and plugin npm tarballs were generated with release-shaped manifests, unpacked, and passed a consumer smoke for signal/computed/batch/effect, reactive collection tracking, and Vite/Rollup/Webpack/Rspack/esbuild adapters. Their npm pack sizes are 130,164 B / 519,553 B unpacked and 60,870 B / 204,036 B unpacked. The repository's full `tests/consumer-smoke.mjs` could not complete: its `pnpm pack` prepack spawns pinned pnpm 12.3.4, which is missing from the host. No publish was performed.
- `git diff --check` passed after line-ending normalization in the modified deep-signal engine.

## Freeze blockers

M8 is not complete and v0.3.0 must not be treated as frozen. The following are still required:

1. **M3 exactness:** the `useSignalCapture()`/per-read transform is in default managed codegen, but JSX children/callbacks, cross-module aliases, arbitrary async/deferred execution, and multiple-root/concurrent attempt ownership are not proven or consistently diagnosable. Fast Refresh harness was 18/24: all six remaining failures are React `try/finally` and Preact/Oxc control cases; managed Oxc/Babel Hook-shape cases pass. Resolve the tracking contract and rerun render/HMR/StrictMode/Suspense/SSR/hydration/Concurrent gates before accepting M3.
2. **M4 Compiler:** current Compiler tests pass, but the opt-out and runtime behavior matrix across the chosen M3 contract remains incomplete.
3. **M5 bundler/RSC:** unit coverage exercises five adapters and module-level `use server` skip/warning, but real consumer builds and the adapter/RSC combination matrix are incomplete.
4. **M6 development-browser path:** production-bundle browser matrix passes; the Vite SSR/dev-server browser matrix remains unavailable because startup hit dependency optimization/SSR import timeouts. Complete it after resolving that harness failure.
5. **M7 variability:** most paired performance ratios have wide IQRs that cross 1; treat them as inconclusive. Retained heap IQR is also broad. The weak-collection optimization materially removes the measured ~3,000× regression but native comparisons remain slower by ~15–18×. Npm pack sizes are effectively unchanged from v0.2.1 (runtime -0.6%, plugin +0.02%); reevaluate after any artifact change.
6. **Release-shaped pack:** rerun the repository's full consumer smoke with the pinned pnpm 12.3.4 installed, using final package versions and lock metadata. They remain `0.2.1` in the source tree until freeze; do not bump or publish before the release contract is accepted.

## Next execution order

1. Close M3 tracking semantics and diagnostics; if exact automatic tracking cannot be proved, compare the targeted-subscription contract and migration explicitly.
2. Finish the M4 opt-out/runtime matrix and M5 actual bundler/RSC integration cases.
3. Resolve the Vite dev server and rerun the full M6 browser matrix.
4. Review package tarball growth, regenerate artifacts, and rerun consumer installation/smoke.
5. Rerun all gates from the final tree, update package versions/lock only after the release contract is accepted, then make the M8 decision.

No push, release tag, or publication was performed.
