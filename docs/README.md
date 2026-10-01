# Documentation

[English](README.md) | [日本語](README.ja.md)

## Migration

- [Migration to v0.2](migration/v0.2.md) — API and dependency changes from v0.1.1.

## Guides

- [Core primitives](guides/core-primitives.md) — `signal`, `computed`, `effect`, `batch`, `untracked`, `deepSignal`, and `isSignal`.
- [React hooks](guides/hooks.md) — `useSignalTracking`, `useSignal`, `useDeepSignal`, `useComputed`, `useSignalEffect`, and selector hooks.
- [Global state](guides/global-state.md) — module-scope signals as a store, and the per-request store SSR needs.
- [Rendering optimization](guides/rendering-optimization.md) — explicit tracking and automatic insertion by the build plugin.
- [JSX signal children and host bindings](guides/jsx-bindings.md) — direct DOM bindings and their constraints.
- [JSX control-flow utilities](guides/control-flow.md) — `Show`, `Switch`/`Match`, `For`, and `Index`.
