# M8 — Post-freeze review closure status (2026-10-14)

## Review baseline and fixes

Review baseline `2c688ac8e23f711905b9db71dd7255dca0dfdf95` had two confirmed release blockers: the Test workflow passed all 556 runtime tests but failed its runtime coverage thresholds, and the E2E workflow had one stale React Router row after “complete all”. This closure added behavior-focused runtime and transform regressions, restored explicit ambient tracking for deep proxy reads in managed components, bounded collection metadata sweep work, and expanded the bilingual managed migration guidance. Changes are integrated on `main` and pushed to `origin/main` at `03be0e96cb12f526baa63a93d93c863b8fabf53a`.

The v0.2.1/v0.3.0 comparison used the same keyed-row React consumer fixture. v0.2.1 passed; the unmodified v0.3.0 baseline rendered a stale `task-row`; the fix preserves explicit `useSignalTracking()` calls through managed codegen, and the fixture now passes. The compatibility matrix and migration details are in the [managed tracking migration guide](../../docs/migration/v0.3.ja.md).

## Qualification completed after review fixes

- Full coverage: `pnpm test:coverage` passed. Runtime: 39 files, 566/566 tests; statements 92.94%, functions 97.41%, lines 94.98%. Transform: 8 files, 404/404 tests; statements 92.71%, branches 90.03%, functions 97.35%, lines 95.42%. Thresholds and exclusions are unchanged.
- Typecheck and build: `pnpm typecheck` and `pnpm build` passed. The transform package's typecheck now sets `jsx: react-jsx`, because its React execution fixture imports the runtime's TSX utility. `pnpm lint` passed with existing warnings and no errors.
- Packaging and interop: runtime and transform builds passed; `pnpm test:consumer` packed both 0.3.0 packages, installed them in a clean consumer, and passed the Vite/TypeScript smoke. Three-copy interop and mixed-generation 0.1.1 smoke passed.
- React Compiler and Fast Refresh: the full transform suite passed. The real-browser HMR harness completed 24 cases: 18 passed and six reproduced the already documented Vite/Oxc Refresh-signature limitation in non-RFGS control variants; all four managed Babel cases passed. Managed Oxc and inject Oxc scenarios passed their supported cases.
- Browser E2E: all 59 Playwright cases passed with `CI=true` and one worker: 48 development cases across Chromium/Firefox/WebKit, four production-build cases, and seven React Router cases, including the previously stale TaskRow behavior. Local pnpm's Playwright webServer subprocess resolves a missing Volta pnpm 12.3.4 shim, so the same Playwright config was run through the installed Node CLI with direct-Node webServers. The dev harness now scopes Vite's root to `examples/browser` and uses the matching `/src/entry-client.tsx` URL; this keeps dependency discovery out of generated monorepo fixtures and fixes the local SSR module-runner timeout. A five-worker exploratory matrix had one WebKit Activity hidden-reader assertion fail (58/59); the isolated test and full CI-serial matrix both passed. The test remains enabled and unchanged; this is recorded as a local parallel-load flake, not a waived behavior.
- Bundle size: all seven configured gzip budgets passed. Collection sweep quick benchmark (5 samples) measured 10k subscribed primitive keys at median 144,812 ns/update, 172,428 ns/add, and 191,268 ns/delete. The sweep yields after 128 synchronous candidates and resumes in timer tasks. Heap deltas remained noisy and are diagnostic only; no precise retention or leak-free claim is made.
- `git diff --check` passed after the final edits.

## GitHub Actions status

The post-fix workflows ran against pushed commit `03be0e96cb12f526baa63a93d93c863b8fabf53a`: [Test run 38482796213](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38482796213) passed, and [E2E run 38482796188](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38482796188) passed. The baseline failures remain available for comparison: [Test run 38468534814](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38468534814) failed at the original coverage gate, and [E2E run 38468534839](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38468534839) had the stale-row failure.

## Freeze decision

M8 is **re-frozen** at package version 0.3.0. Every requested local qualification gate passed after the review fixes, including the full coverage gate and the CI-serial 59-case browser E2E matrix. The post-fix GitHub Test and E2E workflows also passed. The five-worker WebKit transient was retained in the evidence and did not recur in the isolated test, full CI-serial matrix, or GitHub E2E workflow.

No release tag, npm publish, or GitHub Release was created. This freeze is backed by both local qualification and the successful GitHub Actions runs above.
