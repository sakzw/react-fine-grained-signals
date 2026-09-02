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

`useSignals()` を自動挿入するオプションのbuild pluginは別途installします。[描画最適化](docs/rendering-optimization.ja.md)を参照してください。

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
