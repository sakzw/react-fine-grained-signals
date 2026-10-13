# M8 — Post-freeze review closure status (2026-10-14)

## Review baseline and fixes

Review baseline `2c688ac8e23f711905b9db71dd7255dca0dfdf95` had two confirmed release blockers: the Test workflow passed all 556 runtime tests but failed its runtime coverage thresholds, and the E2E workflow had one stale React Router row after “complete all”. This closure added behavior-focused runtime and transform regressions, restored explicit ambient tracking for deep proxy reads in managed components, bounded collection metadata sweep work, and expanded the bilingual managed migration guidance. Changes are integrated on local `main`; no remote publication action was taken.

The v0.2.1/v0.3.0 comparison used the same keyed-row React consumer fixture. v0.2.1 passed; the unmodified v0.3.0 baseline rendered a stale `task-row`; the fix preserves explicit `useSignalTracking()` calls through managed codegen, and the fixture now passes. The compatibility matrix and migration details are in the [managed tracking migration guide](../../docs/migration/v0.3.ja.md).

## Qualification completed after review fixes

- Full coverage: `pnpm test:coverage` passed. Runtime: 39 files, 566/566 tests; statements 92.94%, functions 97.41%, lines 94.98%. Transform: 8 files, 404/404 tests; statements 92.71%, branches 90.03%, functions 97.35%, lines 95.42%. Thresholds and exclusions are unchanged.
- Typecheck and build: `pnpm typecheck` and `pnpm build` passed. The transform package's typecheck now sets `jsx: react-jsx`, because its React execution fixture imports the runtime's TSX utility. `pnpm lint` passed with existing warnings and no errors.
- Packaging and interop: runtime and transform builds passed; `pnpm test:consumer` packed both 0.3.0 packages, installed them in a clean consumer, and passed the Vite/TypeScript smoke. Three-copy interop and mixed-generation 0.1.1 smoke passed.
- React Compiler and Fast Refresh: the full transform suite passed. The real-browser HMR harness completed 24 cases: 18 passed and six reproduced the already documented Vite/Oxc Refresh-signature limitation in non-RFGS control variants; all four managed Babel cases passed. Managed Oxc and inject Oxc scenarios passed their supported cases.
- Browser E2E: production browser E2E passed 4/4 and React Router E2E passed 7/7, including the previously stale TaskRow behavior. The complete `pnpm test:browser` command could not start because its webServer's nested `pnpm` resolved to a missing Volta pnpm 12.3.4 shim. A direct-Node run of the full local webServer set then timed out while the Vite dev browser server was dependency-optimizing before listen. Thus the 48-case Chromium/Firefox/WebKit development matrix was not requalified after this closure; its earlier M8 pass remains historical evidence, not a current pass.
- Bundle size: all seven configured gzip budgets passed. Collection sweep quick benchmark (5 samples) measured 10k subscribed primitive keys at median 144,812 ns/update, 172,428 ns/add, and 191,268 ns/delete. The sweep yields after 128 synchronous candidates and resumes in timer tasks. Heap deltas remained noisy and are diagnostic only; no precise retention or leak-free claim is made.
- `git diff --check` passed after the final edits.

## GitHub Actions status

GitHub still reports the baseline runs as failed: [Test run 38468534814](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38468534814) failed only at the original coverage gate, and [E2E run 38468534839](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38468534839) had the stale-row failure. The changes are local and the user explicitly prohibited push, so no post-fix Actions run exists. Local coverage and focused browser runs verify both fixes, but do not substitute for a post-fix GitHub run.

## Freeze decision

M8 is **not re-frozen yet**. The coverage and stale-render regressions are fixed and locally verified, but final re-freeze awaits a successful post-fix GitHub Test/E2E run and a rerun of the complete development browser matrix. These require publishing the commits to GitHub, which was explicitly excluded from this task. Do not change this decision to frozen based only on the baseline Actions results or the partial local browser matrix.

No push, release tag, npm publish, or GitHub Release was performed.
