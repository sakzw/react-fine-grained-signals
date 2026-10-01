# ドキュメント

[English](README.md) | [日本語](README.ja.md)

## 移行ガイド

- [v0.2への移行](migration/v0.2.ja.md) — v0.1.1からのAPIとdependencyの変更点。

## ガイド

- [コアプリミティブ](guides/core-primitives.ja.md) — `signal`、`computed`、`effect`、`batch`、`untracked`、`deepSignal`、`isSignal`。
- [Reactフック](guides/hooks.ja.md) — `useSignalTracking`、`useSignal`、`useDeepSignal`、`useComputed`、`useSignalEffect`、selector hooks。
- [グローバルステート](guides/global-state.ja.md) — module scopeのsignalをストアとして使う方法と、SSRで必要になるリクエストごとのストア。
- [描画最適化](guides/rendering-optimization.ja.md) — 明示的な追跡とbuild pluginによる自動挿入。
- [JSXのsignal子要素とhost binding](guides/jsx-bindings.ja.md) — 独自JSXランタイムのDOM直接bindingとその制約。
- [JSX制御フローユーティリティ](guides/control-flow.ja.md) — `Show`、`Switch` / `Match`、`For`、`Index`。
