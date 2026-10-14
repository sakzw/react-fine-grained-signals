# M8 — Post-freeze review closure status (2026-10-14)

## Final registered-symbol regression closure (2026-10-14)

Review baseline: `3b47d4e2f4b558f806f7751d73edffd3a6654181`. The regression was caused by treating every symbol as a valid weak key when the runtime supports non-registered symbol keys. Native behavior was checked on Node v24.21.0: `Symbol.for()` keys throw in WeakMap/WeakSet, while local `Symbol()` and well-known symbols such as `Symbol.iterator` are accepted. `isWeakCollectionKey()` now excludes registered symbols with `Symbol.keyFor()`; they use the existing strongly-held, sweepable primitive-key metadata path. Invalid weak writes continue to be delegated to native collections.

Added runtime coverage for reactive Map `get`/`has`, Set `has`, registered-symbol add/update/delete notifications, native WeakMap/WeakSet key acceptance and TypeError parity, local and well-known symbols, object-key cleanup, and 300 registered-symbol subscriptions followed by unsubscribe cleanup and key reuse. Japanese links now use the actual Japanese heading anchors.

Qualification on the final local source: focused symbol/sweep tests passed (2 files, 6 tests); runtime coverage passed (40 files, 571 tests; statements 93.16%, branches 88.53%, functions 97.41%, lines 94.98%); transform coverage passed (8 files, 404 tests; statements 92.71%, branches 90.03%, functions 97.35%, lines 95.42%). Coverage thresholds were unchanged. Typecheck, lint, build, browser E2E (59/59), consumer pack/smoke, cross-copy and mixed-version tests, and all seven bundle budgets passed in the closure qualification. Independent static review found no blocker; the reviewer could not rerun tests in its sandbox.

The collection benchmark was repeated at 10k subscribed primitive keys. Two runs measured update/add/delete at 319,642/270,362/338,166 ns and 168,348/89,372/126,434 ns respectively; the earlier single baseline was 144,812/172,428/191,268 ns. This spread is too noisy to claim a stable regression or improvement, and the benchmark uses string keys, so it does not exercise the new registered-symbol branch. The symbol-key sweep test verifies bounded synchronous work and eventual cleanup instead. No memory-retention claim is inferred from the noisy heap deltas.

This change is committed locally on `main` and was not pushed, per the current no-push instruction. The GitHub Test/E2E runs listed below cover the earlier managed-tracking closure commit, not this symbol-key fix. Therefore the local candidate is re-frozen, while a post-fix GitHub Actions run remains a release qualification blocker until CI runs on this change.

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

## Prior freeze decision

The earlier review closure re-froze M8 at package version 0.3.0 after local qualification and successful GitHub Actions runs. The final symbol-key closure above supersedes that code qualification for the current local `main` state.

No release tag, npm publish, or GitHub Release was created. The current local re-freeze is backed by the local qualification above; the post-symbol-fix GitHub Actions check remains outstanding.
