# 描画最適化

[English](./rendering-optimization.md) | [日本語](./rendering-optimization.ja.md)

このライブラリには、独立して使える二つの最適化レイヤーがあります。

1. runtime hooksとJSX runtimeはbuild pluginなしで動作します。
2. 任意の `unplugin-react-fine-grained-signals` packageは、選択したcomponentとcustom hookへtop-level capture Hookとread単位のscopeを挿入します。

どちらのレイヤーも、すべてのReact componentをsignal駆動へ変えるものではありません。component treeとschedulingの所有者は引き続きReactです。この最適化は、signal変更による作業を、そのsignalを実際に読んだcomponentまたはnative DOM leafへ絞ります。

## Pluginなし: `useSignalTracking()` によるコンポーネント単位の追跡

レンダー中にsignalの `.value` を読むコンポーネントで、最初のフックとして `useSignalTracking()` を1回、無条件に呼び出してください。引数はなく、値も返しません。

```tsx
function Counter() {
  useSignalTracking();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

buildでReact Compilerを使う場合で、変換なしの `useSignalTracking()` hook(packageから直接importしたもの)を手書きで呼ぶコンポーネントについては、`"use no memo"` を付けてください。付けないとcompilerがコンポーネントのJSXをcacheして `signal.value` を読み直さなくなり、errorも出さずに更新が止まります。build pluginは変換対象の関数へこのdirectiveを挿入します。手書きのmanaged boundary(`useManagedSignals()` を `try` / `finally` で使う形)にもcompiler保護が必要です。詳細は[React Compilerとの互換性の検討docs](../../development/design/react-compiler-compatibility.ja.md)を参照してください。

このフック以降の同期的なsignal読み取りが収集され、そのいずれかが変わったときだけ、そのコンポーネントをReactが再レンダーします。`deepSignal` を使う場合、propertyの読み取りは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。build設定を変えずに明示的な制御がほしいときに最もシンプルな選択肢です。

変換なしの `useSignalTracking()` はbest-effortの依存関係収集境界です。追跡は次の `useSignalTracking()` 呼び出し時、Reactがcommitを始めた時点(layout effectやref callbackより前)、または現在の同期実行後に予約済みmicrotaskで閉じられます。レンダー中にsignalを読む各コンポーネント自身で `useSignalTracking()` を呼んでください。effect、event handler、非同期callback、または追跡されていないコンポーネントの読み取りは、開いたままの境界に誤って紐付く場合があります。managed transformはtop-levelの `useSignalCapture()` Hookを挿入し、静的に証明できる同期readを実行箇所でcaptureします。静的coverageとdiagnosticsは[plugin guide](../../packages/unplugin-react-fine-grained-signals/README.ja.md#fast-refresh)に記載しています。手書きの `useManagedSignals()` と `try` / `finally` は、明示的なlexical ownership用に引き続き使えます（[hooksの追跡境界](./hooks.ja.md#pluginを使わずに厳密な境界を作る)を参照）。

独自のJSX runtimeは、これとは独立した2つ目の最適化を提供します。ネイティブホスト要素の子要素や許可済みのhost propとしてsignalを使うと、親コンポーネントを一切再レンダーせずに、局所的なDOM leafとして更新されます。許可リスト全体、値の変換規則、注意点については[JSXのsignal子要素とhost binding](./jsx-bindings.ja.md)を参照してください。

## Pluginあり: `useSignalTracking()` の自動挿入

pluginをbuildに入れると、コンポーネント側で `useSignalTracking()` を手書きする必要はなくなります。既定の `mode: "auto"` では、`.value` を読むコンポーネントとカスタムフックをplugin自身が検出し、境界を挿入します。

任意で導入できる汎用ビルドpluginは、Babel設定を利用者に要求せず、bundler向けのintegrationだけを設定します。既定では対象の関数を検出し、top-level capture Hookを追加して、静的に証明できる同期readを短いcapture scopeで囲みます。代わりに手書きと同じbest-effortな追跡境界がほしい場合は、`transform: "inject"` を選んで最初のフックとして `useSignalTracking()` を挿入してください。JSXランタイムのネイティブリーフ更新はpluginと独立して動作します。

```sh
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

同じパッケージは `/rollup`、`/webpack`、`/rspack`、`/esbuild` のentry pointも提供します。配布はESMのみです。ESMのbundler設定では `import` を使ってください。CommonJSの設定ファイルからも、Nodeの `require(esm)` 対応により `require()` で読み込めます。詳しくは[pluginのREADME](../../packages/unplugin-react-fine-grained-signals/README.ja.md#インストール)を参照してください。

主な2つのオプションがpluginの動作を制御します。

- **`mode`**: コンポーネントをどのようにopt-inさせるか。`.value` を読むコンポーネントを自動検出する `"auto"`（既定）か、`useSignalTracking()` 呼び出しまたは `@signalTracking` 注釈での明示的なopt-inを要求する `"manual"` を選びます。
- **`transform`**: opt-inしたコンポーネントのsignal readをどのように追跡するか。静的readを個別captureする `"managed"`（既定）か、手書きと同じbest-effort動作を得る `"inject"` を選びます。

重要な注意: 先頭文の `useSignalTracking()` 呼び出しがpackageから直接importされているのではなく、barrelまたは再exportモジュール経由の場合、pluginは正規の呼び出しか検証できません。そのため両transform modeでauthorの呼び出しはそのまま残り、build warningを出します。このwarningを避けるにはpackageから直接 `useSignalTracking` をimportしてください。

オプションの完全なリスト（`reactCompiler`、render callbackの検出、memo/forwardRefの認識、barrel importの扱いなど）については、[pluginのdocs](../../packages/unplugin-react-fine-grained-signals/README.ja.md)を参照してください。

関連: [Reactフック](./hooks.ja.md)、[JSXのsignal子要素とhost binding](./jsx-bindings.ja.md)。
