# react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

[alien-signals](https://www.npmjs.com/package/alien-signals) を基盤とした、React 19向けの実験的なfine-grainedレンダリングレイヤーです。小さなリアクティブプリミティブ、Reactフック、そして対象を意図的に絞ったDOMプロパティへの直接バインディング用JSXランタイムを提供します。このJSXランタイムは明示的に有効化した場合のみ使用されます。

**React 19以降が必要です。** JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。

## ドキュメント

ライブラリの使い方のガイド、設計検討メモ、ドキュメント索引全体については[`docs/README.ja.md`](docs/README.ja.md)を参照してください。

## パッケージング

`alien-signals` は直接のdependencyではなく **peer dependency** です。alien-signalsの依存追跡はmodule globalな状態（`getActiveSub` / `setActiveSub`）に置かれているため、1つのアプリケーションに2つのcopyが入るとbytesを無駄にするだけでは済みません。片方のcopyが追跡した読み取りはもう片方から見えず、しかも例外は投げられません。peerとして宣言することでpackage managerが単一instanceに解決し、`pnpm test:consumer` が公開manifestのその状態を検証します。

packageは `"sideEffects": false` を設定しています。module graphからside effectを推論するbundlerは、この宣言がなくても既に正しくtree shakingできます。`signal` だけをimportした場合は2.55 kB gzipで、entry全体では7.79 kBです(`pnpm size`の`signal-only`/`index-full`シナリオとして追跡されているため、コードが変わればこの数値も追従します)。Vite/Rolldownでは、このflagの有無で前者が約40 bytes動くだけで、後者は変わりません。それでも設定しているのは、証明する代わりに宣言を信頼するbundler（webpackの `sideEffects` 最適化）のためと、保証を固定するためです。後からtop levelのside effectを追加した場合、すべてのconsumerに黙ってcostを課す代わりにcheckが失敗します。

```sh
pnpm size
```

`scripts/check-size.mjs` は代表的なconsumerのimport graphをbundleし、gzipとbrotliのサイズを `scripts/size-budget.json` と比較したうえで、tree shakingで落ちるべきcodeが実際に存在しないことを検証します。この不在checkには陽性対照を組み合わせてあるため、marker文字列がrenameされた場合はcheckが無意味化する代わりに失敗します。サイズの増加が意図的な場合は `pnpm size:update` を実行してください。

## 開発

workspaceの開発にはNode.js 24.19.0、pnpm 11、React 19以降を使用します。privateなroot manifestはNode.js `^24.19.0` を許可し、`package.json`の`devEngines.runtime`にNode 24 LTSの最新patchを固定しています。CIおよびローカルのinstallも`pnpm/setup`経由でこの設定を直接読みます。これはpackageがprivateな間のrepository tooling向けguardであり、公開runtimeの互換性を示すものではありません。公開前には配布packageのNode.js下限を別途検証し、test/build toolの厳しい要件を誤って引き継がないようにします。

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

## 謝辞

- [alien-signals](https://www.npmjs.com/package/alien-signals) — 本パッケージが基盤とするシグナルエンジン。
- [@preact/signals-core](https://www.npmjs.com/package/@preact/signals-core) — ベンチマークの比較対象。
- [@preact/signals-react](https://www.npmjs.com/package/@preact/signals-react) — `useSignals()` boundaryのstore protocol設計における先行事例。詳細は[Prior art](docs/design/use-signals-boundary-design.ja.md#先行事例)を参照。
