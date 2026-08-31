# Documentation

[English](README.md) | [日本語](README.ja.md)

## Guides

How to use the library.

- [Core primitives](core-primitives.md) — `signal`, `computed`, `effect`, `batch`, `untracked`, `deepSignal`, and `isSignal`.
- [React hooks](hooks.md) — `useSignals`, `useSignal`, `useDeepSignal`, `useComputed`, `useSignalEffect`, and the low-level selector hooks.
- [Global state](global-state.md) — module-scope signals as a store, and the per-request store SSR needs instead.
- [Rendering optimization](rendering-optimization.md) — explicit `useSignals()` tracking vs. the build plugin's automatic insertion. See the [build plugin documentation](../packages/unplugin-react-fine-grained-signals/README.md) for complete option reference.
- [JSX signal children and host bindings](jsx-bindings.md) — the custom JSX runtime's direct DOM bindings and their constraints.
- [JSX control-flow utilities](control-flow.md) — `Show`, `Switch`/`Match`, `For`, and `Index`.

## Design notes

Investigation memos for still-open or historical implementation decisions, not usage docs.

- [`design/`](design/) — see [the direct-binding design note](design/direct-binding-value-checked-style.md), [the `useSignals()` boundary design note](design/use-signals-boundary-design.md), [the transform toolchain alternatives note](design/transform-toolchain-alternatives.md), [the React Compiler compatibility note](design/react-compiler-compatibility.md), and [the packaging note](design/packaging.md).
