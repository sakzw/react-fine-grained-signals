# M10 移行ガイド・リリースノート・最終ゲート

- 基準: M11完了時点（`ac5c91f`）
- publish（npm publish、tag、GitHub Release、Pages deploy）は行っていない。

## 作成・更新したもの

- `docs/migration/v0.4.md`、`v0.4.ja.md`: 冒頭に「変更前 → 変更後」の対応表、続けてM1〜M8とM11の変更ごとの節（package copy、entry、`useManagedSignals`、依存配列と`useWritableComputed`、React 19.3、TypeScriptの変更、`deepCollectionSignal`）、最後にチェックリスト。M2のentry対応表を含む。
- `docs/releases/v0.4.0.md`: 破壊的変更、追加、削除、サイズの計測値。M9（診断の既定エラー化）は見送りなので含めない。
- `docs/README.md`/`README.ja.md`、`README.md`/`README.ja.md`、plugin README（英日）、website（`index.mdx`、`installation.mdx`、`migration.mdx`、`website/README.md`）のversion表記とリンクを`0.4.x`／v0.4に更新。`website/src/pages/migration.mdx`は、v0.3→v0.4の短い一覧を先頭に足し、既存のv0.2→v0.3の内容は残した。
- version: `package.json`と`packages/unplugin-react-fine-grained-signals/package.json`を`0.4.0`に。pluginのpeer range（`workspace:^`）は、`pnpm pack`した成果物で`^0.4.0`になることを確認した。

## 範囲外のもの

- `docs/migration/v0.2*`・`v0.3*`、`docs/releases/v0.3.0.md`、`development/`配下の過去記録は履歴なので書き換えていない（旧entry名などが残っている）。
- `benchmarks/m10-list-bench.mjs`はM3で`useManagedSignals`が公開APIから消えたため動かない（ゲートではない）。

## 最終ゲート（ローカル）

| ゲート | 結果 |
|---|---|
| `pnpm lint` | エラー0 |
| `pnpm typecheck`（runtime・transform） | エラー0 |
| `examples/react-router`の`typecheck` | 成功 |
| `pnpm exec vitest run --maxWorkers=2`（runtime） | 42ファイル・923件 |
| `pnpm test:transform`（`--maxWorkers=2`） | 8ファイル・733件 |
| `pnpm build` | 成功 |
| `pnpm size` | 予算内 |
| `pnpm test:consumer` | 成功 |
| `pnpm test:browser` | 53件成功 |
| website（pack、typecheck、build） | 成功 |

サイズ（`pnpm size`、gzip）の最終値: signal-only 4.61、core 4.67、core+hooks 8.21、deep 10.10、deep-collections 13.35、index-full 16.72、jsx-runtime 12.11、full-jsx-child 12.01、lite-jsx-child 5.53、utils 8.10 kB。v0.3.0（M0時点）との差は`docs/releases/v0.4.0.md`の通り。

## GitHub CI

push後に追記する。
