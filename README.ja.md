# react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

[alien-signals](https://www.npmjs.com/package/alien-signals) を基盤とした、React 19向けの実験的なfine-grainedレンダリングレイヤーです。小さなリアクティブプリミティブ、Reactフック、そして対象を意図的に絞ったDOMプロパティへの直接バインディング用JSXランタイムを提供します。このJSXランタイムは明示的に有効化した場合のみ使用されます。

**React 19以降が必要です。** JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。

## ドキュメント

ユーザー向けドキュメントの索引は[`docs/README.ja.md`](docs/README.ja.md)を参照してください。
動くサンプル付きのドキュメントサイト(英語)は、独立したVocsプロジェクトの[`website/`](website)からbuildします。
v0.2.1からの移行については[v0.3移行ガイド](./docs/migration/v0.3.ja.md)を参照してください。
v0.1.1からの移行については[v0.2移行ガイド](./docs/migration/v0.2.ja.md)を参照してください。
[v0.3.0 release notes](./docs/releases/v0.3.0.md)は未公開のドラフトです。

## インストール

```sh
pnpm add react-fine-grained-signals@0.2.1
```

このrepositoryには未公開のv0.3.0系が含まれています。2026-10-19時点でnpmに公開されているのは、本packageとbuild pluginのどちらもv0.2.1です。上のコマンドはv0.2.1をinstallし、このcheckoutに記載されたv0.3.0のAPIは含みません。npmからv0.3.0を使う場合は公開後に更新してください。移行内容は[v0.3移行ガイド](./docs/migration/v0.3.ja.md)を参照してください。

React(19以降)はpeer dependencyで、Node.js 22以降が必要です。packageはESMのみで、
entry pointと型を `exports` で公開しているため、`react-fine-grained-signals/utils`
やJSXランタイムを解決するには、TypeScriptの `moduleResolution` を `bundler`、
`node16`、`nodenext` のいずれかにしてください。
任意のbuild pluginを使う場合は、Babel 8が要求するNode.js
`^22.18.0 || >=24.11.0` が必要です。

## セットアップ

Core primitiveとReact Hookは、専用JSX runtimeやbuild pluginなしで利用できます。手動でrender trackingする場合は、先頭で `useSignalTracking()` を呼びます。

```tsx
import { useSignal, useSignalTracking } from "react-fine-grained-signals";

function Counter() {
  useSignalTracking();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

以下の2つの最適化は任意であり、互いに独立しています。どちらもinstall後に別途設定するもので、上記のフックを使うだけなら不要です。

### JSXランタイム — DOMへの直接バインディング

ネイティブホスト要素の子要素として使われたsignalが、周囲のコンポーネントを再レンダーせずに、そのDOMノードだけを更新できるようになります。

ファイル単位で有効にするには、先頭行にpragmaを書きます。他のファイルはReactのJSXランタイムのままになるため、アプリの一部だけで直接バインディングを使いたい場合はこちらを選んでください。[`examples/react-router`](examples/react-router)がこの構成です。

```tsx
/** @jsxImportSource react-fine-grained-signals */
```

プロジェクト全体で有効にする場合は `tsconfig.json` に設定します。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals"
  }
}
```

Viteはこの2つを `tsconfig.json` から読むため、`vite.config.ts` 側にJSXの設定は不要です。既定の変換でも `@vitejs/plugin-react` を使う場合でも同じです。

このランタイムが対象とするのはネイティブ要素と、意図的に絞ったpropsだけです。未対応のSignal-valued host propはobjectとして渡さず診断をthrowします。Reactコンポーネントのpropsや子要素に渡したsignalはアンラップされません。許可リスト全体と、JSXをBabelで変換するツールチェーン（`tsconfig.json` を読みません）については[JSXのsignal子要素とhost binding](./docs/guides/jsx-bindings.ja.md)を参照してください。

DOMの直接bindingは不要で、reactiveなSignal子要素だけが必要な場合はLite JSX Runtimeを明示的に選びます。

```tsx
/** @jsxImportSource react-fine-grained-signals/lite */
```

または`jsxImportSource`に`react-fine-grained-signals/lite`を指定します。Liteは通常のReact JSXとSignal子要素に対応しますが、Signal-valued attribute、style binding、`bindValue`、`bindChecked`には対応しません。JSX設定がなければReact標準runtimeが使われ、`react-fine-grained-signals`を指定するとFull Runtimeがopt-inされます。Fullが同じ初期読み込みchunkに含まれる場合、Liteを選んでも固定サイズの削減は保証されません。詳細は[JSXガイド](./docs/guides/jsx-bindings.ja.md)を参照してください。

| JSXの選択肢 | 用途 |
| --- | --- |
| React標準JSX | 通常のReact componentとHook。Signal子要素の正規化やDOM直接bindingは行いません |
| RFSG Lite JSX | native host要素内のSignal子要素。attribute、style、formの直接bindingはありません |
| RFSG Full JSX | Signal子要素と、対応済みhost attribute・style・明示form binding |

### ビルドplugin — managed trackingの自動変換

対象関数へtop-level capture Hookとper-read trackingをbuild時に追加します。best-effortな `useSignalTracking()` boundaryが必要な場合は `transform: "inject"` を選んでください。pluginは別packageなので個別にinstallします。

```sh
pnpm add -D unplugin-react-fine-grained-signals@0.2.1
```

現在npmで公開されているpluginもv0.2.1で、公開済みruntime v0.2.1と組み合わせます。v0.3.0公開後は両packageの同じ`0.3.x` release lineをinstallしてください。

そのうえで、bundlerに応じたentry point（`/vite`、`/rollup`、`/webpack`、`/rspack`、`/esbuild`）をbuild設定に追加します。

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

オプションの詳細と、フックを手書きする場合との使い分けについては[描画最適化](./docs/guides/rendering-optimization.ja.md)を参照してください。

## 開発

アーキテクチャ、設計、実装履歴は[`development/README.md`](development/README.md)にまとめています。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

workspace aliasを使わないクリーンなVite consumerから、pack済みESM packageを検証するには次を実行します。

```sh
pnpm test:consumer
```

ブラウザ向けの概念実証では、サーバーでアプリをレンダーし、React 19でハイドレーションを行い、Chromium上でsignalの直接バインディングを検証します。

```sh
pnpm exec playwright install --only-shell chromium
pnpm prepare:e2e
pnpm test:browser
```

同じサンプルを `http://127.0.0.1:4173` で確認するには、`pnpm dev:browser` を実行してください。このコマンドは最初に変換パッケージをビルドします。

## 謝辞

- [alien-signals](https://www.npmjs.com/package/alien-signals) — 本パッケージが基盤とするシグナルエンジン。
- [@preact/signals-core](https://www.npmjs.com/package/@preact/signals-core) — ベンチマークの比較対象。
- [@preact/signals-react](https://www.npmjs.com/package/@preact/signals-react) — 外部API `useSignals()` boundaryのstore protocol設計における先行事例。詳細は[Prior art](./development/design/use-signals-boundary-design.ja.md#先行事例)を参照。
