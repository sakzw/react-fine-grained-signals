# M8 — Final qualification status (2026-10-13)

## Qualification that passed

- Runtime: `vitest run --reporter=dot --pool=forks --maxWorkers=1 --configLoader native` — 38 files, 555 tests passed. The equivalent threads run passed 37 files/507 tests before one worker-start timeout; its remaining file passed 48/48 in isolation.
- Transform package: full serial suite now passes 381 tests / 3 skipped. React execution includes suspended capture isolation across roots. The dedicated React Compiler suite passes 24/24 with module/props updates, branch cleanup, Suspense retry, Hook order, and explicit CompileSuccess assertions. The real Vite integration suite passes module-level RSC skip/warning delivery, client transform, and source-map checks. Runtime and transform `tsc --noEmit` both pass.
- Build: runtime `tsdown` and declaration comment cleanup succeeded; transform `tsdown` and `tests/build-smoke.mjs` succeeded. Production Vite browser build succeeded.
- Lint: root `oxlint` exited successfully with existing warnings, including `no-shadow` and `consistent-function-scoping`.
- Package size: all seven gzip app-graph budgets pass with `node scripts/check-size.mjs`.
- Browser: production bundle ran in Chromium, Firefox, and WebKit. Counter, allowlisted host properties, form reset, and signal-bound style tests passed in each engine (12/12).
- Development browser: SSR/hydration harness `e2e/browser.spec.ts` passed all 48 cases across Chromium, Firefox, and WebKit. One cold-cache Firefox run exceeded the default 30-second navigation timeout; warming Vite's optimizer and using a 60-second timeout produced a complete pass. The isolated Firefox hydration retry also passed.
- Cross-copy: three independent bundled runtimes passed `tests/phase4-duplicate-smoke.mjs`.
- Mixed generation: `tests/mixed-version-smoke.mjs` passed with the installed v0.1.1 artifact; foreign signals remain explicitly unsupported and are rejected/recorded as such.
- Consumer artifact: clean v0.3.0 runtime and plugin npm tarballs were generated with release-shaped manifests, unpacked, and passed a consumer smoke for signal/computed/batch/effect, reactive collection tracking, and Vite/Rollup/Webpack/Rspack/esbuild adapter entrypoints. Their npm pack sizes are 130,164 B / 519,553 B unpacked and 60,870 B / 204,036 B unpacked. After updating the stale managed-codegen assertion, the repository's full `tests/consumer-smoke.mjs` also passed: prepack built both packages, the packed consumer installed dependencies, TypeScript/Vite build checks passed, and cross-copy smoke passed. This run used installed pnpm 12.6.0 through a scratch-only Volta shim; prepack warned that Volta supplied Node 24.19.0 while the repo requests 24.21.0. Source package manifests remain 0.2.1, so this is not the final 0.3.0 pinned-toolchain qualification. No publish was performed.
- `git diff --check` passed after line-ending normalization in the modified deep-signal engine.

## Freeze blockers

M8 is not complete and v0.3.0 must not be treated as frozen. The following are still required:

1. **M3 exactness:** the `useSignalCapture()`/per-read transform is in default managed codegen. Suspended read isolation across separate roots is covered, but time-sliced concurrent interleaving, hydration attempt ownership, JSX children/callbacks, cross-module aliases, and arbitrary async/deferred execution are not proven or consistently diagnosable. Fast Refresh harness was 18/24: all six remaining failures are React `try/finally` and Preact/Oxc control cases; managed Oxc/Babel Hook-shape cases pass. Resolve the tracking contract and rerun render/HMR/StrictMode/Suspense/SSR/hydration/Concurrent gates before accepting M3.
2. **M4 Compiler:** Babel runtime matrix now checks CompileSuccess, repeated writes, branch dependency cleanup, Suspense retry, and Hook order. Author directive runtime cases and production Vite/Babel integration remain incomplete.
3. **M5 bundler/RSC:** real Vite integration now checks module-level `use server` skip and source warning, `"use client"` transform, and source maps. Packed RSC/warning/source-map builds remain missing for Rollup, Webpack, Rspack, and esbuild.
4. **M7 variability:** most paired performance ratios have wide IQRs that cross 1; treat them as inconclusive. Retained heap IQR is also broad. The weak-collection optimization materially removes the measured ~3,000× regression but native comparisons remain slower by ~15–18×. Npm pack sizes are effectively unchanged from v0.2.1 (runtime -0.6%, plugin +0.02%); reevaluate after any artifact change.
5. **Release-shaped pack:** rerun the repository's full consumer smoke with the packageManager-pinned pnpm 12.8.1 and final package versions/lock metadata. The host exposed pnpm 12.6.0, while its Volta shim referenced a missing 12.3.4 executable; the prior smoke used a scratch-only shim to invoke 12.6.0. Source package versions remain `0.2.1` until the release contract is accepted; do not publish before then.

## Next execution order

1. Close M3 tracking semantics and diagnostics; if exact automatic tracking cannot be proved, compare the targeted-subscription contract and migration explicitly.
2. Finish the M4 opt-out/runtime matrix and M5 actual bundler/RSC integration cases.
3. Review the M6 cold-start timeout behavior in CI; production and warmed dev browser matrices are complete.
4. Review package tarball growth, regenerate artifacts, and rerun consumer installation/smoke.
5. Rerun all gates from the final tree, update package versions/lock only after the release contract is accepted, then make the M8 decision.

No push, release tag, or publication was performed.
