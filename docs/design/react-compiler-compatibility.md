# React Compiler compatibility

[English](react-compiler-compatibility.md) | [日本語](react-compiler-compatibility.ja.md)

Status: measured against `babel-plugin-react-compiler` 1.0.0 with its default options; the build plugin now emits a memoization opt-out by default. Unresolved items are listed under [Open questions](#open-questions).

## Context

`useSignals()` makes a component reactive by opening a render collector (`src/react/use-signals.ts`) that records every `signal.value` read performed during that render. On commit, `RenderStore.commit()` diffs those reads against the previous commit's subscriptions and unsubscribes every dependency that was *not* read during this render. The contract is therefore that each render re-reads every value the component displays.

React Compiler breaks that contract by design. It caches a component's JSX in a per-instance memo cache and re-executes only the parts whose reactive inputs changed. A `signal.value` read whose object the compiler classifies as non-reactive — a module-scope binding or an import, the shape most signal libraries encourage — lands inside a block guarded by `Symbol.for("react.memo_cache_sentinel")`, which runs exactly once per component instance.

The two models are in direct conflict, so the interaction was measured rather than inferred from the compiler's documentation.

## What was measured

`packages/unplugin-react-alien-signals/tests/react-compiler.test.ts` runs the pipeline a real application would run, in order:

1. this package's Babel transform (`transformReactAlienSignals`), in the mode under test — deliberately skipped for [the hand-written runtime boundary](#the-hand-written-react-alien-signalsruntime-boundary-behaves-like-managed-output), which is the case where no transform runs;
2. `babel-plugin-react-compiler` 1.0.0 with default options, capturing its `logger` events;
3. an automatic-runtime JSX transform;
4. an in-memory module link (imports are resolved against the live library, so module scope is real) and evaluation in jsdom.

Each case is asserted twice: on the compiled output text, and on behavior — mount, write the signal inside `act()`, read the DOM. `pnpm --filter unplugin-react-alien-signals test:react-compiler` runs it; CI runs it as its own step in `.github/workflows/test.yml`.

The fixture is the shape the hypothesis is about:

```jsx
import { signal } from "react-alien-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count.value}</output>;
}
```

## Findings

### `transform: "inject"` without the opt-out: the component dies after the first update

Confirmed. With `reactCompiler: "off"` (the behavior before this change), the compiler emits:

```jsx
import { c as _c } from "react/compiler-runtime";
import { signal } from "react-alien-signals";
import { useSignals as _useSignals } from "react-alien-signals";
export const count = signal(0);
export function Counter() {
  const $ = _c(1);
  _useSignals();
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <output>{count.value}</output>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
```

`count.value` sits inside the sentinel block, so it is read on the mount render and never again. The runtime consequence, measured in jsdom: the mount renders `0`; the first write to `count` still notifies React, because the mount render did record the dependency; that re-render returns the cached element and reads nothing, so `commit()` sees an empty dependency set and unsubscribes; every later write does nothing at all. The DOM stays at `0` forever while the signal holds `2`. The component appears to work until the moment it is updated.

`useSignals()` is not what fails here — it is called on every render. Nothing at runtime can repair this, because the frozen artifact is the JSX itself, not only the read: even if the collector kept its subscriptions, the re-render would still return the cached element.

### `transform: "managed"`: skipped by the compiler, but only by accident

Not confirmed — the managed output is left alone. Its `try` / `finally` scope cannot be lowered to the compiler's IR, and the compile is abandoned with a logged error:

```
CompileError: (BuildHIR::lowerStatement) Handle TryStatement without a catch clause
```

The emitted code is byte-for-byte the transform's own output, and the runtime test updates correctly. This is a bail-out on unsupported syntax, not a compatibility guarantee: it depends on the compiler continuing to reject `try` without `catch`, and with `panicThreshold: "all_errors"` the same event fails the build instead of skipping the function — measured directly: `transformSync` throws on `reactCompiler: "off"` output and does not throw on `reactCompiler: "auto"` output, where the error is logged and the build proceeds. The opt-out directive is therefore emitted in managed mode too, and it is the only thing that carries this shape through a panic-on-all-errors build.

### The manual runtime-import boundary behaves like managed output

The manual runtime-import boundary published in [the hooks guide](../hooks.md) — `useSignals()` imported from `react-alien-signals/runtime`, closed by the author's own `try` / `finally` — was measured on its own, with step 1 of the pipeline skipped entirely. That skip is the point: this is the shape a developer writes when the build plugin is not in the build, so nothing inserts a directive for it.

```jsx
import { signal } from "react-alien-signals";
import { useSignals } from "react-alien-signals/runtime";

export const count = signal(0);

export function Counter() {
  const store = useSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    store.f();
  }
}
```

The compiler classifies the source, not its author. It logs exactly the event transform-generated managed output produces, and emits the function unchanged — no `react/compiler-runtime` import, no memo cache:

```
CompileError: Todo: (BuildHIR::lowerStatement) Handle TryStatement without a catch clause
```

Mounted in jsdom, the component updates on every write: `0`, then `1`, then `2`. Adding `"use no memo"` by hand changes neither result. The logged event stays `CompileError` — not the `CompileSkip` the same directive produces on an `inject`-shaped body — and the DOM sequence is identical. The bail-out comes from the syntax alone, so this pattern is not the silent-freeze hazard a bare `useSignals()` is.

The directive still buys one thing, and only under `panicThreshold: "all_errors"`: without it `transformSync` throws and the build fails; with it the error event is still logged, but no panic fires. That is the same split measured on the transform's own managed output above, which is what one would expect once the two shapes are recognized as the same shape.

The automation gap is real, but narrower than a missing directive. The transform leaves such a file untouched even in `mode: "auto"` with `transform: "managed"`: the function already calls `useSignals()`, so it is skipped before the point where the directive would be added, and `transformReactAlienSignals` reports the file as untransformed by returning `null`. Writing `"use no memo"` by hand is therefore what a panic-on-all-errors build needs, and what keeps the opt-out meaningful if a compiler version learns to lower `try` / `finally`.

### Leaf hooks are compiler-safe

`useSignalValue(count)` returns a value through a hook, which the compiler treats as a reactive input:

```jsx
export function Counter() {
  const $ = _c(2);
  const value = useSignalValue(count);
  let t0;
  if ($[0] !== value) {
    t0 = <output>{value}</output>;
    $[0] = value;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  return t0;
}
```

The cache key is the signal's value, so the JSX is rebuilt exactly when it changes. This path needs no opt-out and keeps the compiler's memoization. The custom JSX runtime's direct host bindings (`<output>{count}</output>`) are safe for a different reason: the cached element holds the signal itself and the DOM leaf is updated by an effect, so caching the element changes nothing. Both are pinned by runtime tests.

### The hazard is specific to reads the compiler classifies as non-reactive

A signal reached through props is a reactive input, so the compiler emits the read itself as the cache key (`$[0] !== counter.value`) and it runs on every render. Module-scope and imported signals are the dangerous shape — and they are the shape this library's own documentation uses.

## The fix

The build plugin gained a `reactCompiler` option, `"auto"` (default) or `"off"`. In `"auto"` it marks every function it transforms with React Compiler's opt-out directive, so the compiler skips exactly the functions this library made reactive:

```jsx
export function Counter() {
  "use no memo";

  _useSignals();
  return <output>{count.value}</output>;
}
```

The compiler now logs `CompileSkip` for that function and emits it unchanged; the runtime test updates on every write. The same directive is added to managed output, which turns the `CompileError` bail into an intentional skip, and to custom hooks the transform touches — a hook body is memoized on the same terms as a component body.

Details that follow from the transform's existing contract:

- The directive is added only to functions the transform actually transformed, plus one case it deliberately leaves untouched: in `transform: "inject"`, a component that already calls `useSignals()` itself as its first statement, imported from the configured `importSource`. There is nothing to inject there, but the function is render-tracking all the same, so it gets the directive and the file counts as transformed.
- If the function body already carries a memoization directive of its own (`"use memo"`, `"use forget"`, `"use no memo"`, `"use no forget"`), nothing is added. An explicit choice by the author wins.
- The transform stays idempotent: re-running it finds the directive already present, changes nothing, and reports the file as untransformed.
- `reactCompiler: "off"` restores the previous output exactly. It is the right choice only when React Compiler is not in the build, or when the components in question were verified against the finding above.

The cost is real: a component that opts out of memoization is a component the compiler no longer optimizes. That is the correct default anyway — a memoized component that never updates is not an optimization. Applications that want both can use the leaf-hook or direct-binding paths above, which the compiler handles correctly and which the plugin does not transform.

## Does this change the recommended `transform` default?

No — not on React Compiler grounds. Managed output survives the compiler only because the compiler cannot lower `try` without `catch`, which is an implementation detail that also produces a build-breaking error under `panicThreshold: "all_errors"`. With the directive emitted in both modes, `"inject"` and `"managed"` are equally compiler-safe, so the choice between them rests entirely on the boundary-exactness argument in [the `useSignals()` boundary design note](use-signals-boundary-design.md), not on this document. Separately, `unplugin-react-alien-signals` now defaults to `transform: "managed"` for that boundary-exactness reason — a change made on the grounds in that note, not on any finding in this document.

## Open questions

- **Ordering across bundlers.** The directive only helps if this package's transform runs before the compiler's Babel pass. In Vite this holds structurally: the plugin declares `enforce: "pre"`, and `@vitejs/plugin-react` runs Babel as a normal-order plugin. Vite's own TypeScript pass runs between the two and preserves the directive under both its oxc and esbuild transformers, checked directly on `.tsx` input with JSX preserved. The Webpack, Rspack, and Next.js pipelines were not measured.
- **`panicThreshold: "all_errors"` in a real bundler.** Measured at the Babel level, on both transform-generated and hand-written `try` / `finally` shapes: the directive does not suppress the `TryStatement` error event, which is still logged with the directive present, but it does stop the panic — `transformSync` throws only when the directive is absent. Whether a bundler's React Compiler integration turns the still-logged event into a build failure by some other route was not reproduced end-to-end.
- **Hand-written bare `useSignals()` without the build plugin.** Nothing inserts the directive there, and the failure is silent. Such components need `"use no memo"` written by hand, or the plugin in `mode: "manual"`, which now adds it for them. This applies to the bare hook only — the hand-written `react-alien-signals/runtime` boundary is a structurally different case and is measured [above](#the-hand-written-react-alien-signalsruntime-boundary-behaves-like-managed-output).
- **`useSignals()` imported through an application barrel in `transform: "inject"`.** The transform recognizes the call and skips the function, and it stays skipped, so no directive is added. A direct import from the configured `importSource`, or a `@useSignals` annotation, is covered.
- **Compiler version.** Everything above is 1.0.0 behavior with default options. A future version that supports `try` / `finally`, changes its classification of module-scope reads, or changes how `"use no memo"` is honored would need this file's measurements re-run; the test suite is the executable form of them.
