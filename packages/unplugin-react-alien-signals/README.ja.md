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
  - `"managed"`（既定）: 厳密な `try` / `finally` 境界を追加します。
    `/runtime` からimportし、componentの関数がreturnする時点でrender
    tracking windowを同期的に閉じます。
  - `"inject"`: best-effortなopt-in向けに変換なしの `useSignals()` を
    追加します。制御フローを書き換えず、通常の `useSignals()` を先頭hook
    として挿入するため、手書きと同じbest-effort境界になります。この
    modeが露呈し得るsibling誤帰属の既知の制約については、
    [境界設計の検討docs](../../docs/design/use-signals-boundary-design.ja.md)
    を参照してください。
- `reactCompiler`
  - `"auto"`（既定）: 変換したすべての関数に `"use no memo"` を付け、render
    trackingが必要とするsignal読み取りをReact Compilerがmemoizationで
    消さないようにします。付けない場合、compile済みcomponentはJSXをcacheし、
    最初のsignal書き込み以降、無言で更新が止まります。
  - `"off"`: directiveを付けません。React Compilerをbuildで使っていない場合か、
    対象componentを[互換性の検討docs](../../docs/design/react-compiler-compatibility.ja.md)
    に照らして確認済みの場合だけ選んでください。
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
