# v0.2.1 Final Freeze Closure

**Disposition: READY_FOR_FREEZE**, conditional on accepting the documented managed-mode Hook / Fast Refresh limitation. This audit found and fixed a warning-forwarding regression in the v0.2.1 diff; no unresolved major correctness regression remains. This is a freeze qualification, not a publish, tag, or GitHub Release.

## Scope and baseline

- Repository baseline: `main` at `710b26c4a67b572a6aa8ca05b30de8f95819b716` (`710b26c`), matching the reported latest `origin/main` at audit start.
- Compared v0.2.0 to the baseline and reviewed the closure diff. No change in managed tracking semantics or broad transform redesign was made.
- GitHub Actions for the closure commit both passed: Test run `38215595734` and E2E run `38215595723` (including `pnpm test:browser`). The user reported the prior baseline E2E covered 54 cases.
- No npm publish, Git tag, or GitHub Release was created.

## Warning API bundler smoke tests

Temporary fixtures and dependencies were kept outside the repository. Each adapter transformed the invalid-signal fixture, emitted exactly one warning, and completed its transform/build successfully.

| Bundler | Version | Result | Diagnostic evidence |
| --- | --- | --- | --- |
| Vite | 8.3.1 | Pass | One warning; message and code frame; source at `123.jsx:2:15`; `transformRequest()` returned transformed code. |
| Rollup | 4.64.5 | Pass | One warning; `PLUGIN_WARNING`, plugin code `RFGS`, message, and `loc` line 2 / column 15; bundle completed. |
| esbuild | 0.28.2 | Pass | One warning; message and native location line 2 / column 15; build completed. |
| webpack | 5.111.1 | Pass after fix | One warning; message, Babel code frame, and source module retained; webpack warning API did not expose structured `loc`. |
| Rspack | 2.2.8 | Pass after fix | One warning; message, Babel code frame, and source module retained; Rspack warning API did not expose structured `loc`. |

The first webpack run exposed a real v0.2.1 warning bridge defect: the source-map loader called `String()` on unplugin's structured warning object, reducing its message to `[object Object]`. `toError()` now constructs the `Error` from the object's `message` and preserves `code` and `loc` metadata for `emitWarning`. A regression test exercises the structured warning through the loader and asserts successful transform plus retained message, code, and location. Webpack and Rspack reruns both passed without duplicate warnings. Their warning APIs supplied the source frame/resource rather than a structured location field, which is their native diagnostic format.

## Fast Refresh disposition

The 24-case Chromium harness completed normally with exit code 0 and closed all six Vite servers. It currently reports 15 passes and 9 allowlisted Oxc signature failures. The allowlist recognizes only the known Hook-order failure shape; it does not require those nine failures to continue. If upstream behavior improves and an allowlisted case passes, it is reported as a normal pass. Any unexpected failure remains fatal.

This limitation predates v0.2.1 and is distinct from Oxc's signature-analysis behavior: managed mode itself generates a `try/finally` around the component body, placing authored Hook calls inside that construct for synchronous tracking cleanup. React's official Rules of Hooks exclude Hook calls in `try`, `catch`, and `finally`. In the audited Vite 8 / Oxc setup, the Refresh transform registers the component but omits its Hook signature for this structure; edits that add, remove, or reorder Hooks can retain stale state and trigger a Hook-order failure. A plain React control reproduces the Oxc signature omission, while also being outside the official Hook rule. Thus the evidence shows an interaction between Oxc's analysis and an RFSG-generated structure that is itself outside the rule. `inject` passed the audited fixture and avoids the generated boundary, but its bare `useSignalTracking()` Hook does not offer managed mode's exact synchronous `try/finally` contract.

No unsafe workaround or managed-transform redesign is included. The release notes and package README now state these distinctions and the limitation explicitly. See [fast-refresh-root-cause.md](fast-refresh-root-cause.md) for the fixture matrix and analysis.

## Final quality gate

Checks on the final code state:

- `pnpm lint`: passed (existing advisory warnings; environment Node is 24.21.0 while project requests 24.20.0).
- `pnpm build`: passed for runtime and plugin.
- `pnpm --filter unplugin-react-fine-grained-signals typecheck`: passed.
- Transform package tests with threads pool: 5 files, 358 passed, 3 skipped. Focused loader test: 49 passed, 3 skipped.
- `pnpm test:consumer`: passed using a temporary empty `VOLTA_HOME` to bypass a stale local Volta `npm_execpath`; packed runtime/plugin entry checks, TypeScript check, Vite production build, and duplicate-runtime interop passed.
- Fast Refresh harness: 24 cases, 15 current passes / 9 known failures; exit code 0 and graceful Vite shutdown.
- Real Vite, Rollup, esbuild, webpack, and Rspack warning smoke builds: passed as detailed above.
- `git diff --check`: passed before commit.
- Final closure commit CI: Test `38215595734` passed; E2E `38215595723` passed, including the browser suite.

The earlier full runtime check had one timeout (475/476); the isolated control-flow test passed all 9 cases. A forks-pool transform run also encountered a worker-start timeout, while the complete threads-pool run passed. These local runner issues are recorded rather than interpreted as product failures; the reported baseline GitHub CI was green.

## Freeze decision

**READY_FOR_FREEZE** if the project accepts the pre-existing managed-mode Hook placement and resulting Oxc Fast Refresh limitation as explicitly documented. No v0.2.1-introduced major correctness regression remains after the webpack/Rspack warning message-loss fix. The Fast Refresh limitation is an accepted known issue; it is not a reason for indefinite investigation. This decision does not authorize or perform publication, tagging, or release creation.

Final audited commit: this freeze-closure commit on `main`; its resolved SHA is recorded in the completion report accompanying this document.
