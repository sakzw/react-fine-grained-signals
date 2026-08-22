# Bare `useSignals()` boundary design

[English](use-signals-boundary-design.md) | [日本語](use-signals-boundary-design.ja.md)

Status: design investigation; no API or implementation decision has been made.

## Context

Calling bare `useSignals()` opens a render collector that records subsequent synchronous signal reads. The runtime closes that collector at the next `useSignals()` call or at the end of the current microtask. This preserves the desired explicit, plugin-free API, but React does not expose a callback at the end of an ordinary function-component invocation.

Consequently, an earlier component's collector can still be open while a sibling or descendant that did not call `useSignals()` reads a signal. That read can be assigned to the wrong component. Updating the signal may rerender the collector owner while leaving the component that displayed the value stale. Suspense-aborted renders, nested server rendering during render, and multiple concurrent roots create related ownership ambiguity.

The current behavior is therefore **best-effort**, not a strict component boundary. Every component that reads a signal during render must call `useSignals()` itself. The existing managed transform can provide an exact lexical `try` / `finally` boundary when build-time transformation is acceptable.

## Goals for a future decision

- Preserve the `useSignals()`-first authoring style that motivated this library.
- Prevent signal reads from being silently attributed to the wrong component.
- Remain correct under React 19 Strict Mode, Suspense interruption, SSR, hydration, and concurrent roots.
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

### 3. Introduce an explicit component wrapper

Provide an API such as `withSignals(Component)` that owns a boundary around the component invocation through a wrapper controlled by the library.

Advantages: no compiler is required and the boundary can be explicit. Disadvantages: changes authoring style, affects component identity and typings, and must be tested with refs, memoization, display names, server components, and static properties.

### 4. Integrate through a React-supported external contract

Investigate whether a current or future React API can expose component-scoped render lifetime without transformation or wrappers.

Advantages: could offer strict ownership with less custom control flow. Disadvantages: no suitable stable React 19 contract is currently known; relying on internals is not acceptable.

### 5. Narrow or replace the bare API

Deprecate strict claims for bare `useSignals()` and direct users who require correctness toward explicit leaf subscriptions, JSX host bindings, or managed transformation.

Advantages: makes guarantees honest and reduces ambiguous machinery. Disadvantages: weakens the live-library experience and is a significant product/API decision.

## Decision criteria

Any selected design must have executable tests for:

- adjacent siblings where only one component calls `useSignals()`;
- nested components and render props with mixed opt-in status;
- Strict Mode replay and cleanup;
- a render that suspends or throws before completion;
- nested `renderToString` / `renderToStaticMarkup` during a render;
- multiple concurrent roots and interleaved updates;
- SSR followed by hydration;
- component identity, refs, and memoization if a wrapper is used;
- transform coverage and idempotence if build-time management is used.

The decision should also compare bundle cost, per-render overhead, source-map/debugging quality, bundler coverage, and migration complexity. A solution is not acceptable if it merely moves silent misattribution to a rarer code path.

## Current recommendation

Until a decision is made, treat bare `useSignals()` and `transform: "inject"` as plugin-free best-effort conveniences for synchronous renders where every signal-reading component opts in. Use `transform: "managed"` when an exact render boundary is required. This statement records the current limitation; it does not close the design issue or redefine the incorrect sibling case as correct behavior.
