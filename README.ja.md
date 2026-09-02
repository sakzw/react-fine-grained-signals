# react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

[alien-signals](https://www.npmjs.com/package/alien-signals) を基盤とした、React 19向けの実験的なfine-grainedレンダリングレイヤーです。小さなリアクティブプリミティブ、Reactフック、そして対象を意図的に絞ったDOMプロパティへの直接バインディング用JSXランタイムを提供します。このJSXランタイムは明示的に有効化した場合のみ使用されます。

**React 19以降が必要です。** JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。

## ドキュメント

ライブラリの使い方のガイド、設計検討メモ、ドキュメント索引全体については[`docs/README.ja.md`](docs/README.ja.md)を参照してください。

## インストール

```sh
pnpm add react-fine-grained-signals alien-signals
```

`alien-signals` はpeer dependencyなので、上のように併せてinstallしてください。

## セットアップ

プリミティブとフックは、installした時点で動作します。buildツールやコンパイラの設定は不要です。

```tsx
import { useSignal, useSignals } from "react-fine-grained-signals";

function Counter() {
  useSignals();
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

このランタイムが対象とするのはネイティブ要素と、意図的に絞ったpropsだけです。Reactコンポーネントのpropsや子要素に渡したsignalはアンラップされません。許可リスト全体と、JSXをBabelで変換するツールチェーン（`tsconfig.json` を読みません）については[JSXのsignal子要素とhost binding](docs/jsx-bindings.ja.md)を参照してください。

### ビルドplugin — `useSignals()` の自動挿入

追跡境界をbuild時に挿入するため、コンポーネント側で `useSignals()` を手書きする必要がなくなります。別packageなので個別にinstallします。

```sh
pnpm add -D unplugin-react-fine-grained-signals
```

そのうえで、bundlerに応じたentry point（`/vite`、`/rollup`、`/webpack`、`/rspack`、`/esbuild`）をbuild設定に追加します。

```ts
// vite.config.ts
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

オプションの詳細と、フックを手書きする場合との使い分けについては[描画最適化](docs/rendering-optimization.ja.md)を参照してください。

## 開発

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
- [@preact/signals-react](https://www.npmjs.com/package/@preact/signals-react) — `useSignals()` boundaryのstore protocol設計における先行事例。詳細は[Prior art](docs/design/use-signals-boundary-design.ja.md#先行事例)を参照。
