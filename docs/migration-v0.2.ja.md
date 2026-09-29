# v0.2への移行

このガイドでは、v0.1.1からv0.2へ更新するときの公開APIとdependencyの変更点を説明します。

## 描画追跡フック

rootの `useSignals()` は `useSignalTracking()` に変わりました。これは小さなbest-effort追跡境界です。

```tsx
import { useSignalTracking } from "react-fine-grained-signals";

function Counter() {
  useSignalTracking();
  // 描画中にsignalを読み取ります。
}
```

正確な描画追跡には `/runtime` から `useManagedSignals()` をimportし、`finally` でscopeを同期的に終了します。

```tsx
import { useManagedSignals } from "react-fine-grained-signals/runtime";

function Counter() {
  const scope = useManagedSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    scope.finish();
  }
}
```

transform pluginを利用できる場合は、既定の `transform: "managed"` が推奨される正確な境界であり、この `try/finally` scopeを自動挿入します。手動の `useManagedSignals()` はpluginを使わない場合の選択肢です。高度な `transform: "inject"` modeでは、代わりにbest-effortの `useSignalTracking()` が挿入されます。

## Managed scopeのmethod

`ManagedSignalsStore.f()` は削除されました。`scope.f()` を `scope.finish()` に置き換えてください。

## Alien Signals dependency

`alien-signals` はRFSGのpeer dependencyから通常のdependencyに変わりました。v0.1.1のpeer dependencyを満たすためだけにアプリへ直接追加していた場合は、その直接dependencyを削除できます。アプリ自身がAlien Signalsをimportしている場合は、アプリのdependencyとして残してください。RFSGは引き続き内部で `alien-signals/system` を使用します。

## 関連ガイド

- [コアプリミティブ](core-primitives.ja.md)
- [Reactフック](hooks.ja.md)
- [描画最適化](rendering-optimization.ja.md)
- [JSXのsignal子要素とhost binding](jsx-bindings.ja.md)
