# M8 — Final qualification status (2026-10-14)

## Qualification that passed

- Runtime: latest `pnpm test` — 38 files, 556 tests passed. Transform package: latest full suite 8 files, 399 tests passed, no skips. React execution includes suspended capture isolation across roots, runtime-key signal access, transformed hydration ownership, and two real React mock-scheduler time-slicing cases for yield/resume coherence and abandoned-attempt cleanup. Ordinary computed access alone does not select auto transform. React Compiler runtime matrix covers module/props updates, branch cleanup, Suspense retry, Hook order, authored directives, and integration opt-out. Real Vite production builds with Babel React Compiler run in both plugin registration orders and preserve repeated signal updates. Runtime and transform `tsc --noEmit` pass.
- Build: runtime `tsdown` and declaration comment cleanup succeeded; transform `tsdown` and `tests/build-smoke.mjs` succeeded. Production Vite browser build succeeded.
- Lint: root `oxlint` exited successfully with existing warnings, including `no-shadow` and `consistent-function-scoping`.
- Package size: all seven gzip app-graph budgets pass with `node scripts/check-size.mjs`.
- Browser: production bundle ran in Chromium, Firefox, and WebKit. Counter, allowlisted host properties, form reset, and signal-bound style tests passed in each engine (12/12).
- Development browser: SSR/hydration harness `e2e/browser.spec.ts` passed all 48 cases across Chromium, Firefox, and WebKit after adding an SSR-only native React CJS bridge and reserving its HMR module-runner port. Firefox cold hydration passed at the 60-second navigation timeout; the full 48-case matrix and Firefox-only 16-case matrix both passed. Production browser matrix remains 12/12 across three engines.
- Cross-copy: three independent bundled runtimes passed `tests/phase4-duplicate-smoke.mjs`.
- Mixed generation: `tests/mixed-version-smoke.mjs` passed with the installed v0.1.1 artifact; foreign signals remain explicitly unsupported and are rejected/recorded as such.
- Consumer artifact: clean v0.3.0 runtime and plugin npm tarballs were generated, unpacked, and passed the repository's full `tests/consumer-smoke.mjs`. The packed consumer installed both artifacts, checked public jsx-dev-runtime and unplugin entries, passed its TypeScript/Vite build, and completed genuine three-copy interop. `pnpm pack` invoked the direct local build commands from each prepack script, avoiding the host's broken nested Volta pnpm 12.3.4 shim; the installed pnpm 12.8.1 and Node 24.21.0 match the repository pins. Final `pnpm pack` tarballs are runtime 132,382 B and plugin 63,013 B. No publish was performed.
- `git diff --check` passed after line-ending normalization in the modified deep-signal engine.
- M3 bounded capture is qualified for statically identified synchronous reads in committed attempts, including React-scheduler yield/resume, abandoned-attempt cleanup, transformed hydration ownership, Suspense retry, and separate-root isolation. Statically resolvable JSX prop/children callbacks receive warnings; arbitrary escaped/deferred callbacks are outside the published contract.
- M5 integration matrix passes on Vite, Rollup, Webpack, Rspack, and esbuild: actual builds verify module-level `"use server"` skip, source-located warning, `"use client"` transform, and source-map sources. Full plugin suite passes 399/399.
- M4 Compiler/Babel qualification is complete for authored `"use memo"`/`"use no memo"`, `reactCompiler: "off"`, repeated updates, and Vite production builds in both plugin orders.

## Freeze decision

M0–M8 qualification is complete for the documented v0.3.0 contract. Runtime and transform suites, actual React scheduler tests, React Compiler/Babel integration, all five bundler/RSC adapter builds, dev/production browser matrices, typecheck/lint/build, cross-copy/mixed-version, size budgets, and clean v0.3.0 consumer pack/install smoke passed. M7 memory data remains diagnostic with broad, overlapping IQRs and does not support a claim of no leak or a precise retention improvement. Transform exactness remains bounded to statically identified synchronous reads; the documented callback/RSC limits remain in force.

The local release candidate is frozen at package version 0.3.0. No push, public tag, npm publish, or GitHub Release was performed.

## Next execution order

No further qualification work is pending. A separate explicit authorization is required before any remote publication action.

No push, release tag, or publication was performed.
