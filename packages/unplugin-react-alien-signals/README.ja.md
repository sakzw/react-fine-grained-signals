# unplugin-react-alien-signals

[English](README.md) | [日本語](README.ja.md)

`react-alien-signals` 向けの、`useSignals()` 自動挿入と任意のmanaged
render scope変換を提供する汎用bundler integrationです。Babel実装は内部に
閉じ込め、利用側はbundlerごとのentry pointだけを設定します。

## 状態

このworkspace packageは完成作業中のためprivateであり、npmには公開していません。
将来のパッケージはESM-onlyです。CommonJSの`require()`ではなく、ESM設定から
`import`してください。

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

Rollup、webpack、Rspack、esbuildにはそれぞれ `/rollup`、`/webpack`、
`/rspack`、`/esbuild` のentry pointを使います。

## オプション

- `mode`
  - `"manual"`: 先頭文にあるimport済みの `useSignals()`、または
    `@useSignals` を付けた名前付きcomponent/custom hookだけを変換します。
  - `"auto"`（既定）: さらに `.value` を読む名前付きJSX componentと
    名前付き `useX` custom hookを変換します。
  - `"all"`: さらにすべての名前付きJSX componentを変換します。ネストした
    callbackの読み取りは親componentが収集しますが、callback自体は変換しません。
- `transform`
  - `"inject"`（既定）: 通常の `useSignals()` を先頭hookとして挿入します。
    手書きと同じbest-effort境界であり、制御フローは書き換えません。
  - `"managed"`: `/runtime` からimportし、厳密な `try` / `finally` の
    render scopeを生成します。
- `importSource`: `react-alien-signals` 互換wrapperへの置き換えです。
- `include` / `exclude`: source module IDを絞る関数です。

`@useSignals` と `@noUseSignals` は、その関数だけに適用されます。既存の
direct import、namespace import、barrel import経由の `useSignals()` はそのまま
残し、pluginが二重の呼び出しを挿入することはありません。いずれの変換モードも
再適用するとno-opです。`.ts` はJSXなしのTypeScriptとして、`.tsx`、`.jsx`、
JavaScriptはJSXを含めて解析します。

## 開発用ベンチマーク

workspace rootから `pnpm bench:transform` を実行すると、ビルド済みVite
adapterに対して小・大TSX入力の変換時間を計測できます。これはCIの性能gateでは
なく、ローカル診断用です。
