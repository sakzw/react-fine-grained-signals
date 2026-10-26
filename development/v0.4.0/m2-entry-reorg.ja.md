# M2 entry再編

- 基準: M1完了時点（`3f556f8`）
- 方針: D2。旧entryはaliasを残さず削除する。`/utils`は据え置き。

## 新旧の対応

| 新entry | 旧entry | ソース |
|---|---|---|
| `.`（`createElement`を除く） | `.` | `src/index.ts` |
| `./jsx` | `.`の`createElement` | `src/jsx.ts`（`createElement`、`Fragment`、`JSX`型、`SignalChild`型） |
| `./jsx/jsx-runtime`、`./jsx/jsx-dev-runtime` | `./jsx-runtime`、`./jsx-dev-runtime` | `src/jsx/jsx-runtime.ts`、`src/jsx/jsx-dev-runtime.ts` |
| `./jsx/lite` | `./lite` | `src/jsx/lite.ts`（`createElement`、`Fragment`、`JSX`型、`SignalChild`型） |
| `./jsx/lite/jsx-runtime`、`./jsx/lite/jsx-dev-runtime` | `./lite/jsx-runtime`、`./lite/jsx-dev-runtime` | `src/jsx/lite/` |
| `./internal` | `./runtime` | `src/internal.ts` |
| `./utils` | `./utils` | 変更なし |

- Full版にも`SignalChild`型のexportを足し、Lite版とそろえた。
- `src/runtime/`（JSX実装のディレクトリ）の名前は、公開entryではないので変えていない。
- `src/internal.ts`の先頭に「生成コード専用、semver対象外」のコメントを付けた。この中身（`useManagedSignals`など）はM3で整理する。

## 変更した箇所

- `package.json`の`exports`、`tsdown.config.ts`、`scripts/check-size.mjs`（`DIST/jsx/...`）、`benchmarks/`の`dist/`参照
- transform: `${options.importSource}/runtime`を`/internal`へ（`transform.ts`の5箇所）。テストの期待値、plugin READMEの該当記述（英日）も更新
- 移行: `tests/`、`packages/*/tests/`、`examples/`、`website/`、`README*`、`docs/guides/`のimport・pragma・`jsxImportSource`・alias（vitest、tsconfig paths、vite config、`server.mjs`）。`docs/releases`・`docs/migration`と`development/`の過去記録は履歴なので変更していない
- docs: `docs/guides/jsx-bindings.md`（英日）の`createElement`の説明、`website/src/pages/installation.mdx`のentry表
- `plugin側のpeer range ^0.4.0`は、plugin・本体のversionをM10で`0.4.0`にするときに`workspace:^`が解決するので、M2では変えていない

## 検証

- consumer smoke（`tests/consumer-smoke.mjs`）: 新entryのimportを検証。ルートが`createElement`をexportしないこと、旧entry（`lite`、`lite/jsx-runtime`、`lite/jsx-dev-runtime`、`jsx-runtime`、`jsx-dev-runtime`、`runtime`）が`ERR_PACKAGE_PATH_NOT_EXPORTED`で解決エラーになることを追加。Vite+React Compilerのビルド出力が`react-fine-grained-signals/jsx`から`createElement`をimportすることも検証している。
- サイズ（gzip）: `index-full` 23.14 → 16.37 kB（`createElement`とJSX実装がルートから外れた）。それ以外のscenarioは±数十バイト。`scripts/size-budget.json`は`index-full`だけ下げた（24896 → 17600）。`lite-jsx-child`は+20 B（5.52 → 5.54 kB）だが予算は上げず5952のまま。
- 不安定なテスト: transformの`reports a stack overflow from a very long helper chain...`が5秒のtimeoutで落ちる（単独実行でも約5.3秒。M0でも同じテストが負荷時に落ちた）。M2の変更とは無関係で、マシンが空いているときは通る。
- vitest runtimeの件数は、実行によって39ファイル・777件や37ファイル・732件と少なく出ることが2回あった。再実行では毎回41ファイル・910件。完了時はファイル数・件数を必ず確認する。

## ゲート

lint、typecheck、runtime vitest（41ファイル・910件）、`pnpm build`、`pnpm size`、`pnpm test:consumer`は通過。`test:transform`は上記のtimeoutを除いて通過。`test:browser`（負荷の高い初回は5件が失敗、再実行で53件成功）と、websiteのpackし直し・typecheck・build・smokeも成功。CIは末尾の「GitHub CI」を参照。

## GitHub CI

e2e57aaのpushで、Test、E2E、Website CIがすべて成功した。
