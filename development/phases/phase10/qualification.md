# v0.2.1 release qualification

## Fast Refresh investigation

The current managed transform wraps the component body in a `try/finally` scope so `useManagedSignals().finish()` runs after normal returns and thrown renders. The v0.2.0 release audit recorded a reproducible issue in the audited Vite/Oxc React Refresh setup: adding, removing, or reordering a Hook in a managed-transformed component did not invalidate the refresh signature, so React preserved the previous fiber state and could throw “Rendered more hooks than during the previous render” or “Rendered fewer hooks than expected”. The user-visible limitation is already described in both plugin READMEs.

The previous audit compared managed and inject in that fixture; inject did not show the issue because its inserted `useSignalTracking()` remains at the component's ordinary Hook level. This checkout does not install `@vitejs/plugin-react` or `@preact/signals-react-transform`, so the HMR edit loop and the requested Babel/Oxc/Preact comparisons could not be rerun here. The current transform structure still places user Hooks inside the generated `try` block. A refresh-specific signature shim or moving the `try/finally` boundary would couple transformation to refresh tooling or risk the exact managed scope and other compiler/bundler integrations. No code change was made; retain the known limitation and revisit with a dedicated HMR harness and cross-bundler validation.

## Vite external `cacheDir`

A temporary Vite 8.3.1 probe used a `cacheDir` outside `node_modules` and observed only the application's source module in the plugin transform hook; it did not produce optimized dependency entries in the probe, so it does not establish dependency-prebundle or HMR behavior. No transform-filter change was made. This remains an unconfirmed concern rather than a reproduced build defect.

## Test and package evidence

- Baseline runtime suite on `v0.2.0`: 528 passed across 37 files.
- Baseline transform suite on `v0.2.0`: 354 passed, 3 skipped across 5 files.
- Final JSX targeted suite: 27 passed, including initial nullish, non-nullish update, nullish removal, HTML, and SVG namespace cases.
- Transform diagnostics workstream: 287 passed, 3 skipped; package TypeScript check passed; `git diff --check` passed.
- `npm pack --dry-run --ignore-scripts --json` on the updated pin policy exited successfully under Node 24.21.0, with the expected mismatch warning. This verifies the `devEngines` gate only; the prepack build and published consumer artifact are checked separately in release qualification.
- React Refresh HMR, external-cache dependency prebundling, and browser HMR were not verified in this environment.

## Final v0.2.1 qualification

- `pnpm typecheck` passed for the runtime and unplugin packages. The public JSX types accept `Signal<string | null | undefined>` for `title` and `id` without widening unrelated attributes.
- `pnpm lint` passed with the repository's existing warnings and no lint errors.
- Runtime tests passed: 529 tests across 37 files. Transform/unplugin tests passed: 357 tests across 5 files, with 3 existing skips. The dedicated React Compiler suite passed all 19 tests.
- The production `pnpm build` passed for both packages. The Vite browser and React Router SSR production builds also passed as part of Playwright.
- `pnpm test:consumer` completed using both locally packed 0.2.1 packages. The fixture installed them, passed its public-entry check and TypeScript check, built with Vite, and passed the duplicate-runtime-copy interop smoke. The first launch attempts used a stale Volta pnpm shim and failed before `prepack`; the successful run used a process-local empty Volta home and the installed pnpm executable.
- `npm pack --dry-run --json` passed with the real `prepack` build and reported `react-fine-grained-signals@0.2.1`; Node 24.19.0 emitted the expected `devEngines` warning. The consumer smoke also ran `pnpm pack` for both 0.2.1 packages and resolved the plugin's workspace dependency in the consumer fixture.
- `pnpm test:mixed-version` passed its documented v0.1.1/v0.2.1 compatibility assertions. `pnpm size` passed every configured size budget.
- Playwright passed all 54 tests across Chromium, Firefox, WebKit, the production bundle, and the React Router SSR app. The first attempt timed out while Vite's dependency optimizer was still bundling after the lockfile changed. Removing only the generated incomplete optimizer cache and retrying completed successfully in 3.1 minutes.

### JSX binding microbenchmark

The changed code is the `title` / `id` direct-binding setter. A temporary JSDOM + React harness compared the exact v0.2.0 tag build and current v0.2.1 build using the same Node v24.21.0 process setup, 100,000 writes per property, one warmup, and five measured samples per process. Five paired process medians (v0.2.0 then v0.2.1, milliseconds) were: 604.96/658.74, 557.95/613.63, 624.57/533.59, 627.72/652.81, and 677.15/500.13. The paired ratios vary in direction, while within-process sample ranges were broad (for example, 430–925 ms across the captured runs). This small JSDOM benchmark is noisy and inconclusive; it does not support a claim of parity or regression. The non-null branch retains the same string conversion and DOM property assignment; only nullish updates now remove the attribute. The temporary harness and baseline worktree were removed after measurement.

### Release decision and remaining limits

The available v0.2.1 implementation, pack artifacts, type checks, runtime/transform suites, browser matrix, and package-size budgets pass qualification. The benchmark is inconclusive at this scale, with no repeatable material slowdown established. The known managed Fast Refresh limitation remains documented and unchanged pending a dedicated HMR harness and cross-transform comparison. The external Vite `cacheDir` concern remains unconfirmed. Do not publish, tag, or create a GitHub Release as part of this task.
