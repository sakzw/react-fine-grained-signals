# v0.2.1 pre-freeze correctness and compatibility closure

Date: 2026-10-12  
Repository: `sakzw/react-fine-grained-signals`

## Scope and revision range

- Audit baseline (`main`, before this closure): `b51481dd49d2a3b8cb5a1379e7503258694bec14`.
- Comparison baseline: tag `v0.2.0`, commit `2319affd78e9b6585dd410f31bba1090e3258412`.
- Source changes made during this closure: preserve the plugin-context receiver when forwarding transform warnings; add a regression assertion for receiver-sensitive warning APIs; extend the nullish `title` / `id` binding tests to StrictMode, Activity hide/reveal, and Suspense reveal.
- Source and regression-test fix commit: `878bfea5dc732ef36b485fb89b5eedf580794dbf`.
- Fast Refresh reproducibility harness commit: `256c19b034bb2e52d94cd808594134f880fdcc33`.
- End-of-investigation code and harness SHA: `15cfe88` (`test: stabilize refresh browser navigation`). The following documentation-only commit adds this report.

This is a freeze-readiness review, not a release. No npm publish, Git tag, or GitHub Release was made.

## Fast Refresh investigation (priority workstream)

Real Vite dev servers and Playwright-driven source edits were used. The matrix used React and React DOM `19.3.0`. Oxc scenarios used Vite `8.3.1` with `@vitejs/plugin-react` `6.1.2`; the Preact comparison used `@preact/signals-react` `3.12.0` and `@preact/signals-react-transform` `0.8.3`. The final isolated Babel comparison fixture uses Vite `6.4.4`, `@vitejs/plugin-react` `4.7.0`, and Babel `7.29.7`. The Babel case necessarily used a different Vite/plugin generation, so it is not a compiler-only A/B comparison.

The initial isolated Babel fixture versions were updated after `npm audit` identified vulnerabilities in Vite `6.4.1` and Babel `7.28.4`; the lockfile now resolves Vite `6.4.4` and Babel `7.29.7`, `npm ci` completed, and the final fixture audit reported zero vulnerabilities. The harness prints these pinned versions.

Scenarios edited the component source on disk and observed the browser after HMR: JSX-only edits, Hook addition/removal/reordering, signal updates, state behavior, and hide/unmount/update/remount. This was not judged from transformed-code snapshots alone.

The final 16-case run completed with 10 passing cases and six reproducible Hook-shape failures: all four `inject` cases and all four managed+Babel cases passed; managed+Oxc and Preact+Oxc each passed JSX-only but failed Hook addition/removal/reordering. The runner exits nonzero because it treats any of those observed failures as a failing compatibility assertion. Its Browser launch and all sixteen page navigations completed; the earlier first attempt's single Babel navigation timeout did not recur after the harness navigation change.

| Transform / Refresh stack | Observed result |
|---|---|
| RFSG `managed` + Vite/Oxc Refresh | JSX-only edit preserved local state and signal updates/cleanup worked. Adding a `useState` produced `Rendered more hooks than during the previous render`; removing a Hook produced `Rendered fewer hooks than expected`; reordering Hooks reported a changed Hook order and did not safely remount (the prior local state remained). |
| RFSG `inject` + Vite/Oxc Refresh | JSX-only edit and Hook addition/removal/reordering passed. No browser error occurred and the page boot count stayed at one. |
| Preact Signals React transform + Vite/Oxc Refresh | JSX-only edit passed. Hook addition/removal reproduced React Hook-count errors; reorder reported changed Hook order and retained stale local state. |
| RFSG `managed` + Vite/Babel Refresh | JSX-only edit preserved local state. Hook addition, removal, and reorder safely reset/remounted without Hook-order warnings/errors. Signal updates and hide/unmount/update/remount passed. |

The reproduced Oxc failure is in the existing managed transform's emitted structure: `useManagedSignals()` is inserted as a Hook, and the user's Hooks are enclosed in generated `try/finally` so the tracking store is finished on return and throw. The Oxc output contained `var _s = $RefreshSig$();` and registered the component, but did not emit a populated signature call for `Counter`; only `App` received a call such as `_s(App, "C73aK8reHgkEJVDbutS4rCmYY04=")`. The Refresh runtime therefore had no `Counter` Hook signature to compare when the source Hook shape changed. The Preact transform also generates a tracking Hook with a try/finally boundary and showed add/remove errors and stale state after reorder in the same Oxc stack. Babel Refresh emitted recognized signatures for the managed body and handled the tested Hook edits in its older Vite/plugin stack. These runs associate the failure with the tested Oxc Refresh path and transformed Hook layout; they do not prove whether Oxc, Vite, plugin-react, or their interaction is solely responsible.

No fix is included. Moving/removing the `try/finally` boundary risks the managed mode's guaranteed cleanup around return/throw and its concurrent/SSR lifecycle. Moving Hook calls outside that boundary violates the component's top-level Hook ordering. A custom Refresh signature or HMR reset would couple the transform to Refresh internals and has not been validated across bundlers or with React Compiler. A workaround that changes the default to `inject` would change the public mode contract and is not accepted. Signal writes, render subscriptions, hidden-component non-rerender, and remount updates passed on the tested paths. The harness is preserved at `development/phases/phase10/fast-refresh-harness/`; run `pnpm install --frozen-lockfile --ignore-scripts`, `npm ci --prefix development/phases/phase10/fast-refresh-harness/legacy`, `pnpm build`, then `node development/phases/phase10/fast-refresh-harness/run.mjs`. Until a safe cross-transform fix and regression coverage exist, the demonstrated managed + Oxc Hook-edit failure is a release blocker.

## JSX `title` / `id` audit

An independent audit compared `v0.2.0...main`, reviewed binding ownership and cleanup, and tested signal-to-plain-to-signal transitions, two props sharing one nullable signal, StrictMode, HTML and SVG hosts, and SSR-to-hydration updates/removal. Those probes passed; the independent worktree was clean after temporary probes were removed.

This closure adds maintained tests for nullish initial values and updates in StrictMode, Activity hide/reveal, and Suspense reveal. The focused `react-dom-binding` suite passed 29/29. The React DOM integration still uses its existing host/ref cleanup path; the audit found no stale binding replacing React's later plain-prop update.

## Transform diagnostics audit and fix

An independent adapter audit reproduced a P1 defect in Vite `8.3.1` development mode. In `mode: "all"`, transforming an anonymous default JSX export crashed with `TypeError: Cannot read properties of undefined (reading '_formatLog')`. The transform had extracted `this.warn` and later called it without its receiver. Vite production build emitted the warning/code frame successfully, so the failure was development-specific.

The source now invokes the warning method with the plugin context as its receiver (`warn.call(this, ...)`). The existing warning-routing test now uses a receiver-sensitive `warn` method and asserts its context. Post-fix independent review passed: the focused regression passed (1 passed, 50 skipped), and an actual Vite dev transform completed while printing the expected warning, Babel code frame, and Vite file/line/column. Context-free direct transform calls retain their console fallback. The routed warning remains single-delivery with code `RFGS`, location, and code frame; `auto` / `all` / `manual` anonymous-export gates were checked through the adapter audit.

Adapter coverage by evidence:

| Adapter | Evidence |
|---|---|
| Vite | Actual Vite 8.3.1 dev transform before and after the fix; actual Vite production build; external-cacheDir browser fixture. |
| Rollup | Shipped Rollup adapter hook invoked directly; warning gating, receiver, location, code frame, and fallback checked. A standalone Rollup executable was not installed, so a Rollup build was not run. |
| webpack / Rspack / esbuild | Source/API-path inspection only; standalone adapter runtimes were unavailable. Runtime warning/rebuild behavior is unverified. |

Repeated Vite HMR warning delivery could not be isolated: the second direct Vite plugin-container transform failed first with Vite's `ERR_OUTDATED_OPTIMIZED_DEP`. No warning deduplication guarantee is claimed.

## Packaging and compatibility audit

The independent packaging audit confirmed the intended ESM-only exports and no missing export/dependency in the audited diff. Root `engines.node >=22.0.0` remains broad. The plugin's `^22.18.0 || >=24.11.0` constraint matches the Babel 8 dependency requirements. `devEngines.runtime` remains a warning-only development toolchain check, and the lockfile removes only the pinned runtime download/enforcement entry. No CommonJS support was added.

The repository consumer smoke actually packed both v0.2.1 packages, installed them in a clean consumer, typechecked TypeScript, and built with React `19.2.8` / Vite `8.2.2`; both package exports were exercised. The isolated audit's `npm pack --dry-run --ignore-scripts` did not contain `dist` and is not used as artifact proof. Mixed-version smoke against runtime `0.1.1` completed and confirmed the documented unsupported cross-generation signal interop boundaries.

## External Vite `cacheDir` and browser evidence

A dedicated Vite `8.3.1` fixture places `cacheDir` at `development/phases/phase10/pre-freeze-cacheDir/.vite-cache`, outside `node_modules`; the fixture opts into `react`, `react-dom/client`, and `alien-signals/system`. It ran a real Chromium page, waited for optimizer metadata, edited the entry file on disk from `cacheDir-HMR-A` to `cacheDir-HMR-B`, and observed the HMR-updated page with no browser errors. Optimized entries observed: `alien-signals/system`, `react-dom/client`, `react`, and `react/jsx-dev-runtime`. A real `mode: "all"` warning-producing dev transform also completed in this fixture after the fix. The runner restores its source and removes generated cache output in `finally`.

The full repository Playwright suite was attempted but its configured web server did not become ready within 120 seconds. Direct startup instrumentation showed Vite server creation completed, then `vite.ssrLoadModule("/examples/browser/src/entry-server.tsx")` did not return under the current checkout/environment (also reproduced with the installed Node 24.21 executable); the server did not reach its listen log. Thus this closure does not claim a fresh full-suite result. The previous qualification's browser result is retained only as prior evidence, not a rerun for this closure.

## Regression and build verification

Commands were run on this checkout with Node `24.19.0`; the repository warns that its pinned `devEngines.runtime` is `24.20.0`. This mismatch did not stop commands. The installed `pnpm` was used with its version-manager shim disabled to avoid a stale Volta-selected pnpm executable.

- Full runtime suite: 37 files, 531 passed.
- Full transform suite: 5 files, 357 passed, 3 skipped.
- Focused nullish title/id DOM suite after adding StrictMode / Activity / Suspense cases: 29 passed.
- Runtime and transform TypeScript checks: passed; runtime typecheck was rerun after the added JSX tests.
- Oxlint: exit 0; existing warnings remain (mostly benchmark/test style warnings). The generated external Vite cache was removed before the clean lint run.
- Runtime and plugin builds, including build smoke: passed.
- React Compiler tests: 19 passed.
- Clean packed consumer smoke: passed for both packages; TypeScript and Vite production build passed.
- Mixed-version smoke: passed with the documented cross-version limitations.
- Size budgets: all satisfied (signal 7.10 kB gzip; full index 16.73 kB gzip; JSX runtime 10.98 kB gzip, within the recorded budgets).
- External-cacheDir Vite/Chromium HMR and warning-transform fixture: passed.
- Full repository Playwright: incomplete due to the web-server startup stall above.

## Performance

The available same-condition `v0.2.0` tag vs v0.2.1 title/id JSDOM benchmark used Node `24.21.0`, React/jsdom, 100,000 writes per property, one warmup, five measured samples per process, and five paired processes. Paired medians in milliseconds (v0.2.0 / v0.2.1): `604.96/658.74`, `557.95/613.63`, `624.57/533.59`, `627.72/652.81`, `677.15/500.13`. Direction varied and within-process values ranged roughly 430–925 ms. This is inconclusive and supports neither a parity nor a regression claim. The non-null setter still stringifies and assigns the same property; the change only removes nullish attributes.

## Residual risk and freeze status

Unresolved / unverified items:

1. **Release blocker:** managed mode Hook addition/removal/reorder can fail under the tested Vite 8.3.1 + plugin-react 6.1.2 Oxc Refresh stack. No safe fix was established. The Babel comparison passed but is a different Vite/plugin stack; it does not waive the Oxc failure.
2. The full repository Playwright suite did not start; the dedicated real-browser external-cacheDir and Fast Refresh fixtures did run.
3. Standalone Rollup, webpack, Rspack, and esbuild adapter runs were unavailable. Vite HMR warning deduplication is not verified.
4. The v0.2.0/v0.2.1 microbenchmark remains noisy and inconclusive.

**Final status: `BLOCKED`.** Do not freeze v0.2.1 while the demonstrated managed/Oxc Hook-edit failure remains. The user must choose whether to fund a Refresh-aware, cross-stack fix or explicitly accept the documented limitation before freeze is reconsidered. This report does not approve or initiate a release.
