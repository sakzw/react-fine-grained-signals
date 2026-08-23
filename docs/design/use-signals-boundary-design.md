# Bare `useSignals()` boundary design

[English](use-signals-boundary-design.md) | [日本語](use-signals-boundary-design.ja.md)

Status: design investigation; no API or implementation decision has been made.

## Context

Calling bare `useSignals()` opens a render collector that records subsequent synchronous signal reads. React does not expose a callback at the end of an ordinary function-component invocation, so the runtime closes the collector at the earliest of three edges:

- the next `useSignals()` call: a bare collector never survives another call, and a bare call closes even an open managed scope, while managed scopes nest within each other;
- the commit-phase layout effect that follows the render pass; in a synchronous render this runs before the scheduled microtask;
- a microtask scheduled when a bare collector opens, which runs after the current synchronous execution completes and before the next macrotask.

This preserves the desired explicit, plugin-free API, but none of these edges coincides with the end of the owning component's invocation. An earlier component's collector can still be open while a sibling or descendant that did not call `useSignals()` reads a signal. That read can be assigned to the wrong component. Updating the signal may rerender the collector owner while leaving the component that displayed the value stale. Render passes are also not atomic: under time-sliced rendering (for example inside `startTransition`), React may yield between components, so the scheduled microtask can close a collector part-way through a render pass. Suspense-aborted renders, nested server rendering during render, and multiple concurrent roots create related ownership ambiguity.

The current behavior is therefore **best-effort**, not a strict component boundary. Every component that reads a signal during render must call `useSignals()` itself. The existing managed transform can provide an exact lexical `try` / `finally` boundary when build-time transformation is acceptable.

## Prior art

`@preact/signals-react` worked through this exact problem. Its 1.x releases patched React internals (`ReactCurrentDispatcher`) to track reads automatically; that approach broke across React versions and frameworks and was abandoned. Current releases pair an explicit `useSignals()` hook with an optional Babel transform (`@preact/signals-react-transform`) that wraps opted-in components in `try` / `finally` around an effect-store handle. The managed runtime in this library mirrors that store protocol, including the `f()` finish method. This history is direct evidence against internals-based tracking and a calibration point for the transform-based options below.

## Goals for a future decision

- Preserve the `useSignals()`-first authoring style that motivated this library.
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

## Options to evaluate

### 1. Keep bare `useSignals()` best-effort

Retain the current runtime behavior and documentation. The managed transform remains the strict option.

Advantages: no build requirement, no API change, and the desired explicit call remains available. Disadvantages: incorrect ownership remains possible when any rendering code reads a signal without opening its own boundary; documentation cannot prevent third-party or forgotten reads.

### 2. Make managed transformation the recommended strict path

Keep the source-level `useSignals()` call but transform opted-in components to an exact `try` / `finally` scope. The transform could remain optional for users who knowingly accept best-effort behavior.

Advantages: preserves source ergonomics and gives lexical ownership. Disadvantages: requires build integration, must handle every component form safely, and increases transform maintenance.

### 3. Document the manual scope handle

The managed runtime already ships an exact boundary that needs no compiler: `react-alien-signals/runtime` exports the transform target (`useManagedSignals`, re-exported there as `useSignals`), which returns a scope handle closed with `finish()` / `f()`. Documenting `const store = useSignals(); try { … } finally { store.f(); }` as a public pattern would offer strict ownership with no build integration and no wrapper.

Advantages: exact lexical ownership from a mechanism that already exists, with no compiler and no change to component identity. Disadvantages: boilerplate in every opted-in component; a forgotten `finally` leaks the scope from an API that claims exactness, which is worse than a forgotten hook call; and publishing the handle freezes what is currently an internal transform contract.

### 4. Introduce an explicit component wrapper

Provide an API such as `withSignals(Component)` that owns a boundary around the component invocation through a wrapper controlled by the library.

Advantages: no compiler is required and the boundary can be explicit. Disadvantages: changes authoring style, affects component identity and typings, and must be tested with refs, memoization, display names, server components, and static properties.

### 5. Integrate through a React-supported external contract

Investigate whether a current or future React API can expose component-scoped render lifetime without transformation or wrappers.

Advantages: could offer strict ownership with less custom control flow. Disadvantages: no suitable stable React 19 contract is currently known, and relying on internals is not acceptable — the internals patching abandoned by `@preact/signals-react` (see prior art) is the cautionary precedent.

### 6. Add development-time misattribution diagnostics

Keep the runtime best-effort but make misattribution loud in development builds where it can be detected. This does not fix ownership — detection is heuristic, can miss cases, and must not be presented as a guarantee — but it converts silent misattribution into an actionable warning and composes with option 1. The concrete detection mechanism is itself part of the investigation; candidates include development-only sentinels around the collector lifecycle.

Advantages: low cost, orthogonal to every other option, and directly addresses the "silently" part of the goals. Disadvantages: heuristics can misfire or stay quiet, so the documented contract remains best-effort even with the warnings in place.

### 7. Narrow or replace the bare API

Deprecate strict claims for bare `useSignals()` and direct users who require correctness toward explicit leaf subscriptions, JSX host bindings, or managed transformation.

Advantages: makes guarantees honest and reduces ambiguous machinery. Disadvantages: weakens the live-library experience — the authoring style where reading `.value` during render is by itself enough to keep the view live — and is a significant product/API decision.

## Decision criteria

Any selected design must have executable tests for:

- adjacent siblings where only one component calls `useSignals()`;
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

## Current recommendation

Until a decision is made, treat bare `useSignals()` and `transform: "inject"` as plugin-free best-effort conveniences for synchronous renders where every signal-reading component opts in. Use `transform: "managed"` when an exact render boundary is required. This statement records the current limitation; it does not close the design issue or redefine the incorrect sibling case as correct behavior.
