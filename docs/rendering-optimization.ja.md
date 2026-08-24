# 描画最適化

[English](rendering-optimization.md) | [日本語](rendering-optimization.ja.md)

このライブラリには、独立して使える二つの最適化レイヤーがあります。

1. runtime hooksとJSX runtimeはbuild pluginなしで動作します。
2. 任意の `unplugin-react-alien-signals` packageは、選択したcomponentとcustom hookへ `useSignals()` を挿入し、必要に応じて厳密なmanaged boundaryも生成します。

どちらのレイヤーも、すべてのReact componentをsignal駆動へ変えるものではありません。component treeとschedulingの所有者は引き続きReactです。この最適化は、signal変更による作業を、そのsignalを実際に読んだcomponentまたはnative DOM leafへ絞ります。

## Pluginなし: `useSignals()` によるコンポーネント単位の追跡

レンダー中にsignalの `.value` を読むコンポーネントで、最初のフックとして `useSignals()` を1回、無条件に呼び出してください。引数はなく、値も返しません。

```tsx
function Counter() {
  useSignals();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

buildでReact Compilerを使う場合は、手書きで `useSignals()` を呼ぶコンポーネントすべてに `"use no memo"` を付けてください。付けないとcompilerがコンポーネントのJSXをcacheして `signal.value` を読み直さなくなり、errorも出さずに更新が止まります。後述のbuild pluginはこのdirectiveを自動で挿入します。[React Compilerとの互換性の検討docs](design/react-compiler-compatibility.ja.md)を参照してください。

このフック以降の同期的なsignal読み取りが収集され、そのいずれかが変わったときだけ、そのコンポーネントをReactが再レンダーします。`deepSignal` を使う場合、propertyの読み取りは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。build設定を変えずに明示的な制御がほしいときに最もシンプルな選択肢です。

変換なしの `useSignals()` は依存関係を収集する簡易的な境界です。追跡は次の `useSignals()` 呼び出し時、commit段階のlayout effect時、または現在の同期実行後に予約済みmicrotaskで閉じられます。レンダー中にsignalを読む各コンポーネント自身で `useSignals()` を呼んでください。effect、event handler、非同期callback、または追跡されていないコンポーネントの読み取りは、開いたままの境界に誤って紐付く場合があります。Suspense中断、レンダー中のネストしたserver rendering、複数rootをまたぐ厳密な境界には、後述のmanaged transformが必要です。未解決の境界問題と将来の契約候補は[境界の設計検討docs](design/use-signals-boundary-design.ja.md)にまとめています。

独自のJSX runtimeは、これとは独立した2つ目の最適化を提供します。ネイティブホスト要素の子要素や許可済みのhost propとしてsignalを使うと、親コンポーネントを一切再レンダーせずに、局所的なDOM leafとして更新されます。許可リスト全体、値の変換規則、注意点については[JSXのsignal子要素とhost binding](jsx-bindings.ja.md)を参照してください。

## Pluginあり: `useSignals()` の自動挿入

任意で導入できる汎用ビルドpluginは、Babel設定を利用者に要求せず、bundler向けのintegrationだけを設定します。既定では対象の関数を検出し、最初のフックとして通常の `useSignals()` を挿入するだけです。制御フローを書き換えず、手書きの `useSignals()` と同じbest-effortな追跡境界を使えます。JSXランタイムのネイティブリーフ更新はpluginと独立して動作します。

```sh
# 将来のパッケージ名です。まだnpmには公開していません。
pnpm add -D unplugin-react-alien-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

同じパッケージは `/rollup`、`/webpack`、`/rspack`、`/esbuild` のentry pointも提供します。ESM-onlyのため、bundler設定ではCommonJSの `require()` ではなく `import` を使ってください。現在はprivateなworkspace packageであり、npmには公開していません。導入・設定例は将来の公開APIを示すものです。

`mode` でコンポーネントを追跡対象にする方法を選びます。

- `"manual"`: 先頭文にあるimport済みの `useSignals()`、または `@useSignals` を付けた名前付きコンポーネント／custom hookだけを変換します。明示的なライブラリの書き味を維持します。
- `"auto"`（既定）: さらに `.value` を読む名前付きJSXコンポーネントと、`.value` を読む名前付き `useX` custom hookを変換します。
- `"all"`: さらにすべての名前付きJSXコンポーネントを変換します。直接の `.value` 読み取りを静的検出できない場合でも、コンポーネントを明示的に対象にしたいときに使います。任意のネストしたcallback自体は変換対象ではありません。

`transform` で、対象にした関数の生成方法を選びます。

- `"inject"`（既定）: `react-alien-signals` から通常の `useSignals` をimportし、最初のフックとして呼び出しを挿入します。`try` / `finally` を出力せず、既存の制御フローも書き換えません。
- `"managed"`: `react-alien-signals/runtime` からimportし、厳密な `try` / `finally` スコープを出力します。Suspenseで中断されたレンダー、レンダー中のネストしたSSR、複数の並行rootをまたぐ正確な分離が必要な場合だけ選んでください。

```ts
// 厳密な管理境界が必要な箇所だけ、明示的に選びます。
signals({ mode: "auto", transform: "managed" });
```

`reactCompiler` で、変換した関数をReact Compilerから保護するかどうかを選びます。

- `"auto"`（既定）: 変換したすべての関数に `"use no memo"` directiveを付けます。付けない場合、compilerはコンポーネントのJSXをcacheして `signal.value` を読み直さなくなるため、最初の更新以降コンポーネントが無言で凍結します。compilerを使っていない場合、このdirectiveは無害です。
- `"off"`: directiveを付けません。React Compilerをbuildで使っていない場合か、対象コンポーネントを[React Compilerとの互換性の検討docs](design/react-compiler-compatibility.ja.md)に照らして確認済みの場合だけ選んでください。

`"auto"` のコストは、変換したコンポーネントがcompilerのmemoization対象から外れることです。leaf hook（`useSignalValue`、`useDeepSignalValue`）とJSX runtimeのhost直接bindingはcompiler-safeで、変換対象にもならないため、その書き方のコンポーネントはcompilerの最適化を保てます。

`@useSignals` と `@noUseSignals` は、それぞれを所有する関数だけに適用され、ネストした関数へは継承されません。自動モードはトップレベルの宣言形式・arrow形式と、`memo` / `forwardRef` で包んだ名前付きコンポーネントを対象にします。任意のネストしたcallback、class component、匿名default export、async/generator関数、すでに `useSignals()` を呼んでいるコンポーネントは変更しません。どちらの変換モードも再適用するとno-opになります。`.value` 判定は意図的にheuristicなので、`mode: "auto"` はsignalではないオブジェクトにも無害な購読を追加する場合があります。

build時の自動化範囲に応じて、次のように選択します。

| 目的 | 推奨する方法 |
| --- | --- |
| pluginやbundler integrationを使わない | `useSignals()` を明示的に呼び、native signal childと許可済みpropにはJSX runtimeを使う |
| 通常の `useSignals()` 動作を自動挿入する | pluginを `mode: "auto"`（既定）で使う |
| 厳密なrender boundaryへ明示的にopt-inする | `mode: "manual"` と `transform: "managed"` を使う |
| 広範なmigration、またはheuristicから読み取りが見えないcomponent | `mode: "all"` を使い、必要な関数を `@noUseSignals` で除外する |

pluginはcore primitive、hooks、JSX signal bindingに必須ではありません。開発・build時に `useSignals()` またはmanaged render boundaryを挿入するための便宜機能であり、`useSignals()` のsemanticsを置き換えたり、native host propの許可リストを拡張したりはしません。

関連: [Reactフック](hooks.ja.md)、[JSXのsignal子要素とhost binding](jsx-bindings.ja.md)。
