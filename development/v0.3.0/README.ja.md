# v0.3.0 開発ロードマップ

## 現在の状態

- 状態: registered-symbol key regressionを修正し、runtime 571/571・transform 404/404のcoverage、typecheck/lint/build、consumer、interop、browser E2E 59/59、bundle budgetsを通過。M8はローカルmainで再freezeした。GitHub Actions成功runは先行するmanaged-tracking closureを対象としており、このsymbol修正は未pushのため未検証。Actionsの再実行がrelease qualification blocker。公開tag、npm publish、GitHub Releaseは未実施。詳細は[M8 qualification status](m8-qualification-status.ja.md)。
- 統合ブランチ: `main`
- v0.2.1 ベースライン: `58f01b9314a1b09b88b162c57912ff736201e790` (`main`、package version `0.2.1`)
- 開始時の作業ツリー: clean。ローカルタグは `v0.1.0`、`v0.1.1`、`v0.2.0`。`v0.2.1` タグはこのcloneに存在しない。公開済みversionはpackage metadataとrelease記録で確認した。
- Vue 3.6参照: `v3.6.0-rc.11`、commit `b55f3b92a185e87680ca7f69252451964be08b00`。2026-10-13時点で公式Release一覧の最新3.6候補であり、pre-release。安定版と同じ保証としては扱わない。
- Vue参照: [Release](https://github.com/vuejs/core/releases/tag/v3.6.0-rc.11)、[collectionHandlers.ts](https://github.com/vuejs/core/blob/v3.6.0-rc.11/packages/reactivity/src/collectionHandlers.ts)、[reactive.ts](https://github.com/vuejs/core/blob/v3.6.0-rc.11/packages/reactivity/src/reactive.ts)。参照テストは同タグの `packages/reactivity/__tests__/collections/` 以下。

ロードマップの変更履歴と現在の有効な判断を混同しない。新しい決定は該当マイルストーン記録と本書の状態に反映し、旧判断は履歴として残す。

## マイルストーン

| Milestone | 内容 | 依存関係 | 開始・完了条件 | 状態 |
|---|---|---|---|---|
| M0 | 現行契約、React統合、Vue 3.6差分、性能・保守性、変更候補を棚卸し | v0.2.1基準固定 | 公開契約・非目標・breaking候補・依存関係を記録 | 完了 |
| M1 | signal/computed/effect/batch/untracked、ownership、subscription、interopの正確性・性能レビュー | M0 | 回帰契約を固定し、証拠のある改善だけ採用。cross-copy、speculative render、ownershipを維持 | 完了・コード変更なし |
| M2 | Map/Set/WeakMap/WeakSetを含むdeep reactivityと型・依存粒度 | M0、M1のruntime契約 | 公開API、identity、dependency matrix、weak semanticsを先に確定し、境界テスト後に実装 | 完了 |
| M3 | React render tracking境界、Hooks、Fast Refresh、StrictMode、Suspense、Concurrent、SSR | M0。M4より先に契約決定 | ReactのRules of Hooksに適合する候補を実環境で証明。`managed`を`inject`へ置換するだけでは完了にしない | top-level capture/read単位codegenを既定managedへ統合。Fast Refresh、hydration、mock-scheduler time-slicing、abandoned-attempt cleanupを確認。bounded synchronous exactness契約で完了 |
| M4 | React Compilerのsignal read、memoization、directive、diagnostics | M3のtracking契約 | build-timeと実行時のstale readをcompiler有効/無効で確認 | Compiler/Babel suite、author directive、integration opt-out、および実Vite production buildの両登録順で確認。完了 |
| M5 | transform検出、安全性、RSC、diagnostics、bundler互換性 | M3のtransform契約。独立調査は先行可 | 静的に証明できる範囲と曖昧な範囲を分け、誤注入を安全に拒否 | module-level `use server`をskip + warning。Vite/Rollup/Webpack/Rspack/esbuild実buildのRSC/warning/source-map matrix完了 |
| M6 | JSX direct binding (style、value/checked、lifecycle、SSR/hydration、例外、型) | M0。collection読み取り統合はM2後 | DOM更新の意味論とattach/detach・フォーム挙動を固定 | per-property style、single/multiple select SSR/hydration/resetをJSDOMで確認。Dev SSR 48/48、production browser 12/12を3 engineで確認 |
| M7 | 性能・メモリ・bundle・transform比較 | M0でベースライン確定、M1〜M6の比較対象 | 同条件の反復計測、ウォームアップ・ばらつき報告、正確性を保った判定 | paired baseline計測完了。computed/batchの高負荷再計測で悪化なし。retained-heap recheckも完了し、分布重複を含む制約を記録。サイズ予算通過 |
| M8 | 全体qualificationとfreeze | M1〜M7 | 指定runtime/transform/browser/bundler/SSR/Compiler/pack/consumerのgateを通過し、重大問題ゼロ | registered-symbol regression closure後のローカルqualificationを完了し、v0.3.0 candidateをlocalで再freeze。GitHub Actionsのpost-fix runは未実施で、release qualification blockerとして記録。詳細は[M8 qualification status](m8-qualification-status.ja.md) |

M3の調査開始記録は[React tracking audit](./m3-react-tracking-audit.ja.md)、M4の現行Compiler契約とqualificationは[Compiler audit](./m4-compiler-qualification-audit.ja.md)、M7の比較設備と条件は[performance plan](./m7-performance-qualification-plan.ja.md)を参照。

### 依存と並列化

- M1のcore契約確認とM2のcollection設計・prototypeは、変更範囲を分離して並列化できる。ただしM2実装はruntime adapter・batch・cleanupの契約確認後に統合する。
- M3のrender boundary設計はM4に先行する。M3と独立したM5のmode検出・RSC調査、M6のDOM semantics調査、M7のbaseline収集は並行可能。
- 共通API/型を共有する実装は契約レビュー後、別worktree・明示された担当範囲で実施する。並列化対象以外は統合ブランチで進める。
- M8の結果を満たさない場合はfreezeしない。公開、push、公開タグ、npm publish、GitHub Releaseは別途明示承認があるまで行わない。

## v0.2.1で維持する基準

- high-levelのsignal APIとReact integrationは自前、low-level graph backendは `alien-signals@3.2.1` を維持する。置換は測定と契約上の必要性を示せた場合だけ検討する。
- cross-copy interop、effect ownership、cleanup、speculative render、現在のReact root/leaf binding契約を回帰基準とする。
- v0.2.1 release qualificationの性能記録は方向性の資料として扱い、単一の小規模値を新しい性能保証にしない。M7で同条件の基準値を再収集する。

## 直近の作業

1. M3現行実装とstrict tracking gateは [React tracking audit](m3-react-tracking-audit.ja.md) を参照する。
2. managedの静的追跡契約、警告可能範囲、unsupported callback/deep destructuring、root/concurrent ownershipを実装・実環境で閉じる。
3. M3方式に対するM4 Compiler matrixを完了する。M5のdiagnostics/RSC/adapter監査は [M5 audit](m5-transform-reliability-audit.ja.md)、M6のdirect-binding qualification gapsは [M6 audit](m6-binding-qualification-audit.ja.md) を参照する。
4. 各マイルストーン完了時にdiff review、必要な検証、記録、意味のあるcommitを行う。テスト実行は該当する変更の正しさを確認するために行う。

詳細は [M0 architecture review](m0-architecture-review.ja.md)、[M2 collection contract](m2-collection-contract.ja.md) を参照。
