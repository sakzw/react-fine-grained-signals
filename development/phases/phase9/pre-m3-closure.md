# Phase 9 pre-M3 correctness and compatibility closure

This closes the findings of the v0.2.0 release review (reviewed at `b9fda25`; revalidated on `91ad17f`, whose only code delta was comment-only documentation paths). Every review item is classified at the end. Package versions are unchanged; M3 (version bump, RC freeze, tag, publish) has not started.

## Reference study

### Alien Signals 3.2.1

Read from the installed package (`node_modules/alien-signals/esm/index.mjs`, `esm/system.mjs`; upstream commit `8734d386d925025d0e99419bd9161c17b112c5ee`).

- `system.mjs`: `link`, `unlink` (calls `unwatched(dep)` when a dependency's last subscriber leaves), `propagate`, `checkDirty`, `shallowPropagate`, and the `ReactiveFlags` values `None 0`, `Mutable 1`, `Watching 2`, `RecursedCheck 4`, `Recursed 8`, `Dirty 16`, `Pending 32`.
- `index.mjs`: `HasChildEffect = 64`; `effect()` links the new effect as a dependency of the running subscriber (`link(e, prevSub, 0)`) and marks the owner; `run()` / `updateComputed()` unlink child effects before re-running; `effectScopeOper` disposes dependencies, then unlinks itself from its owner; `computedOper` reads lazily and links after updating; `purgeDeps` drops the stale tail; `unwatched` disposes an unwatched computed's dependencies and an unwatched effect. There is no cross-copy notion, no `untracked()` in the high-level API (`setActiveSub(undefined)` is the primitive), and no cycle detection.

### Vue 3.6 (`@vue/reactivity@3.6.0-rc.9`, core `5be279570a844b953dd44b56bdc2426f7421aecd`)

Read from the exact locked bundle (`benchmarks/phase9/node_modules/@vue/reactivity/dist/reactivity.esm-bundler.js`).

- `arrayInstrumentations` and `noTracking()`: `push`, `pop`, `shift`, `unshift`, `splice` run with `startBatch()` and `setActiveSub()` cleared, applied to the proxy so writes still trigger.
- `MutableReactiveHandler`: no `getOwnPropertyDescriptor` trap; `has` tracks `"has"`, `ownKeys` tracks iteration; `set` passes `receiver` to `Reflect.set` and only triggers when `target === toRaw(receiver)`; `deleteProperty` triggers only for own keys; `hasOwnProperty` is instrumented to track `"has"`; inherited names such as `constructor` are tracked like any key.
- `ReactiveEffect`: a nested effect is linked to the active `EffectScope`, not to the parent effect; `stop()` unlinks dependencies and its scope link.
- `pauseTracking()` / `resetTracking()` keep a stack of the active subscriber.

### Behavioral comparison and decisions

| Topic | Alien 3.2.1 | Vue 3.6 | RFSG before | RFSG now | Why |
| --- | --- | --- | --- | --- | --- |
| Nested effects | owned by the running effect/computed | owned by the active `EffectScope` only | flat (the migration review recorded this as equivalent to v0.1.1, which was wrong: v0.1.1 used Alien's high-level `effect` and owned children — verified by running the published v0.1.1) | owned, Alien's mechanism; library-internal subscriptions use a detached effect | v0.1.1 parity; RFSG has no `effectScope`, so flat children leaked one live effect per parent run |
| Self-dispose mid-run | reads after the disposer re-link (same gap) | reads after `stop()` re-link (same gap) | re-linked | all links dropped after the run | a disposed closure must not stay subscribed |
| Cycles | stale value | stale value | direct self-read throws, indirect stale | any read of a computed whose getter is on the stack throws | consistent; one flag check |
| Cold / watched | `subs` presence is enough (no foreign pushes) | n/a | foreign bridges polled only when `subs === undefined`; activated only when an effect read the computed directly | inactive bridges polled on every read of a foreign-dependent computed; a recomputed watched computed activates newly linked bridges | bridge activation is tied to effect watching, not to `subs` |
| `untracked` | clears the local subscriber | stack of the local subscriber | local subscriber only; another copy's untracked owner ignored | reads under the shared `UNTRACKED_OWNER` never link (source, computed, deep) | cross-copy untracked must mean untracked |
| Array mutators | n/a | five mutators run untracked | tracked | all nine mutators run untracked inside the batch | a mutator's reads are not the caller's dependency |
| Own-key checks | n/a | `has`/iteration; descriptor untracked | descriptor tracked the *value* | descriptor tracks *existence*; existence also notifies on ownership change | `Object.keys` must not re-run on value writes |
| Inherited keys | n/a | tracked | untracked | plain objects subscribe to the iteration version; arrays still skip | dictionary keys such as `constructor` stay reactive without per-name versions |
| `set` receiver | n/a | honoured | ignored | honoured | ordinary [[Set]] semantics |

## Results by finding

### B1 — root `createElement`

The package root exports `createSignalAwareElement` as `createElement`: the classic signature, with host-prop bindings and child normalization identical to `jsx`, and `key`/`ref` left in the config for React's own `createElement`. Coverage: `tests/react-review-regressions.test.tsx` compiles `<div {...props} key="k" title={signal} />` through Oxc (Vitest's JSX compiler, with this package as `jsxImportSource`), which emits the root import exactly as TypeScript and Babel do; the packed consumer smoke asserts that the Vite consumer output imports `createElement` from the root and that the packed root exports it. Tree-shaking: re-exporting from `src/runtime/jsx.ts` exposed one top-level array spread (`[...SVG_ELEMENTS, ...MATHML_ELEMENTS]`) that bundlers must keep. It is now built in a `/* @__PURE__ */` IIFE, and `signal-only`, `core`, and `core+hooks` contain no JSX code (checked with marker strings).

### B2 — bare render scope leaking the speculative cache

Two layers. The tracking hooks close their scope from `useInsertionEffect`, which React runs for the whole tree before any layout effect or ref callback, so descendants' commit-phase code is no longer inside the render attempt. Independently, a speculative computed entry is reused only while every dependency it recorded is still at the revision it saw (sources by revision; computeds by revision and clean flags, since a write marks even an unwatched computed dirty or pending; foreign protocols by their own revision). That keeps an attempt that outlives its render (a server render never commits; a discarded render waits for its microtask) from serving a stale value. A first version kept a global write epoch instead; it cost about 12% on `source/unobserved-write` in the paired run and was replaced, so writes pay nothing and the check runs only when an attempt reuses a cached entry. Managed scopes are unchanged (they close in `finally`), and the bare sibling-attribution tests pass unchanged.

### C1/C2 — foreign activation and cold refresh

See the comparison table. Inactive bridges (`unsubscribe === undefined`) are polled on every read of a foreign-dependent computed; active ones are left to their pushes. `updateComputed` activates newly linked bridges when an effect watches the computed (a walk up `subs` to a live effect). Both paths run only for computeds with `foreignDependent` set, so single-copy graphs pay one boolean check.

### C3 — cross-copy `untracked()`

Branded source, DeepSignal source, and computed getters check the shared owner. Under `UNTRACKED_OWNER` a source read updates without linking and a computed read skips the link; the DeepSignal adapter reports no active subscriber. The getter fast path (owner `undefined`) is untouched.

### C4 — generation brand

v0.1.1's `isSignal` trusts any number under `Symbol.for("react-fine-grained-signals.signal")`, and its own comment says a breaking change must take a new key; bumping the number would have left v0.1.1 recognizing v0.2 signals. v0.2 brands under `Symbol.for("react-fine-grained-signals.signal.v2")` (minor version 1). `tests/mixed-version-smoke.mjs` loads the published v0.1.1 artifact (dev alias `react-fine-grained-signals-v0.1`) next to `dist/`: `isSignal` rejects in both directions, JSX children throw in both directions, and direct effect/computed reads across generations stay non-reactive (recorded as unsupported). The same smoke against the pre-change build fails its first assertion.

### D1/D2 and DeepSignal semantics

As in the table. Because of the descriptor change, `Object.getOwnPropertyDescriptor(state, k).value` no longer tracks value changes; `Object.entries`, spread, and JSON still do through [[Get]].

### J1 and host/key identity

`ReactiveHost` is gone. A host element with bindings keeps its host type and gets a transformed props copy whose `ref` is a binding ref. Bindings live in a per-node binder:

- A detach schedules teardown in a microtask, and writes are held while the node is detached.
- A re-attach of the same node in the same commit reconciles bindings in place, so IME state and subscriptions survive, and refreshes their values.
- The user's ref is forwarded synchronously with React's own semantics. Binding refs are cached by user ref (or by first bound signal, bounded to 8 entries), so a stable ref is not churned.

Keys, including keys arriving through a spread, go straight to React's factory on the host element itself.

### J2 — form reset

Bound `value`/`checked` and single or multiple `select` bindings also write `defaultValue`/`defaultChecked`/`defaultSelected`. Native resets and React 19's post-action reset therefore restore the signal's value, which is React's behaviour for controlled inputs (it syncs the `value` attribute).

### J3/J4 — deep signals in root-only positions

Contract narrowed: `DeepSignal` carries a type-only brand, and `useSignalValue`, JSX children, and bound host props accept `ReadonlySignal<T> & NotDeepSignal`. `DeepSignal` remains assignable to `Signal`/`ReadonlySignal`. At runtime, `style` bindings hand React a shallow copy, so React DOM's development freeze can no longer break a deep signal's state. Type tests: `tests/deep-signal-positions-types.tsx`.

### T1/T2 and transform items

See the `packages/unplugin-react-fine-grained-signals` tests and README.

- T1: a PascalCase function invoked as a plain call anywhere in the module (through its own binding or its exact keyed slot) is not a boundary, and its render reads fold into the calling component.
- T2 was reproduced with Vite 8.3.1, `@vitejs/plugin-react` 6.1.1, and `babel-plugin-react-compiler` 1.0.0. The plugin's compiler step was emulated with the same plugin shape, because its optional `oxc-transform-react` engine is not installed. With `[react({ compiler: true }), signals()]` the compiler memoized the signal read and the UI stayed stale. The Vite plugin now uses an `order: "pre"` transform hook, which Vite sorts ahead of pre-enforced hooks that have no order, regardless of array position. Listing `signals()` first remains the documented recommendation.

### Dependency range

`alien-signals` is pinned to `3.2.1`, the newest published 3.x (checked against the npm registry on 2026-10-01). The core hard-codes Alien 3.2.1's `ReactiveFlags` bits and mirrors its high-level effect/computed algorithms around `alien-signals/system`, so an unverified minor release could change either silently.

### Repository hygiene finding

The review's "ignored but tracked" item misread `.eslintignore` as `.gitignore`: `benchmarks/phase9/m15/{bundled,current-dist}` are only lint-ignored. The files that actually match a `.gitignore` rule while tracked are `benchmarks/phase9/source-hot-path/variants/{R1..R5,W1..W4}/dist/` (90 files). They are the frozen attribution variants that `source-hot-path/worker.mjs` and `deep-signal-ab-worker.mjs` load, so they stay.

## Classification

| Item | Classification |
| --- | --- |
| B1 root `createElement` | FIXED |
| B2 bare scope speculative cache | FIXED |
| C1 foreign dependency activation | FIXED |
| C2 cold foreign refresh | FIXED |
| C3 cross-copy `untracked` | FIXED |
| C4 generation brand | FIXED (new generation key; mixed generations fail loudly; cross-generation reactivity documented as unsupported) |
| D1 array mutator tracking | FIXED |
| D2 descriptor/key overtracking | FIXED |
| J1 signal/plain host remount | FIXED |
| J2 form reset | FIXED |
| J3 `style={deepSignal}` | FIXED (runtime copy) and CONTRACT NARROWED (type) |
| J4 deep signal in root-only positions | CONTRACT NARROWED |
| T1 plain-called PascalCase function | FIXED |
| T2 React Compiler ordering | FIXED (Vite `order: "pre"`); order recommendation documented |
| Alien dependency range | FIXED (exact pin) |
| Nested effect ownership | FIXED (v0.1.1/Alien parity restored, documented) |
| Self-dispose relink | FIXED |
| Indirect computed cycle | FIXED |
| Inherited prototype keys | FIXED |
| `set` receiver | FIXED |
| Signal array child key warning | FIXED |
| Spread key with signal props | FIXED |
| `JSX.IntrinsicElements` augmentation | FIXED |
| Transform default-parameter reads | FIXED |
| Object-method components | FIXED |
| Uppercase extensions | FIXED |
| Plugin `engines` | FIXED (`^22.18.0 \|\| >=24.11.0`, from Babel 8 and unplugin 3) |
| CJS config consumption | FIXED (`default` condition; `require(esm)` only, no CJS build) |
| RSC `"use client"` | DOCUMENTED INTENTIONAL BEHAVIOR (limitation and workarounds in the plugin README) |
| Ignored-but-tracked benchmark files | DISPROVED as reported; the real set is kept as frozen evidence |

## Performance

Environment: Windows 11 Home Insider Preview 10.0.26340 x64, AMD Ryzen 7 PRO 6850U, Node v24.21.0, pnpm 12.8.1, Vite 8.3.1 (rolldown 1.2.11), React 19.3.0, `alien-signals` 3.2.1. The machine was not quiet (other desktop applications kept CPU load near 75%), so method mattered more than usual.

Method. The clean baseline is a detached worktree of `91ad17f` with its own `dist/`, kept unchanged for the whole closure. The Phase 9 workers and frozen `m1b-iterations.json` counts were reused unchanged. Process-level A/B pairs on this machine had a ±30% A/A spread, so core cases were measured in-process: one fresh process per round loads both builds (separate module instances for the runtime, the adapter, and the workloads, so no shared JIT feedback), warms both, then alternates samples ABBA with a GC before each sample. Identical code still showed a per-case positional bias of up to ±9% depending on which build loaded first, so even rounds load the baseline first and odd rounds the candidate first, and the reported ratio is the geometric mean of the two order medians (baseline time / candidate time; above 1 means the candidate is faster). React cases use the existing process-level worker in alternating order. The scripts are not part of the repository.

A/A (baseline against a byte-identical copy, 8 rounds): every core case within 0.94–1.07, which sets the noise floor for single-run deltas.

Final (8 rounds; three borderline cases re-run with 12):

| Case | Ratio | Candidate faster |
| --- | ---: | ---: |
| source/create (12) | 0.983 | 4/12 |
| source/read | 1.013 | 5/8 |
| source/unobserved-write | 0.998 | 4/8 |
| source/write-read | 0.997 | 4/8 |
| computed/create (12) | 0.994 | 6/12 |
| computed/dirty-read | 1.025 | 5/8 |
| computed/dirty-unread | 1.021 | 6/8 |
| computed/equality-suppression (12) | 0.987 | 5/12 |
| computed/source-to-many@16 | 1.000 | 3/8 |
| computed/many-to-one@16 | 1.034 | 5/8 |
| effect/create | 1.031 | 4/8 |
| effect/create-dispose | 1.063 | 7/8 |
| effect/observed-write | 1.002 | 4/8 |
| effect/fanout@16 | 1.080 | 6/8 |
| effect/dynamic-dependencies | 1.003 | 4/8 |
| batch/two-writes-one-reaction | 1.024 | 4/8 |
| rfsg/deepSignal-read | 0.985 | 4/8 |
| rfsg/deepSignal-watched-leaf-write | 1.011 | 5/8 |
| rfsg/react-bare-tracking (process, 12) | 0.979 | 5/12 |
| rfsg/react-managed-tracking (process, 12) | 0.985 | 5/12 |
| rfsg/react-useSignalValue (process, 12) | 0.996 | 6/12 |
| rfsg/react-jsx-direct-binding (process, 12) | 1.014 | 7/12 |

Investigated deltas. The first full run (before two changes below) showed repeatable regressions: `source/unobserved-write` 0.880 (0/8), `source/write-read` 0.937 (0/8), `effect/observed-write` 0.807, `effect/fanout@16` 0.917 (0/8), `batch` 0.873. One-variable variants attributed them: the global write epoch in `inlineWrite` (removed; see B2) and the cross-copy untracked check on the owner-defined getter path, which every read inside an effect takes (removing only the check made fan-out about 7% faster; removing nested-effect ownership changed effect cases by 1–3%). The getters now return early when the current owner is the copy's own graph owner, the case for every read inside its own effects and computeds, which skips the render-attempt, untracked, and foreign-owner checks together. No case is now a repeatable ≥2% regression; the React process-level ratios have wide ranges (0.73–2.1) and are only sanity checks.

## Package size

Gzip / brotli bytes from `scripts/check-size.mjs` (Vite production bundle per scenario):

| Scenario | Baseline gzip | Final gzip | Δ gzip | Baseline br | Final br |
| --- | ---: | ---: | ---: | ---: | ---: |
| signal-only | 6789 | 7024 | +235 (+3.5%) | 5.98 kB | 6.19 kB |
| core | 6831 | 7067 | +236 (+3.5%) | 6.01 kB | 6.23 kB |
| core+hooks | 8428 | 8696 | +268 (+3.2%) | 7.39 kB | 7.64 kB |
| deep | 11558 | 11833 | +275 (+2.4%) | 10.11 kB | 10.38 kB |
| index-full | 13105 | 16397 | +3292 (+25.1%) | 11.42 kB | 14.32 kB |
| jsx-runtime | 10214 | 10695 | +481 (+4.7%) | 8.93 kB | 9.36 kB |
| utils | 8284 | 8540 | +256 (+3.1%) | 7.27 kB | 7.52 kB |

All entries are above the 200-byte investigation line. The roughly 240 bytes every entry shares are the core changes (nested-effect ownership, detached internal effects, foreign activation and cold refresh, cross-copy untracked, self-dispose, cycle detection, and the getter fast path); `signal-only` and `core` stay within their existing budgets, as do `core+hooks`, `deep`, and `utils`. `jsx-runtime` adds about 240 bytes of JSX changes (binding-ref cache, node binder, reset defaults, array keys) and its budget moved from 10624 to 11264. `index-full` imports every root export, which now includes `createElement` and therefore the JSX binding machinery; an app that uses the JSX runtime already ships that code, so this is not additional code for it. Its budget moved from 13632 to 17280. Both budgets use the script's own rule (5% headroom, rounded up to 64 bytes); the other five budgets are unchanged. Tree-shaking was checked with marker strings: `signal-only`, `core`, and `core+hooks` contain no JSX or DeepSignal code.

No graph-node shape changed apart from the existing `flags` field carrying one more bit, so the allocation diagnostics were not re-run.
