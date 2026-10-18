# v0.3.0 開発ロードマップ

## 現在の状態

- 状態: M18.8 Numeric Form Bindingを完了。`input[type="number"]`へstring Signalの`bindValue`を拡張し、ブラウザ標準のValidity/sanitizationを維持。Test、E2E、Website CI成功。検証記録は[M18.8 record](m18.8-numeric-form-binding.ja.md)。
- 統合ブランチ: `main`
- 最新実装マイルストーン: M18.8 Numeric Form Binding（数値inputへの文字列Signal binding）。詳細は[M18.8 record](m18.8-numeric-form-binding.ja.md)。
- v0.2.1 ベースライン: tag `v0.2.1` / commit `58f01b9314a1b09b88b162c57912ff736201e790` (`package version 0.2.1`)
- M0開始時の作業ツリー: clean。公開済みbaselineはpackage metadata、tag、release記録で確認した。
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
| M8 | 全体qualificationとfreeze | M1〜M7 | 指定runtime/transform/browser/bundler/SSR/Compiler/pack/consumerのgateを通過し、重大問題ゼロ | registered-symbol regression closure後のlocal qualificationとGitHub Test/E2Eを完了し、v0.3.0 candidateを再freeze。詳細は[M8 qualification status](m8-qualification-status.ja.md) |
| M9 | — | — | — | M8 freeze後のフォームbinding完成作業であり、本ロードマップ初版では別途記録済み |
| M10 | 細粒度renderingとWritable computed | M8 | API・DOM同期・イベント順序を検証 | 完了。`For`/`Index`最適化は証拠不足のため採用せず。Writable computed coreとform bindingを追加 |
| M11 | React hook/form group APIとobject snapshot評価 | M10 | writable `useComputed`、radio/checkbox group、immutable deep object snapshotの契約と性能を確認 | writable hookとradio/checkbox group完了。object snapshot prototypeはO(subtree)の高コストと不安定なheap計測により見送り。full coverage、browser、consumer、mixed-version、size gateを通過。詳細は[M11 closure record](m11-react-hooks-and-form-groups.ja.md) |
| M12 | computed生成profile、radio/checkbox group境界、DOM retention監査 | M11 | benchmarkを層別化し、効果が実測できる変更のみ採用。group native semanticsとunsubscribe/DOM cleanupを検証 | 完了。性能最適化は効果が確認できず見送り。radio source mismatchを拒否。local qualificationとGitHub Actions Test/E2E成功。詳細は[M12 audit](m12-performance-radio-dom-audit.ja.md) |
| M12.1 | radio binding source一括切替、computed benchmark比較の妥当性 | M12 | 同一commitで全radioをSignal差し替えし、ref lifecycleとgroup競合契約を維持。benchmark capabilityとchecksumを検証 | 完了。detached済みpeerを差し替え中に限り無視。writable比較と全checksum検査を修正。詳細は[M12.1 closure](m12.1-radio-binding-benchmark.ja.md) |
| M13 | v0.3.0 release readiness review | M12.1 | Public API/types、package/tarball/consumer、docs/migration、React/browser、performance/bundle、final qualificationを監査。重大問題を修正してM8 freezeを判断 | **READY WITH KNOWN LIMITATIONS（当時の判定）。** GitHub Test `38662092010`とE2E `38662092091` success。M14開始時に追加performance workのためfreezeを解除。結果と制約は[M13 record](m13-release-readiness.ja.md) |
| M14 | computed performance deep dive / M15-M16先行調査 | M13 | CPU/allocation profile、複数の異なる最適化prototype、paired benchmark、tracking・browser retention auditを実施し、根拠ある改善だけ統合 | 完了。interop protocol lazy materializationを採用、brand descriptor共有は不採用。M15.1/M16の後続CIでもTest/E2Eを確認。M13時点のperformance/retention不確定を更新。詳細は[M14 record](m14-computed-performance-and-next-audits.ja.md) |
| M15 | managed tracking coverage expansion | M14 | 既存alias契約を維持し、意味論を保てるdestructuring subsetのみ追加。React runtime動作、diagnostics、performance、M16 retentionを検証 | 完了。static `const` object destructuringを追加。runtime 621/621、transform 417/417 + final diagnostic 1/1、React Compiler 27/27、Browser E2E 71/71 passed。GitHub Test `38683023129` / E2E `38683023223` success。後続M15.2/M16でcontractを維持。詳細は[M15 record](m15-managed-tracking-expansion.ja.md) |
| M15.1 | Transform scalability & semantic hardening | M15 | flat alias patternをbatch展開し、nested static subsetを追加。React/compiler/semanticsとstressを検証 | 完了。旧chain benchmark fixtureは誤りがあり、そのchain表をM15.2で撤回。詳細は[M15.1 record](m15.1-transform-hardening.ja.md) |
| M15.2 | Benchmark validity & transform stress audit | M15.1 | chain fixtureを修正し、baseline/candidateをfresh processで交互に計測。runtime正確性とCPU profileを確認 | 完了。0/5/20/100/500の正しいfixtureを実行。500 baseline chain/independentは60秒timeout、candidateは全ケースのinitial/deep update pass。profileを根拠に実装変更なし。詳細は[M15.2 record](m15.2-benchmark-validity.ja.md) |
| M16 | Consumer canary & integration audit | M15.2 | packed runtime/pluginを使うconsumer appでAPI組み合わせ、SSR/hydration、Compiler、form、collections、lifecycleを確認。実ブラウザ/Fast Refreshは既存fixtureを再利用 | 完了。M16.1のpacked consumer双方向assertionまで統合。Browser E2E 71/71、Fast Refresh RFSG経路pass、製品不具合なし。M16 Test `38719386261` / E2E `38719386105`、M16.1 Test `38738193370` / E2E `38738193375` success。詳細は[M16 record](m16-consumer-canary.ja.md) |
| M17 | Final API & scope decision | M16.1 | v0.2.1との差、公開API/型、現行制約と既解決事項、機能scope、公開可能性を評価 | 完了。現APIはrelease candidateとしてfreeze可能。v0.3.0に追加すべき製品変更なし。M14〜M16.1で閉じた証拠と後続へ送る性能課題を分類。提案M18はrelease execution checklist。詳細は[M17 decision](m17-api-scope-decision.ja.md) |
| M17.1 | v0.2.1比較レビューと回帰修正 | M17 | v0.2.1との差分をcore/deepSignal、JSX runtime/React、transformの3領域で独立にレビューし、比較実行で確認した回帰と不具合を修正 | 完了。P0回帰3件(managed captureの欠落、opaque値read、Map/Set lookup)とP1不具合4件(group clickの`preventDefault()`、`bindChecked`の`onChange`順序、lookup専用keyのsweep、Iterator helpers)を修正。runtime 627/627、transform 431/431。GitHub Test `38798261165` / E2E `38798261275` success。残る項目とmigration guide未記載事項は[M17.1 record](m17.1-v021-regression-review.ja.md)に分類 |
| M17.2 | managed transformの意味論回帰の解消 | M17.1 | `for...of`の意味論とHook配置の懸念を再現テストで確認して修正し、M17.1の残課題を評価 | 完了。`for...of`はiterator stepごとのcaptureへ変更、Hookを含む式はどの経路でもcaptureしない。部分mount leakとtransform負荷(helper 400呼び出し約5.0秒→0.12秒)を修正し、migration guideにbreaking changeを追記。runtime 628/628、transform 437/437、Fast Refresh 18 pass。詳細は[M17.2 record](m17.2-semantic-regression-closure.ja.md) |
| M17.3 | Iterator captureの網羅 | M17.2 | custom iteratorのgetterで行われるSignal readの追跡漏れを再現・修正し、nativeの`for...of`との一致と性能を確認 | 完了。`next`/`return`のlookupをcapture、resultの`done`/`value`は遅延wrapperでaccess時にcapture。組み込み・reactive collection iteratorはwrapperなし。runtime 630/630、transform 440/440、Fast Refresh 18 pass。custom iteratorの反復は約3.3倍、他は誤差範囲。詳細は[M17.3 record](m17.3-iterator-capture-completeness.ja.md) |
| M17.4 | v0.2.1以降の全変更レビューと指摘の解消 | M17.3 | core、JSX、React、transform、API/docsの5領域を独立にレビューし、再現した指摘を全件修正 | 完了。transformの指数的変換時間(blocker)、TS wrapperでの意味論、無警告stale read、Set合成method、保存性能、cancel後のunmount、型の穴などを修正。CIで全suiteを確認。Fast Refresh harnessは未実行。詳細は[M17.4 record](m17.4-full-review-closure.ja.md) |
| M17.5 | Focused correctness closure | M17.4 | M17.4後に指摘された2件を再現・修正し、Fast Refresh harnessを実行 | 完了。Set methodの早期終了でset-like引数のiteratorを閉じる。`for ({ a } of …)`をcapture。Fast Refresh 18 pass。詳細は[M17.5 record](m17.5-focused-correctness-closure.ja.md) |
| M17.6 | Adversarial differential audit | M17.5 | 自動生成・差分実行・組み合わせ検証で5領域を監査し、再現した不具合を修正 | 完了。26件を再現(13件はv0.2.1からの回帰)し、すべて修正。GitHub Test/E2Eは`97e9841`で成功。詳細は[M17.6 record](m17.6-adversarial-differential-audit.ja.md) |
| M17.6.1 | Focused regression closure | M17.6 | M17.6後に指摘された2件を再現・修正し、Fast Refresh harnessを実行 | 完了。`for...in`をnativeのloopで実行してcapture。組み込みmethod名はreceiverが関数の所有するdataのときだけ除外。Fast Refresh 18 pass。詳細は[M17.6 record](m17.6-adversarial-differential-audit.ja.md) |
| M17.6.2 | Local alias capture check | M17.6.1 | 組み込み名methodの判定で、局所変数の別名経由の追跡漏れを確認 | 完了。18件を再現。receiverの出所(literal、parameter、state、組み込みmethodの結果)を証明できる場合だけ除外する方式に変更。examplesのcapture数は不変。詳細は[M17.6 record](m17.6-adversarial-differential-audit.ja.md) |
| M17.7 | Ownership & call resolution qualification | M17.6.3 | 値の出所とcallee解決の判定規則を差分実行で監査し、同種の漏れの原因となる規則を修正 | 完了。19件(P1 5件、P2 11件、P3 3件。うち3件は今回の置き換えで入った回帰をreviewで発見)を再現し全件修正。callee rootの形による除外を廃止し、parameterのDeepをpropsと要素callbackとmodule内helperに限定。examplesのcapture数は不変、分割代入propsは401→1。CONDITIONAL GO。詳細は[M17.7 record](m17.7-ownership-call-resolution.ja.md) |
| M17.7.1 | Synchronous execution boundary check | M17.7 | Promise executorとasync関数の同期部分の追跡を確認 | 完了。名前付きexecutor(helper経由を含む)と`some(async ...)`の漏れ3件を修正。await後のreadは依存にしないことを確認。capture数は不変。詳細は[M17.7.1 record](m17.7.1-sync-execution-boundary.ja.md) |
| M18 | Feature & Improvement Exploration | M17.7.1 | 現API・既知制約・実アプリ利用・性能記録を見直し、v0.3.0候補と次の実装順を決める | 完了。baseline `4c15349`を固定。runtime製品コード変更なし。For/Index、JSX、transform候補を再評価し、managed diagnosticsを条件付きPoC候補に選定。詳細は[M18 exploration](m18-feature-exploration.ja.md) |
| M18.1 | Independent Vocs documentation site | M18 | 依存管理とbuildが独立したVocsサイトを`website/`に作り、現在のRFSGで動くライブデモで検証 | 完了。英語9ページ、7デモ、`full-static`、GitHub Pagesのbase path。静的previewとdev serverのbrowser smoke、親workspace外での独立installを確認。ライブラリ変更なし。詳細は[M18.1 record](m18.1-vocs-website.ja.md) |
| M18.2 | Website infrastructure & GitHub Actions | M18.1 | 独立Website CI、Actions pin、手動Pages deployment準備、初回表示asset量の確認 | 完了。Pages workflowは手動triggerのみ。browser smoke・basePath・`.nojekyll`を確認。deployは実行しない。詳細は[M18.2 record](m18.2-website-infrastructure.ja.md) |
| M18.3 | Managed diagnostics PoCとレビュー残課題 | M18.2 | structured diagnostic IDとopt-in strict policyの便益・5 bundler一貫性を確認し、webpack/Rspack source-map loader回帰を修正 | 完了。公開診断APIと5 adapterを実装・検証。webpack/Rspackのsource-map付き実buildでstrict診断のerror化を確認。loaderはdiagnosticId付き昇格エラーを再試行せず、その他のmap付き失敗は従来どおりfallback。診断42件とRollup実build smoke、webpack/Rspack実build、typecheck、buildが成功。詳細は[M18.3 diagnostics record](m18.3-diagnostics.ja.md) / [M18.4 record](m18.4-list-rendering.ja.md) |
| M18.4 | List Rendering Improvement | M18.3 | `For`/`Index`の親map・key identity・row trackingを調査し、候補を実装前後の測定とReact契約で評価 | 完了。`Index`直接key付与は初回PoCで改善したが、製品build再測定でmount/single updateに一貫した改善を再現できず不採用。`For`も複数operationの後退から不採用。製品runtime/API変更なし。Rollup diagnostics smokeを補完し、React control-flow/SSR/Concurrent、typecheck/build/size pass。詳細は[M18.4 list rendering](m18.4-list-rendering.ja.md) |
| M18.5 | Documentation & Consumer Dogfooding | M18.4 | 英語ガイドを補完し、既存APIを使う実操作デモをVocs static/React client環境で検証 | 完了。既存9ページを維持して4ガイドを追加。Form binding双方向、For/Index操作とrender数、Deep Signal局所更新、Managed/Hook shared state、control flowをstatic previewのChromiumで確認。typecheck/build/smoke成功。Runtime/API変更なし。詳細は[M18.5 record](m18.5-documentation-dogfooding.ja.md) |
| M18.6 | Reactive Match DX Improvement | M18.5 | SwitchがSignal値を購読してObject.isによるMatch分岐を選び、親renderを避けるAPIを検討・実装 | 完了。Match equals、Falsy/undefined比較、型絞り込み、親renderなしを実装。Control Flow/SSR/Concurrent、React Compiler consumer、website Chromium、bundle sizeを確認。詳細は[M18.6 record](m18.6-reactive-match.ja.md) |
| M18.7 | Deep Selector Hook DX | M18.6 | `useDeepSignalValue`のdependenciesを省略可能にし、Signal-only selectorを自然に記述しながらclosure・購読・Reactの正確性を維持 | 完了。省略時の初期closure保持、明示depsとのmode固定、型・SSR/Concurrent/StrictMode・Websiteを検証。詳細は[M18.7 record](m18.7-deep-selector-dx.ja.md) |
| M18.8 | Numeric Form Binding | M18.7 | `input[type="number"]`を`bindValue`で利用可能にし、string Signal、ブラウザ数値入力semantics、SSR/hydrationとReactイベント順を維持 | 完了。focused/runtime/SSR、Chromium/Firefox/WebKit、Website standalone install/build/smoke、bundle budgetを確認。GitHub Test/E2E/Website CI成功。詳細は[M18.8 record](m18.8-numeric-form-binding.ja.md) |

M3の調査開始記録は[React tracking audit](./m3-react-tracking-audit.ja.md)、M4の現行Compiler契約とqualificationは[Compiler audit](./m4-compiler-qualification-audit.ja.md)、M7の比較設備と条件は[performance plan](./m7-performance-qualification-plan.ja.md)を参照。

### 依存と並列化

- M1のcore契約確認とM2のcollection設計・prototypeは、変更範囲を分離して並列化できる。ただしM2実装はruntime adapter・batch・cleanupの契約確認後に統合する。
- M3のrender boundary設計はM4に先行する。M3と独立したM5のmode検出・RSC調査、M6のDOM semantics調査、M7のbaseline収集は並行可能。
- 共通API/型を共有する実装は契約レビュー後、別worktree・明示された担当範囲で実施する。並列化対象以外は統合ブランチで進める。
- M8の結果を満たさない場合はfreezeしない。公開tag、npm publish、GitHub Releaseは別途指示がない限り作成しない。実装完了時は`main`へ統合し、`origin/main`へpushしてCIを確認する。

## v0.2.1で維持する基準

- high-levelのsignal APIとReact integrationは自前、low-level graph backendは `alien-signals@3.2.1` を維持する。置換は測定と契約上の必要性を示せた場合だけ検討する。
- cross-copy interop、effect ownership、cleanup、speculative render、現在のReact root/leaf binding契約を回帰基準とする。
- v0.2.1 release qualificationの性能記録は方向性の資料として扱い、単一の小規模値を新しい性能保証にしない。M7で同条件の基準値を再収集する。

## 次の作業案

旧M18 Release Execution Checklistと旧M18公開準備計画は延期した。M18.1で独立Vocsサイトを構築・dogfoodし、M18.2でWebsite CIと手動Pages workflowを整え、M18.3でdiagnosticsとwebpack/Rspack source-map loaderのレビュー残課題を完了した。M18.4では`For`/`Index`の描画候補を比較したが、効果が再現できずruntime変更を採用しなかった。M18.5で実利用ガイドとデモを補完し、M18.6でMatch equalsによるSignal値分岐を実装、M18.7でdeep selector Hookの省略APIを改善し、M18.8で数値inputをstring Signalとしてbindingする対応を進めている。次はConsumer dogfoodingから次の新機能・API/DX・性能改善を選ぶ。M18.5はドキュメントとdogfoodingの完了であり、release freezeや最終scope判断ではない。npm publish、Git tag、GitHub Release、Pages deployはこの計画に含めない。M17.1で未記載とされたbreaking changeはM17.2でmigration guideへ追記済み。M0〜M16.1の調査項目は履歴であり、現在の未完了作業一覧ではない。

詳細は [M0 architecture review](m0-architecture-review.ja.md)、[M2 collection contract](m2-collection-contract.ja.md) を参照。
