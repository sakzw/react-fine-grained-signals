# 開発ツールの更新とActionsのlockfile（v0.4.0の公開前）

v0.4.0の公開前に、開発用の依存、開発で使うNode、GitHub Actionsの参照の固め方を更新した記録（2026-11-19）。ライブラリの公開API・runtimeの挙動・`engines`は変えていない。

## 依存

公開から1日以上たった最新版に上げた（全件、`published_at`を確認）。指定子の形（`^`の有無）は変えていない。

- root: `@preact/signals-core` 1.14.5、`tsdown` 0.23.7、`vite` 8.3.8、`vitest`・`@vitest/coverage-v8` 5.1.0、`@vitejs/plugin-react` 6.3.0、`@rolldown/plugin-babel` 0.3.1、`@playwright/test` 1.65.1、`oxlint` 1.94.0、`oxfmt` 0.79.0、`jsdom` 31.0.1、`@types/node` 26.6.6
- plugin: `@babel/core`・`@babel/types` 8.1.2、`unplugin` 3.7.0、`@rspack/core` 2.3.3、`rollup` 4.68.5、`tsdown`・`vitest`・`@vitest/coverage-v8`（rootと同じ）
- website: `vocs` 2.13.0、`waku` 1.0.0-rc.5、`vite` 8.3.8、`@vitejs/plugin-react` 6.3.0、`playwright` 1.65.1、`@types/node` 26.6.6
- examples/react-router: `react-router`・`@react-router/*` 8.5.1、`isbot` 5.2.3、`vite` 8.3.8、`@types/node` 26.6.6
- `packageManager`: pnpm 12.21.0（3つのmanifest）
- 据え置き: `typescript`は`7.1.0-beta`のまま（betaの最新。`latest`の7.0.2は後退になる）

メジャー相当の2件は変更点を確認した。`jsdom` 31はcanvasのbackend変更、CSS実装の置き換え、blocking scriptでのparse停止が破壊的変更で、このリポジトリはcanvasを使わず、テストは通った。`@rolldown/plugin-babel` 0.3は`parallel`オプションの追加だけ。

テストの変更は1件。`@babel/generator` 8.1が型アサーションの代入先を括弧で囲むようになり（`(<number> s.value) = 2;`）、`tests/shared-predicates.test.ts`の正規表現を両方の形を受けるようにした。意味は同じ。

## Node 26

開発で使うNodeを26.13.1（LTS、2026-11-10）にした。`devEngines.runtime`と、website系workflowの`pnpm/setup`の`runtime:`を変えた。ほかのworkflowは`pnpm/setup`が`devEngines.runtime`を読むので、それで26になる。利用者向けの`engines`（runtime `>=22.0.0`、plugin `^22.18.0 || >=24.11.0`）は変えていない。

E2EとWebsite CIのコンテナは、playwright 1.65に合わせて`mcr.microsoft.com/playwright:v1.65.1-resolute`（Ubuntu 26.04）にし、digest（`sha256:dcf385f7…`）で固定した。コンテナイメージはActionsのlockfileの対象外のため。

## Actionsのlockfile

GitHub Actionsのworkflow lockfile（2026-10-28 GA、[docs](https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles)）を採用した。

- `uses:`をSHA固定からタグ表記（`actions/checkout@v7.0.1`など）に戻し、`gh actions-lock`（v0.4.1）で`.github/workflows/actions.lock`を生成した。全workflowを対象にしている。lockfileがあるworkflowは、runnerが記録したcommitを実行する。
- 書き換える前に、元のSHAがコメントのタグと一致することを確認した（6件すべて一致）。lockfileが記録したcommitも元のSHAと同じ（`pnpm/setup`は同時にv3.2.0へ上げたので新しいcommit）。推移的な依存（`upload-pages-artifact`が使う`upload-artifact`）も記録されている。
- `verify-lockfile.yml`を追加した。workflowの変更時に`gh actions-lock --verify`で古いlockfileを検出する。拡張はv0.4.1に固定している。
- `uses:`を変えたら`gh actions-lock`を再実行して、lockfileもcommitする。lockfileは手で編集しない。

## ゲート

lint、fmt:check、typecheck、runtime vitest（`--maxWorkers=2`、46ファイル・978件）、transform（12ファイル・2119件）、build、size（変化なし）、consumer、`test:browser`（53件）、examplesのtypecheck、website（typecheck、build、smoke）が通った。`gh actions-lock --verify`も通った。

作業中は、別の作業のdotnetのbuildでCPUが100%になっていた。そのため、runtimeの初回の実行でworkerの起動がtimeoutし（9 errors）、transformではesbuild adapterの3件、prefilterの1件、webpack RSCの1件がtimeoutで落ちた。browserではFirefoxとWebKitのhydrationの各1件が落ちた。どれも再実行や単独の実行では通り、コードの変更とは関係しない。

## GitHub CI

`c59c389`のpushで、Test、E2E、Website CI、Verify actions lockfileがすべて成功した。Testのjobのログに`Using locked action versions from the workflow's lockfile`と出ており、runnerがlockfileのcommitを使ったことを確認した。
