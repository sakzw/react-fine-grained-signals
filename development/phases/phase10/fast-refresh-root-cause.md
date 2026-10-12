# v0.2.1 Fast Refresh root-cause closure

## Finding

The reproduced Hook-structure failure is an Oxc React Refresh signature limitation for Hook calls nested in a `TryStatement`, not an RFSG-managed tracking regression. The same failure occurs in a plain React control inside `try { ... } finally {}` with no RFSG transform. RFSG managed and Preact's transform produce the same Oxc failure because both place Hook calls inside a try/finally region. Ordinary React and RFSG inject, whose Hook calls remain at the component's top level, pass under that same Vite/Oxc/React stack.

This remains a Fast Refresh limitation for managed mode. No safe RFSG-only production transform was identified: moving `finish()` away from `finally` can skip cleanup on throws or Suspense, while introducing/removing a wrapper component or replaying Hooks changes React/React Compiler semantics. The existing managed tracking behavior therefore remains intact.

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

The `normal-try-oxc` control demonstrates that an empty `finally` is not required to trigger the issue: nesting Hook calls under the `try` statement is sufficient. The issue is not RFSG's signature name, the managed runtime scope, or a missing registration.

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

The transformed module emits `$RefreshSig$()` and `$RefreshReg$` for `Counter`, but no `_s(Counter, signature)` attachment. Adding/removing a Hook during HMR attempts to update the existing component and produces a React Hook-count error. A plain React component without the `try` passes; the same plain component with the empty `try/finally` fails. RFSG managed is a second reproducer; Preact Signals under the same Oxc stack is a third. RFSG inject passes.

Suggested issue title: **React Refresh signature is omitted when Hooks are nested in a TryStatement**.

Suggested request: collect Hook/custom-Hook calls through `TryStatement` bodies for Refresh signature generation, or emit a safe reset/invalidation fallback when the transform cannot establish a compatible signature. Preserve the component registration behavior, but do not treat registration by itself as proof that state is safe to preserve. Include the plain React reproducer and transformed output in the upstream report. No upstream issue has been filed as part of this task.

## Verification and disposition

The root repository lint fix removes two unused declarations from `fast-refresh-harness/run.mjs`; `pnpm lint`, `git diff --check`, and `node --check development/phases/phase10/fast-refresh-harness/run.mjs` pass (lint retains existing warnings). `pnpm typecheck` and `pnpm build` pass. Consumer smoke passes for the packed runtime and plugin entries, including the genuine duplicate-package runtime smoke.

The browser matrix produced all 24 case results: the 15 unaffected cases passed and the 9 specifically allowlisted Oxc Hook-shape cases matched their documented failures. The runner emitted the final result set, but Vite server shutdown did not return, so the process was interrupted and no successful process exit code was obtained. The browser evidence still includes the same-stack normal React `try/finally` control, inject and Babel successes, and managed/Preact Oxc failures.

The full runtime run reported 475/476 tests passing across 35 files. One `control-flow.test.tsx` case hit its 5-second test timeout, and two worker processes timed out starting. Running that file alone passed all 9 tests, including the timed-out keyed reorder case. The transform suite passed all 5 files and 357 tests, with 3 existing skips; this includes the React Compiler tests. Thus the remaining full-runtime result is consistent with local worker/load timeouts, but the full runtime command did not exit cleanly.

The local `pnpm test:browser` attempt timed out waiting 120 seconds for its configured webServer. The user reports the latest GitHub Actions browser run passed all 54 tests; Actions could not be independently queried from this environment because GitHub CLI access failed at the configured network proxy. Treat the local timeout as an environment/startup limitation rather than a product regression, with the successful CI run as the stronger E2E signal.

**Disposition: upstream-originated limitation; hold the v0.2.1 freeze decision for user acceptance of the documented managed-mode Fast Refresh restriction.** This is not a freeze candidate that includes successful managed Hook-shape refresh. The independent GitHub CI E2E result of 54/54 is user-provided context; local GitHub Actions retrieval was unavailable in this environment.
