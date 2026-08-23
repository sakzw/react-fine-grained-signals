# ドキュメント

[English](README.md) | [日本語](README.ja.md)

## ガイド

ライブラリの使い方です。

- [コアプリミティブ](core-primitives.ja.md) — `signal`、`computed`、`effect`、`batch`、`untracked`、`deepSignal`。
- [Reactフック](hooks.ja.md) — `useSignals`、`useSignal`、`useDeepSignal`、`useComputed`、`useSignalEffect`、低レベルselector hooks。
- [描画最適化](rendering-optimization.ja.md) — 明示的な `useSignals()` 追跡とbuild pluginによる自動挿入の比較。
- [JSXのsignal子要素とhost binding](jsx-bindings.ja.md) — 独自JSXランタイムのDOM直接bindingとその制約。
- [JSX制御フローユーティリティ](control-flow.ja.md) — `Show`、`Switch` / `Match`、`For`、`Index`。

## 設計検討メモ

未決定、または過去の実装判断に関する検討メモです。使い方のdocsではありません。

- [`design/`](design/) — [直接バインディングの設計検討docs](design/direct-binding-value-checked-style.ja.md)、[`useSignals()` 境界の設計検討docs](design/use-signals-boundary-design.ja.md)、[transform toolchainの代替候補の検討docs](design/transform-toolchain-alternatives.ja.md)を参照してください。
