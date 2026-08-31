# 描画最適化

[English](rendering-optimization.md) | [日本語](rendering-optimization.ja.md)

このライブラリには、独立して使える二つの最適化レイヤーがあります。

1. runtime hooksとJSX runtimeはbuild pluginなしで動作します。
2. 任意の `unplugin-react-fine-grained-signals` packageは、選択したcomponentとcustom hookへ `useSignals()` を挿入し、既定で厳密なmanaged boundaryに包みます。

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

buildでReact Compilerを使う場合で、変換なしの `useSignals()` hook(packageから直接importしたもの)を手書きで呼ぶコンポーネントについては、`"use no memo"` を付けてください。付けないとcompilerがコンポーネントのJSXをcacheして `signal.value` を読み直さなくなり、errorも出さずに更新が止まります。後述のbuild pluginはこのdirectiveを自動で挿入します。注: 手書きのmanaged boundary pattern(`react-fine-grained-signals/runtime` からの `useSignals` を `try`/`finally` で使う形)はこのdirectiveを必要としません。詳細は[React Compilerとの互換性の検討docs](design/react-compiler-compatibility.ja.md)を参照してください。

このフック以降の同期的なsignal読み取りが収集され、そのいずれかが変わったときだけ、そのコンポーネントをReactが再レンダーします。`deepSignal` を使う場合、propertyの読み取りは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。build設定を変えずに明示的な制御がほしいときに最もシンプルな選択肢です。

変換なしの `useSignals()` は依存関係を収集する簡易的な境界です。追跡は次の `useSignals()` 呼び出し時、commit段階のlayout effect時、または現在の同期実行後に予約済みmicrotaskで閉じられます。レンダー中にsignalを読む各コンポーネント自身で `useSignals()` を呼んでください。effect、event handler、非同期callback、または追跡されていないコンポーネントの読み取りは、開いたままの境界に誤って紐付く場合があります。Suspense中断、レンダー中のネストしたserver rendering、複数rootをまたぐ厳密な分離には、コンポーネントがreturnする時点で同期的に閉じる、厳密な `try` / `finally` 境界が必要です。後述のmanaged transformはこの境界を自動生成しますが、同じ境界は `import { useSignals } from "react-fine-grained-signals/runtime"` を使えば手書きでも得られます（[hooksの追跡境界に関する説明](hooks.ja.md)を参照）。pluginは、手書きの `try` / `finally` を書き忘れる心配がない分、より手間の少ない選択肢というだけです。未解決の境界問題と将来の契約候補は[境界の設計検討docs](design/use-signals-boundary-design.ja.md)にまとめています。

独自のJSX runtimeは、これとは独立した2つ目の最適化を提供します。ネイティブホスト要素の子要素や許可済みのhost propとしてsignalを使うと、親コンポーネントを一切再レンダーせずに、局所的なDOM leafとして更新されます。許可リスト全体、値の変換規則、注意点については[JSXのsignal子要素とhost binding](jsx-bindings.ja.md)を参照してください。

## Pluginあり: `useSignals()` の自動挿入

pluginをbuildに入れると、コンポーネント側で `useSignals()` を手書きする必要はなくなります。既定の `mode: "auto"` では、`.value` を読むコンポーネントとカスタムフックをplugin自身が検出し、境界を挿入します。

任意で導入できる汎用ビルドpluginは、Babel設定を利用者に要求せず、bundler向けのintegrationだけを設定します。既定では対象の関数を検出し、それぞれを厳密な `try` / `finally` render boundaryで包みます。componentの関数がreturnする時点で、追跡windowを同期的に閉じます。代わりに手書きと同じbest-effortな追跡境界がほしい場合は、`transform: "inject"` を選んで最初のフックとして変換なしの `useSignals()` を挿入してください。制御フローは書き換えません。JSXランタイムのネイティブリーフ更新はpluginと独立して動作します。

```sh
# 将来のパッケージ名です。まだnpmには公開していません。
pnpm add -D unplugin-react-fine-grained-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

同じパッケージは `/rollup`、`/webpack`、`/rspack`、`/esbuild` のentry pointも提供します。ESM-onlyのため、bundler設定ではCommonJSの `require()` ではなく `import` を使ってください。現在はprivateなworkspace packageであり、npmには公開していません。導入・設定例は将来の公開APIを示すものです。

主な2つのオプションがpluginの動作を制御します。

- **`mode`**: コンポーネントをどのようにopt-inさせるか。`.value` を読むコンポーネントを自動検出する `"auto"`（既定）か、`useSignals()` 呼び出しまたは `@useSignals` 注釈での明示的なopt-inを要求する `"manual"` を選びます。
- **`transform`**: opt-inしたコンポーネントをどのように包むか。厳密なrender boundaryを得る `"managed"`（既定）か、手書きと同じbest-effort動作を得る `"inject"` を選びます。

重要な注意: 先頭文の `useSignals()` 呼び出しがpackageから直接importされているのではなく、barrelまたは再exportモジュール経由でimportされている場合、pluginはその呼び出しが正規のものであることを検証できません。そのため、どちらのtransformモードでも呼び出しはそのまま残り、コンポーネントがbest-effort/bare境界の上に残る（managed/検証済み境界に吸収されない）ことを説明するbuild警告が出力されます。この警告を避けるには、packageから直接（または `/runtime` 経由で正確な境界を得るために）`useSignals` をimportしてください。

オプションの完全なリスト（`reactCompiler`、render callbackの検出、memo/forwardRefの認識、barrel importの扱いなど）については、[pluginのdocs](../packages/unplugin-react-fine-grained-signals/README.ja.md)を参照してください。

関連: [Reactフック](hooks.ja.md)、[JSXのsignal子要素とhost binding](jsx-bindings.ja.md)。
