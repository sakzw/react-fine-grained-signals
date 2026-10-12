# v0.2.1 Fast Refresh root-cause closure

## Finding

The missing Fast Refresh signature is an Oxc React Refresh behavior for Hook calls nested in a `TryStatement`: the transform emits the signature helper and component registration, but omits the component's Hook signature. A plain React control with Hooks inside `try/finally` reproduces this under the same Vite/Oxc/React stack; RFSG managed and Preact do too, while top-level Hooks in ordinary React and RFSG inject pass.

That reproduction does **not** establish that Hooks in `try/finally` are supported React code. React's official [Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks) explicitly prohibit calling Hooks inside `try`, `catch`, or `finally`. The plain React case is only a compiler-isolation control, and it violates that rule as well. Separately, RFSG managed currently moves authored component statements, including authored Hooks, into a generated `try` block to guarantee `finish()` cleanup. That is an RFSG managed-mode design constraint and should not be described as an upstream-only issue. The Oxc signature omission explains the observed HMR behavior for this generated shape; it does not make that Hook placement compliant.

The managed `try/finally` placement exists in the v0.2.0 tag and is unchanged in the v0.2.0-to-v0.2.1 source diff; it is pre-existing, not a v0.2.1 regression. The Oxc signature interaction was newly exposed by this audit. No managed-transform redesign was attempted. Moving `finish()` away from `finally` can skip cleanup on throws or Suspense; wrapper components or Hook replay can alter React and React Compiler semantics.

## Reproduction matrix

The browser harness compares these variants. The Oxc variants use Vite 8.3.1, `@vitejs/plugin-react` 6.1.2, React and React DOM 19.3.0, and Preact Signals React transform 0.8.3 / signals 3.12.0 where applicable. The Babel compatibility fixture uses Vite 6.4.4, `@vitejs/plugin-react` 4.7.0, and Babel 7.29.7, so it is not a same-generation compiler comparison.

| Variant | Hook location / transform | JSX edit | Add/remove/reorder Hook |
| --- | --- | --- | --- |
| `normal-oxc` | Plain React, top-level Hooks | Pass, state preserved | Pass |
| `normal-try-oxc` | Plain React, Hooks inside empty `try/finally` | Pass | Known failure: signature absent; React Hook-order errors |
| `managed-oxc` | RFSG managed inserts scope and wraps user body in `try/finally` | Pass; signal update and unmount cleanup pass | Known failure: same signature gap and Hook-order errors |
| `inject-oxc` | RFSG inject; Hooks remain top-level | Pass; signal update and unmount cleanup pass | Pass |
| `preact-oxc` | Preact Signals transform under same Vite/Oxc stack | Pass | Known failure: same signature gap and Hook-order errors |
| `managed-babel` | RFSG managed using legacy Babel fixture | Pass | Pass in this fixture; compiler generations differ |

The matrix exercises four edits per variant (JSX-only, hook addition, hook removal, and hook reorder), for 24 browser cases. The expected Oxc limitations are exact-allowlisted as nine cases: add/remove/reorder for `normal-try-oxc`, `managed-oxc`, and `preact-oxc`. They are emitted as `known-failure`. New errors fail the harness, and an allowlisted case that starts passing is reported as a pass. The JSX-only cases and all other behavior remain ordinary assertions.

## Signature and registration

Oxc emits the module-level `var _s = $RefreshSig$()` helper and calls `_s()` while executing the transformed component, but for the plain `try/finally` control and RFSG managed it omits the component attachment `_s(Counter, "<signature>")`. In contrast, it still emits `$RefreshReg$(_c, "Counter")`. Registration associates a component type with its Refresh family; the signature separately describes Hook/custom-Hook compatibility and whether state can be preserved. Registration alone therefore does not force a remount when Hook shape changes. Without the attached signature, the runtime attempts an in-place update and React reports “Rendered more/fewer hooks” or a Hook-order change.

The `normal-try-oxc` control demonstrates that an empty `finally` is not required to trigger the Oxc signature omission: nesting Hook calls under a `try` statement is sufficient. This is diagnostic evidence for Oxc's analysis, not a claim that the source is valid under React's Rules of Hooks. The issue is not RFSG's signature name, the managed runtime scope, or a missing component registration.

## Transform order and RFSG behavior

RFSG's Vite hook is ordered `pre`, so it mutates the source before Vite's React/Oxc refresh transform. In managed mode, `applyManaged()` inserts `useManagedSignals()` before the try block, relocates parameters, and wraps the original user statements in `try/finally` so `_signals.finish()` runs for normal return, thrown errors, and Suspense. It replaces the existing function body's AST in place rather than replacing/cloning the component function object.

That last detail is the fix made by Preact Signals [Issue #626](https://github.com/preactjs/signals/issues/626) / [PR #628](https://github.com/preactjs/signals/pull/628): preserve the function identity so Fast Refresh's function cache can associate edits with the existing component. RFSG already preserves that identity. Repeating the PR's function-identity fix would not address the missing Oxc signature attachment.

The current Vite React plugin enables Oxc JSX React Refresh in Vite 8. The same-stack controls and transformed output show the failure after RFSG's pre-transform, during Oxc signature analysis. Oxc's [React Refresh transformer documentation](https://oxc.rs/docs/guide/usage/transformer/jsx.html#react-refresh) describes signature generation but does not document a try-statement-specific fallback.

## Workaround assessment

There is no safe automatic RFSG workaround established by this investigation. Using RFSG `inject` mode avoids the problematic nesting and passes the matrix, but it changes the selected tracking mode and is a user-controlled alternative rather than a transparent managed-mode fix. React Refresh's `@refresh reset` directive is documented to force state reset on each edit ([API documentation](https://github.com/pmmmwh/react-refresh-webpack-plugin/blob/main/docs/API.md)); it would discard local state and its handling by this exact Vite/Oxc stack has not been verified. It is not implemented or recommended as a default workaround. No workaround changes runtime/SSR/Hook-ordering/cleanup behavior.

## Minimal upstream reproduction and suggested report

Run in a Vite 8.3.1 project with `@vitejs/plugin-react` 6.1.2 and React 19.3.0, then edit the Hook list:

```tsx
import { useState } from 'react';

export function Counter() {
  try {
    const [value, setValue] = useState(0);
    return <button onClick={() => setValue((n) => n + 1)}>{value}</button>;
  } finally {}
}
```

The transformed module emits `$RefreshSig$()` and `$RefreshReg$` for `Counter`, but no `_s(Counter, signature)` attachment. Adding/removing a Hook during HMR attempts to update the existing component and produces a React Hook-count error. A plain React component without the `try` passes; the same plain component with the empty `try/finally` fails, though that control also violates the official Hook rule. RFSG managed is a second reproducer; Preact Signals under the same Oxc stack is a third. RFSG inject passes.

Suggested issue title: **React Refresh signature is omitted when Hooks are nested in a TryStatement**.

Suggested request: when analyzing this input, either collect Hook/custom-Hook calls through `TryStatement` bodies or emit a safe reset/invalidation fallback when the transform cannot establish a compatible signature. Preserve component registration, but do not treat registration alone as proof that state is safe to preserve. The report should state that this syntax violates React's Rules of Hooks and that the sample is a transform-robustness reproducer, not a supported usage recommendation. No upstream issue has been filed as part of this task.

## Verification and disposition

The Fast Refresh runner now closes each Vite server after its four cases, then closes any remaining servers sequentially in `finally`; it does not force process exit. It fails unless the matrix contains exactly 24 cases, all 9 allowlisted Oxc signature failures are reproduced, all other 15 pass, and there are no unexpected browser errors. Its final Chromium rerun exited 0 with the expected 9/15 split and a completed close for all six servers.

The actual Vite `8.3.1` dev-transform smoke test also passed: the warning was delivered once, Vite displayed its message and code frame at `123.jsx:2:15`, and `transformRequest()` returned transformed code without throwing. The logger interface exposes the formatted warning string rather than the raw adapter object; the repository's adapter regression test covers the structured `{ code, message, loc }` passed into the Rollup/Vite warning context. Rollup, esbuild, webpack, and Rspack executables are not installed or present in this checkout's lockfile, so independent builds for those adapters could not be run. unplugin's installed webpack/Rspack context normalizes warnings to `Error` using `message` and `stack`, so structured `code`/`loc` are not guaranteed by those APIs; the diagnostic message/code frame remains the available location channel. No unsupported bundler was installed during this audit.

`pnpm lint`, `pnpm typecheck`, and `pnpm build` passed on the final tree (lint/build retain existing advisory warnings; pnpm warns this project requests Node 24.20.0 while the environment runs 24.21.0). The unplugin transform suite passed all 5 files and 357 tests with 3 existing skips when run with one worker; a two-worker rerun passed 3 files/306 tests but had two worker-start timeouts. This matches the earlier full runtime run, which had one test timeout and two worker-start timeouts (475/476 passed); the timed-out control-flow file passed all 9 tests when isolated. The latest GitHub Actions Test and E2E checks are reported successful by the user.

The consumer smoke was attempted again but could not complete locally: `pnpm pack` invoked a stale, missing `C:\Users\catro\AppData\Local\Volta\tools\image\pnpm\12.3.4\bin\pnpm.cjs` from the environment's lifecycle `npm_execpath`. Earlier in this audit cycle, the same packed-runtime/plugin and duplicate-package smoke passed. The latest GitHub Actions Test is green per the user. The local `pnpm test:browser` attempt in the prior audit timed out waiting 120 seconds for its configured webServer; the latest GitHub Actions E2E is green per the user and covers 54 tests. GitHub Actions could not be independently queried from this environment because GitHub CLI access failed at the configured network proxy.

**Disposition: no v0.2.1-specific Fast Refresh regression has been identified. A conditional freeze is reasonable only if the release notes explicitly accept both the pre-existing managed-mode Hook placement constraint (generated Hook calls sit inside `try`, contrary to React's documented rule) and its Oxc Fast Refresh Hook-shape limitation.** This does not claim general Rules-of-Hooks compliance for managed output or successful managed Hook-shape refresh. Latest GitHub Actions Test and E2E successes are user-provided context; standalone non-Vite bundler smoke remains unverified because those bundlers are unavailable locally.
