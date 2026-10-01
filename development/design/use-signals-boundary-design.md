# Bare `useSignalTracking()` boundary design

[English](./use-signals-boundary-design.md) | [日本語](./use-signals-boundary-design.ja.md)

Status: Phase 8 is complete and frozen (M0–M3). Bare `useSignalTracking()` remains best-effort; `transform: "managed"` is the recommended/default exact path; manual `useManagedSignals()` with `try` / `finally` is the exact plugin-free path; `transform: "inject"` remains a supported best-effort advanced/compatibility mode; `useSignalValue()` and JSX direct signal bindings are exact targeted subscriptions. Scope-policy separation is adopted: `SharedInteropContextV1.renderScope` is the single active-scope arbitration stack, with `activeRenderCollector` retained as the direct local collector channel. Cross-copy readable dependencies follow lexical render ownership. See [phase8.md](../phases/phase8.md) for the milestone record.

## Context

Calling bare `useSignalTracking()` opens a render collector that records subsequent synchronous signal reads. React does not expose a callback at the end of an ordinary function-component invocation, so the runtime closes the collector at the earliest of three edges:

- the next `useSignalTracking()` call: a bare collector never survives another call, and a bare call closes even an open managed scope, while managed scopes nest within each other;
- the commit-phase layout effect that follows the render pass; in a synchronous render this runs before the scheduled microtask;
- a microtask scheduled when a bare collector opens, which runs after the current synchronous execution completes and before the next macrotask.

This preserves the desired explicit, plugin-free API, but none of these edges coincides with the end of the owning component's invocation. An earlier component's collector can still be open while a sibling or descendant that did not call `useSignalTracking()` reads a signal. That read can be assigned to the wrong component. Updating the signal may rerender the collector owner while leaving the component that displayed the value stale. Render passes are also not atomic: under time-sliced rendering (for example inside `startTransition`), React may yield between components, so the scheduled microtask can close a collector part-way through a render pass. Suspense-aborted renders, nested server rendering during render, and multiple concurrent roots create related ownership ambiguity.

The current behavior is therefore **best-effort**, not a strict component boundary. Every component that reads a signal during render must call `useSignalTracking()` itself. The existing managed transform can provide an exact lexical `try` / `finally` boundary when build-time transformation is acceptable.

## Prior art

`@preact/signals-react` worked through this exact problem. Its 1.x releases patched React internals (`ReactCurrentDispatcher`) to track reads automatically; that approach broke across React versions and frameworks and was abandoned. Current releases pair an explicit `useSignals()` hook with an optional Babel transform (`@preact/signals-react-transform`) that wraps opted-in components in `try` / `finally` around an effect-store handle. The managed runtime in this library mirrors that store protocol and exposes `finish()` to close the scope. This history is direct evidence against internals-based tracking and a calibration point for the transform-based options below.

## Goals for the original contract decision

- Preserve the `useSignalTracking()`-first authoring style that motivated this library.
- Prevent signal reads from being silently attributed to the wrong component.
- Remain correct under React 19 Strict Mode, Suspense interruption, SSR, hydration, concurrent roots, and time-sliced renders.
- Stay compatible with the React Compiler's assumptions about render purity and memoization.
- Keep hook ordering valid and avoid render-phase state updates.
- Make the cost and required build integration explicit.

## Non-goals

- Replacing React's component tree or scheduler.
- Making reads in effects, event handlers, or asynchronous callbacks into render dependencies.
- Automatically unwrapping arbitrary component props or children.
- Choosing an implementation in this document before correctness and compatibility tests exist.

## Options considered during the original investigation

### 1. Keep bare `useSignalTracking()` best-effort

**Status: selected.** It remains a supported convenience API with an explicit best-effort contract; do not describe it as an exact component boundary.

Retain the current runtime behavior and documentation. The managed transform remains the strict option.

Advantages: no build requirement, no API change, and the desired explicit call remains available. Disadvantages: incorrect ownership remains possible when any rendering code reads a signal without opening its own boundary; documentation cannot prevent third-party or forgotten reads.

### 2. Make managed transformation the recommended strict path

**Status: selected as the recommended/default whole-render path.** The `unplugin-react-fine-grained-signals` build plugin defaults to this option, implementing an exact `try` / `finally` boundary via `transform: "managed"`.

Keep the source-level `useSignalTracking()` call but transform opted-in components to an exact `try` / `finally` scope. The transform could remain optional for users who knowingly accept best-effort behavior.

Advantages: preserves source ergonomics and gives lexical ownership. Disadvantages: requires build integration, must handle every component form safely, and increases transform maintenance.

### 3. Document the manual runtime-import boundary

**Status: selected as the exact plugin-free manual path.** `transform: "managed"` remains the primary/recommended path when the build plugin is available; the manual runtime-import boundary provides an exact boundary without a build transform.

The managed runtime ships an exact boundary that needs no compiler: `react-fine-grained-signals/runtime` exports `useManagedSignals`, which returns a scope handle closed with `finish()`. `const store = useManagedSignals(); try { … } finally { store.finish(); }` is documented as a public pattern in [the hooks guide](../../docs/guides/hooks.md) ("Tracking boundary"), offering strict ownership with no build integration and no wrapper. [The React Compiler compatibility note](./react-compiler-compatibility.md#the-manual-runtime-import-boundary-behaves-like-managed-output) separately measures this manual runtime-import boundary under `babel-plugin-react-compiler`.

Advantages: exact lexical ownership from a mechanism that already exists, with no compiler and no change to component identity. The trade-offs below are properties of the pattern itself and hold regardless of documentation status: boilerplate in every opted-in component; a forgotten `finally` leaks the scope from an API that claims exactness, which is worse than a forgotten hook call; and documenting the handle commits `react-fine-grained-signals/runtime`'s shape as a public contract rather than leaving it an internal transform implementation detail.

### 4. Introduce an explicit component wrapper

**Status: rejected.** A wrapper returning `<Component {...props} />` creates an element and cannot lexically surround React's later invocation. Calling `Component(props)` directly is not an acceptable React component model.

Advantages: no compiler is required and the boundary can be explicit. Disadvantages: changes authoring style, affects component identity and typings, and must be tested with refs, memoization, display names, server components, and static properties.

### 5. Integrate through a React-supported external contract

**Status: no current stable contract identified; private internals are rejected.** Revisit only if React exposes a supported component render-lifetime API.

Investigate whether a current or future React API can expose component-scoped render lifetime without transformation or wrappers.

Advantages: could offer strict ownership with less custom control flow. Disadvantages: no suitable stable React 19 contract is currently known, and relying on internals is not acceptable — the internals patching abandoned by `@preact/signals-react` (see prior art) is the cautionary precedent.

### 6. Add development-time misattribution diagnostics

**Status: deferred/rejected as a primary candidate.** The runtime lacks reliable component identity; a warning based only on an open collector would be noisy because that is intended bare-hook behavior.

Keep the runtime best-effort but make misattribution loud in development builds where it can be detected. This does not fix ownership — detection is heuristic, can miss cases, and must not be presented as a guarantee — but it converts silent misattribution into an actionable warning and composes with option 1. The concrete detection mechanism is itself part of the investigation; candidates include development-only sentinels around the collector lifecycle.

Advantages: low cost, orthogonal to every other option, and directly addresses the "silently" part of the goals. Disadvantages: heuristics can misfire or stay quiet, so the documented contract remains best-effort even with the warnings in place.

### 7. Narrow or replace the bare API

**Status: not selected.** Keep the bare hook as a supported best-effort convenience and direct users who need exactness toward explicit leaf subscriptions, JSX host bindings, managed transformation, or the manual managed handle.

Advantages: makes guarantees honest and reduces ambiguous machinery. Disadvantages: weakens the live-library experience — the authoring style where reading `.value` during render is by itself enough to keep the view live — and is a significant product/API decision.

## Criteria used for the original decision

Any selected design must have executable tests for:

- adjacent siblings where only one component calls `useSignalTracking()`;
- nested components and render props with mixed opt-in status;
- Strict Mode replay and cleanup;
- a render that suspends or throws before completion;
- nested `renderToString` / `renderToStaticMarkup` during a render;
- multiple concurrent roots and interleaved updates;
- time-sliced renders where React yields between components while a collector's trailing microtask is pending;
- a dependency whose value changes between the render that read it and commit, which must reschedule the render;
- tearing checks under interleaved concurrent updates;
- SSR followed by hydration;
- rendering with the React Compiler enabled, including memoized components it skips;
- component identity, refs, and memoization if a wrapper is used;
- transform coverage and idempotence if build-time management is used;
- diagnostic precision if development-time warnings are used: firing on the sibling case and staying silent on correct usage.

The decision should also compare bundle cost, per-render overhead, source-map/debugging quality, bundler coverage, and migration complexity. A solution is not acceptable if it merely moves silent misattribution to a rarer code path.

## Final contract and outcome

The final contract keeps bare `useSignalTracking()` best-effort; `transform: "managed"` as the exact, recommended/default automatic path; `transform: "inject"` as a supported advanced/compatibility best-effort mode; manual `useManagedSignals()` with synchronous `try` / `finally` as the exact plugin-free path; and `useSignalValue()` plus JSX direct bindings as exact targeted subscriptions. Strict bare tracking, wrapper APIs, and runtime component-identity heuristics remain out of scope.

The alternatives above are historical investigation, not an open decision list. M1 confirmed shared-scope consolidation and removed `currentStore` and the duplicate local arbitration loop. M2 then hardened cross-copy reads so the lexical render scope owns each render dependency. Phase 8 is complete and frozen; see [phase8.md](../phases/phase8.md) for evidence and validation.
