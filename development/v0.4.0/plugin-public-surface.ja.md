# pluginの公開exportの絞り込みと`include`/`exclude`の拡張

v0.4.0の公開前に、`unplugin-react-fine-grained-signals`の公開面を見直した記録。

## 公開exportの絞り込み（破壊的）

### 変更前

root（`src/index.ts`）と各adapter（`vite`、`rollup`、`webpack`、`rspack`、`esbuild`）が`export * from "./unplugin.js"`をしていた。そのため、adapterとpackage内のtest用に置いたhelperも公開APIになっていた。対象は`canTransform`、`resolveEsbuildLoader`、`createBundlerPlugin`、`pluginName`、`EsbuildLoaderName`、`BundlerTransformOutput`。公開後に名前を変えると、semverの破壊的変更になる。

### 変更後

公開する名前を`src/public.ts`に列挙し、各entryはそこからre-exportする。全entryが同じ名前をexportする。

- 値: `default`、`reactFineGrainedSignals`、`REACT_FINE_GRAINED_SIGNALS_DIAGNOSTIC_IDS`
- 型: `ReactFineGrainedSignalsOptions`、`ReactFineGrainedSignalsDiagnosticsOptions`、`ReactFineGrainedSignalsFilterPattern`（下記で追加）、`ReactFineGrainedSignalsMode`、`ReactFineGrainedSignalsReactCompiler`、`ReactFineGrainedSignalsTransform`、`ReactFineGrainedSignalsDiagnosticId`
- adapterだけが持つ型: `VitePlugin`、`RollupPlugin`、`WebpackPlugin`、`RspackPlugin`、`EsbuildPlugin`

helperは`src/unplugin.ts`からexportしたままにした。package内のtestは`../src/unplugin.js`から直接importする。`dist/*.d.ts`のentryには出ない。`VitePlugin`/`RollupPlugin`が参照する`BundlerTransformOutput`は、d.tsではchunk内の非公開の型になる。

`pluginName`はREADMEに載っておらず、consumer smokeだけが使っていた。値は`"unplugin-react-fine-grained-signals"`の文字列で、pluginの`name`から読める。

entry間で共有するchunkは`dist/public-*.js`という名前になった。exports mapの外なので、利用者には影響しない。

## `include`/`exclude`の拡張（非破壊）

述語関数だけでなく、`RegExp`、またはそれらのreadonly配列を受け付ける。配列は、どれか1つが一致すれば一致とする。

- 文字列とglobは受け付けない。正しいglobにはpicomatchなどの依存が要るため。文字列を渡すと、plugin作成時に`TypeError`になる（`reactCompiler`の不正値と同じ扱い）。`null`、数値、入れ子の配列も同じく例外になる。webpack/rspackはunpluginがfactoryを`apply()`で呼ぶため、例外もその時点で出る。
- 空の`include`配列は何にも一致しない（「どれか1つが一致」をそのまま適用）。Rollup/Viteの`createFilter`は空の`include`を「制限なし」とみなすため、ここは挙動が異なる。動的に組んだ許可リストが空になったときに、全moduleを変換しない方を選んだ。
- `RegExp`は作成時に複製し、毎回`lastIndex`を0に戻してから`test`する。`g`/`y`付きでも、前に判定したidに結果が左右されない。利用者のRegExpオブジェクトは変更しない。
- 既存の意味は変えない。判定はbundlerが渡したそのままのid（query込み）で行う。`exclude`が`include`より優先する。`node_modules`と`\0`で始まるidは常に対象外。
- 判定は`createModuleFilter(options)`で作成時に1回だけ組み立てる。`transformInclude`とViteの`order: "pre"` handlerは同じ関数を使う。

## テスト

- `packages/unplugin-react-fine-grained-signals/tests/unplugin.test.ts`: RegExp・述語・配列・空配列、`exclude`の優先、`node_modules`/`\0`の除外、queryを含むidへの一致、`g`/`y`フラグの`lastIndex`、不正値の`TypeError`、Vite hookでの適用。
- `packages/unplugin-react-fine-grained-signals/tests/build-smoke.mjs`: 各entryのruntime exportと`dist/*.d.ts`のexport名が上の一覧と完全に一致すること。
- `tests/consumer-smoke.mjs`: packしたpluginの各entryのruntime exportが一覧と一致し、internalの名前がrootにないこと。`pluginName`のimportをやめた。
- `tests/fixtures/consumer-vite/src/entry-contract.ts`: 公開型をすべてimportして使い、internalの値の名前がrootのkeyにないこと、internalの型が`@ts-expect-error`でimportできないことをtscで確かめる。

## 互換性

公開exportの削除は破壊的。v0.4.0は未公開のため、このリリースで行う。`include`/`exclude`の拡張は非破壊（既存の述語関数はそのまま動く）。
