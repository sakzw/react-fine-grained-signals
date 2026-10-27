# oxfmtの導入

v0.4.0のマイルストーン後に、コードのformatterとしてoxfmtを入れた（2026-10-27、メンテナ判断）。

## 理由

コードの多くをAIエージェントが書いており、セッションごとに折り返しの癖が違うまま残っていた（引数ごとの改行と1行の書き方が混在していた）。v0.4の作業が終わり、並行する作業がない時期なので、一括整形による衝突のコストがない。lintで使っているoxlintと同じoxcのツールなので、ツールチェーンも揃う。

## 設定

- `oxfmt@0.74.0`をexact pinにした。0.xなので、versionを上げると出力が変わることがある。上げるときは、bumpと再整形を1つのコミットにまとめる。
- `.oxfmtrc.json`: `printWidth: 120`、ほかは既定値。100と120で試したところ、120のほうが差分が少なかった（100: +11,199/−4,912、120: +9,189/−5,152）。
- 対象はコードだけ。除外したもの: `benchmarks/`と`development/`（過去の計測・記録）、`website/`（独立したpackage）、`tests/fixtures/`、md・mdx・json・yaml・html・css。`playground/`は`.gitignore`で除外される。
- scripts: `pnpm fmt`、`pnpm fmt:check`。CI（Test）のLintと並べて、`fmt:check`をbackgroundのステップとして足した。
- `.git-blame-ignore-revs`に整形のコミット（`6057670`）を登録した。GitHubは自動で読む。ローカルでは`git config blame.ignoreRevsFile .git-blame-ignore-revs`を設定する。

## 整形の結果

94ファイル、+9,332/−5,365。整形が意味を変えたのは1件だけだった。`tests/utils-types.tsx`で`<Match …>`が複数行に分かれ、`@ts-expect-error`が別の行にかかるようになった（typecheckで検出）。コメントを、エラーになる`equals`属性の直前に移した。

## ゲート

- `pnpm lint`: 警告とエラーの件数が整形前と同じ（141件）
- `pnpm typecheck`、`pnpm build`、`pnpm test:consumer`、`pnpm fmt:check`
- `pnpm size`: すべてのscenarioが整形前と同じ
- `pnpm exec vitest run --maxWorkers=2`: 43ファイル、935件
- `pnpm test:transform`（`--maxWorkers=2`）: CPU使用率が90〜100%の状態で実行し、`very long helper chain`のテストが5秒でtimeoutした。整形前のコードでも、単独実行で同じように失敗した（約5.3秒）ので、負荷による失敗で、整形とは関係ない。ほかの2件の失敗も、再実行では通った。
- `pnpm test:browser`: 同じ負荷のため、ローカルでは実行していない。CIのE2Eで確認する。
