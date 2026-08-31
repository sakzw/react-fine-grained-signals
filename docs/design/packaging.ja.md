# パッケージング

[English](packaging.md) | [日本語](packaging.ja.md)

**状態:** 決定済み。このdocsは、パッケージをこの形で配布している理由を記録するものです。以下の判断はいずれも実装済みでcheckによって守られており、未決定の設計課題はありません。

## `alien-signals` をpeer dependencyにしている理由

`alien-signals` は直接のdependencyではなく **peer dependency** です。alien-signalsの依存追跡はmodule globalな状態（`getActiveSub` / `setActiveSub`）に置かれているため、1つのアプリケーションに2つのcopyが入るとbytesを無駄にするだけでは済みません。片方のcopyが追跡した読み取りはもう片方から見えず、しかも例外は投げられません。peerとして宣言することでpackage managerが単一instanceに解決し、`pnpm test:consumer` が公開manifestのその状態を検証します。

## `"sideEffects": false`

packageは `"sideEffects": false` を設定しています。module graphからside effectを推論するbundlerは、この宣言がなくても既に正しくtree shakingできます。`signal` だけをimportした場合のコストは、entry全体の3分の1未満です(`pnpm size` の `signal-only` / `index-full` シナリオが現在の実測値を出します)。Vite/Rolldownでは、このflagの有無で前者が約40 bytes動くだけで、後者は変わりません。それでも設定しているのは、証明する代わりに宣言を信頼するbundler（webpackの `sideEffects` 最適化）のためと、保証を固定するためです。後からtop levelのside effectを追加した場合、すべてのconsumerに黙ってcostを課す代わりにcheckが失敗します。

```sh
pnpm size
```

`scripts/check-size.mjs` は代表的なconsumerのimport graphをbundleし、gzipとbrotliのサイズを `scripts/size-budget.json` と比較したうえで、tree shakingで落ちるべきcodeが実際に存在しないことを検証します。この不在checkには陽性対照を組み合わせてあるため、marker文字列がrenameされた場合はcheckが無意味化する代わりに失敗します。サイズの増加が意図的な場合は `pnpm size:update` を実行してください。

## リリースは `pnpm publish` を使う

リリースは素の `npm publish` ではなく `pnpm publish` を通す必要があります。これにより `react-fine-grained-signals` に対する `workspace:*` のpeer rangeが、公開前に実際のsemver rangeへ書き換えられます。`unplugin-react-fine-grained-signals` の `prepublishOnly` scriptがこれを強制します。
