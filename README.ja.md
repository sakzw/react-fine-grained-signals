# react-alien-signals

[English](README.md) | [日本語](README.ja.md)

[alien-signals](https://www.npmjs.com/package/alien-signals) の実験的なReactバインディングです。小さなリアクティブプリミティブ、Reactフック、そして対象を意図的に絞ったDOMプロパティへの直接バインディング用JSXランタイムを提供します。このJSXランタイムは明示的に有効化した場合のみ使用されます。

**React 19以降が必要です。** JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。

## ドキュメント

- [コアプリミティブ](docs/core-primitives.ja.md) — `signal`、`computed`、`effect`、`batch`、`untracked`、`deepSignal`。
- [Reactフック](docs/hooks.ja.md) — `useSignals`、`useSignal`、`useDeepSignal`、`useComputed`、`useSignalEffect`、低レベルselector hooks。
- [描画最適化](docs/rendering-optimization.ja.md) — 明示的な `useSignals()` 追跡とbuild pluginによる自動挿入の比較。
- [JSXのsignal子要素とhost binding](docs/jsx-bindings.ja.md) — 独自JSXランタイムのDOM直接bindingとその制約。
- [JSX制御フローユーティリティ](docs/control-flow.ja.md) — `Show`、`Switch` / `Match`、`For`、`Index`。

未決定、または過去の実装判断に関する設計検討メモは[`docs/design/`](docs/design/)にあります。索引全体は[`docs/README.ja.md`](docs/README.ja.md)を参照してください。

## 開発

workspaceの開発にはNode.js 24.19.0、pnpm 11、React 19以降を使用します。privateなroot manifestはNode.js `^24.19.0` を許可し、`.node-version` にはNode 24 LTSの最新patchを記載しています。CIもこのファイルを直接読みます。これはpackageがprivateな間のrepository tooling向けguardであり、公開runtimeの互換性を示すものではありません。公開前には配布packageのNode.js下限を別途検証し、test/build toolの厳しい要件を誤って引き継がないようにします。

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
pnpm test:browser
```

同じサンプルを `http://127.0.0.1:4173` で確認するには、`pnpm dev:browser` を実行してください。このコマンドは最初に変換パッケージをビルドします。

## ベンチマーク

ベンチマークは手動診断用であり、CIのパフォーマンス基準ではありません。ビルド済みの出力を計測し、時間計測外で正しさを検証します。ウォームアップ後の中央値と四分位範囲を報告します。

```sh
pnpm bench
pnpm bench:deep
pnpm bench:react
pnpm bench:transform
```

コアの結果では、生の `alien-signals`、このパッケージ、`@preact/signals-core` を比較します。数値は同じマシンとNode.jsバージョンでのみ比較してください。ホステッドCIの実行時間は変動が大きいため、信頼できる回帰しきい値には適しません。

`bench:react` は、jsdom上に小さなReactツリーをマウントし、N個の無関係な兄弟行の上に共有カウンターを置いた場合の3パターンを比較します: memo化していないhooks（更新のたびに全ての兄弟が再レンダリングされる）、`React.memo`でラップしたhooks（兄弟は一度だけレンダリングされるが、更新のたびにbail outのためfiberを走査する）、signals（所有コンポーネント自体が再レンダリングされないため兄弟は一切再訪問されない）。各パターンについて兄弟の再レンダリング回数と更新のスループットを報告します。

`bench:transform` は最初にbuildを行い、配布済みVite adapterの小・大規模TSX moduleに対するparse、scope、書き換え、source map、code generationの経路を測定します。pass-throughの下限と、変換候補がないBabelケースを含むため、将来互換性のあるSWC/Oxc実装を同じcorpusで比較できます。
