# M18 — Feature & Improvement Exploration

調査日: 2026-10-17

比較基準: `4c15349ce54fad96e73b18dccce13ea9184dca27` (`main`, M17.7.1完了)

目的: v0.3.0候補を利用者価値・保守性・性能・互換性から再評価し、次の実装順を決める。

## 結論

基準HEADと公開APIを維持したまま調査した。M17.7.1までにmanaged transform、JSX direct binding、React Hooks、`For`/`Index`、deepSignal collections、React Compiler、5 bundler entry pointは実装済みであり、これらを未実装機能として提案しない。

いま最も価値がある候補はmanaged transform diagnosticsの利用者向け改善である。ただし現状にもsource位置付きwarningと長いsupport contractがあるため、すぐにpublic APIへ追加する根拠はまだない。M18.1のdogfoodで需要を確認した場合にM18.2でstructured diagnostic IDとopt-in strict policyをPoCし、既存consumerでCI自動化の具体的便益と5 bundler間の一貫性を確認できた場合に限り、v0.3.0へ含める。確認できなければAPI化を延期する。

レンダリング性能では行ごとのmemo化が単一更新を改善するケースを再確認した一方、memory、mount、prepend、moveの負担が残る。測定精度もfeature追加を正当化するには足りず、`For`/`Index`の製品変更は採用しない。deepSignalやJSX bindingも、現状の代替APIで解けない実アプリの要望を特定してから拡張する。

## Freezeした比較基準

| 項目 | 記録 |
|---|---|
| HEAD | `4c15349ce54fad96e73b18dccce13ea9184dca27` — `fix(transform): judge named executors and async callbacks by their body` |
| 基準の由来 | 最初に見えていたローカルmain (`6e943a6`) は古かった。remote mainを更新し、指定SHAがorigin/main先端と確認後、cleanなmainをfast-forwardした。調査開始時の作業ツリーはclean。 |
| version / 公開操作 | package metadataは既存の`0.3.0`。今回version変更、tag、npm publish、GitHub Releaseは行わない。 |
| 実行環境 | Node `v24.21.0`、React `19.3.0`、Vitest `5.0.3`、Windows x64。 |
| 型検査 | `pnpm typecheck`: pass。 |
| runtime build | `pnpm build:runtime`: pass。TypeScript 7 experimental API warningを出すがbuildは完了。 |
| 全testのローカル再実行 | `pnpm test`はworkerを並列起動した時点で23件のworker応答timeoutがあり、472件中471件pass、seeded cross-copy test 1件が既定5秒timeout。全体を直列に再実行したものの、host負荷で長時間にわたり結果が出ず停止した。これを製品不具合とは判定しない。 |
| timeoutしたtestの切り分け | `tests/cross-copy-effects.test.ts`だけを30秒timeoutで実行し、3/3 pass。3 testを含むfileの所要時間は12.31秒。既定5秒を超える実行時間自体はこのhostで再現した。 |
| 基準HEADの直近記録 | [M17.7.1 record](m17.7.1-sync-execution-boundary.ja.md)ではtransform 684件、branch coverage 91.07%、lint/typecheck pass。capture数と生成サイズは直前HEADから不変、変換時間は誤差範囲。これらは保存済み記録で、今回のhostでの再実行結果とは区別する。 |

### 現行公開APIと、すでにある機能

- Core: `signal`、`computed`（read-only / writable）、`effect`、`batch`、`untracked`、`deepSignal`、readable interop。
- React hooks: `useSignal`、`useDeepSignal`、`useComputed`（writable overloadを含む）、`useSignalEffect`、`useSignalValue`、`useDeepSignalValue`、`useSignalTracking`。`runtime` entryは`useSignalCapture` / `useManagedSignals`を提供する。
- React utilities: `Show`、`Switch`、`Match`、`For`、`Index`。utilsは別subpathで、build pluginや独自JSX runtimeを必要としない。
- JSX direct binding: signal children、選択されたnative host propとstyle、明示的な`bindValue`/`bindChecked`、SSR/hydrationとcleanup。React component propsへの透過や任意SVG/event prop bindingは対象外。
- Managed transform: `auto`/`manual`/`all`で対象関数を選び、既定`managed`で静的に特定できる同期readをper-read captureする。`inject`、annotation、source-located warningも既存機能。
- Build integration: Vite、Rollup、Webpack、Rspack、esbuildのentry point。React Compiler ordering/diagnostic、Fast Refresh、SSR、Concurrent/Suspenseの多くは既存qualification済み。
- Collections: 同一realmのplain object/array/Map/Set/WeakMap/WeakSetと標準collection操作をdeepSignalで追跡。raw referenceや`.peek()`経由の更新は通知されない。custom adapter、異realm、任意collection subclassへの一般保証はない。
- 実アプリ例: `examples/react-router` はmanaged transform、collection state、formとJSX binding、SSR/hydrationを組み合わせたconsumer app。`examples/browser`もSSRとbrowserで動く。ドキュメント本体はMarkdownで、独立したinteractive docs siteではない。

### 確認した既知制約と過去の判断

- Managed transformは単一moduleで静的に説明できる同期実行境界を優先する。任意のcross-module helper、JSX render prop/children callback、async処理後のreadを一律に追跡しない。Hookをcapture closureへ移すこともしない。M17.6〜M17.7.1ではcallee/ownership/Promise/async boundaryの漏れが実際に複数見つかり、M17.7.1で修正済み。一般callbackへ広げる案はReactの実行時点とHook ownerを保証できず、過去制約を再評価する根拠にならない。
- Managed modeは既にdestructuring subsetと同期helper/callbackを扱う。残る形式を単に「destructuring未対応」と提案しない。initializerの評価回数、getter順、TDZ、例外を維持できる個別設計が必要。
- `For`の`React.memo` row prototypeはM10で単一更新のcallbackを1件へ減らしたが、10,000件ではmount約63%増、heap約1.94倍、prepend/move/full replacement/unmountも悪化し不採用。`Index`のidentityは位置であり、最新collectionを返すaccessorを維持するため、immutable replacement時の全callback更新は契約上の理由がある。
- `deepSignal` object snapshot prototypeはM11でO(subtree)生成と不安定heapにより見送り。M12のcomputed object-layout最適化もdiscard workloadで改善せず、保持heapの差はばらつき内だった。実測のない内部最適化を再提案しない。
- Component props / React stateをplain dataとみなすこと、暗黙のgetter/toJSON/iterator/Proxy trapを一般追跡しないこと、same-copy内のbatchをatomic boundaryとすることは明示された契約・制約。これらは新設計と反証可能な計測がある場合にのみ再検討する。
- React Compilerではmanaged transformの実行順が必要。Viteでのplugin orderは検証済みだが、他bundler/plugin構成へ順序保証を一般化しない。`inject`はCompilerと組み合わせてbest-effortである。

## 候補と優先順位

評価の読み方: 便益/既存API代替/保守負荷は`高・中・低`。速度やbundleの改善は証拠がある場合だけ記載する。すべてReact 19互換性、Compiler、Fast Refresh、SSRを維持する前提。

| 順 | 候補 | 利用者への便益・既存APIでの代替 | 難易度・保守 | 性能・bundleと互換性 | v0.3.0判断 |
|---:|---|---|---|---|---|
| 1 | Managed transformのstructured diagnosticsと opt-in strict policy | 追跡できないpatternをCIで扱いやすくし、文面parseなしに分類できる。現状のsource-located warning、`useSignalTracking()`、selector Hook、component化が代替になる。 | 中。安定diagnostic IDとseverity policyは新しいplugin API。誤検出・見逃しを分類し、5 bundler adapterで同じ表示を守る必要がある。 | 実行時cost・runtime bundle増はない設計にできる。build failをopt-inに限定すれば既定互換を保ちやすい。Hooks/Compiler/SSR意味論には触れない。 | **PoC優先。条件付き採用。** 既存warning以上の自動化便益をconsumerで確認できれば取り込む。 |
| 2 | 既存React Router appとbrowser exampleのdogfood強化 | 実画面でform/collections/managed reads/SSRを使った時の欠落を発見する。今もexampleがあり、unit testsとconsumer harnessが基礎になる。 | 低〜中。シナリオ追加と手動利用観察が主。独立docs siteをゼロから作ると保守範囲が大きい。 | UI/API利用のみならruntime bundleに影響しない。React 19、Compiler、Fast Refresh、SSRを既存fixture上で確認できる。 | **開発プロセスで採用。** 新しいdocs siteは実ユーザー導線が判明するまで作らない。 |
| 3 | JSX direct binding allowlistの用途別拡張 | signal更新で親renderを避けられるhost propを増やす。React controlled prop、`useSignalValue`、通常のReact handlerが代替。 | 中〜高。DOM property/attribute差、SVG、form ownership、native event順、ref/cleanupを各要素で定義する必要がある。 | leaf updateに有益だがDOM writeはReact scheduler外。大きなallowlistはbundle/検証面と意味論リスクを増やす。SSR/hydration/ref/StrictMode検証が必要。 | **要望の上位例が集まった場合に狭く実装。** 任意propへ一括拡大しない。 |
| 4 | `For`/`Index`の差分描画・row memo化 | 1件の行更新で他row callbackを省略できる可能性。利用者側の行component + row-local trackingが代替。 | 高。key/position identity、Map entry更新、closure/context、cleanup、append/prepend/move semanticsを維持する必要。 | 下記PoCは単一更新で優位だがheapと変形操作の負担が残る。SSR/StrictModeは可能でもConcurrent cleanupとFast Refreshも必要。 | **製品変更なし。** 実アプリのprofileが出るまで保留。 |
| 5 | deepSignal collectionのcustom adapter/cross-realm対応 | branded collection以外を使うアプリのstateを直接追える。現状は標準同一realm collectionかimmutable replacementが代替。 | 高。identity、weak-key、iterator、subclass override、prototype semanticsの契約が増える。 | wrapper/proxy metadataとmemory costが増える可能性。native collection semantics、SSR realm、interop/cross-copyに強い影響。実測と実需要がない。 | **見送り。** concrete consumerと専用contractが出た場合に再評価。 |
| 6 | React Hook / TypeScript surfaceのalias/overload追加 | API名や型推論が好みに合う可能性。現状はHook別API、`FormBindableSignal`、selector、dependency規則をdocsで説明済み。 | 低〜中。alias増加は宣言・サポート・教育コストを継続追加する。 | 通常は実行costなしだが型宣言とentry exportsが増える。React 19 Compiler/Rules of Hooksに影響しない設計は可能。 | **見送り。** 再現可能な型エラーや複数consumerからの要望を先に集める。 |
| 7 | React Compiler / bundler integrationのmatrix更新 | 利用者がplugin順、RSC、source map、Fast Refreshを構成しやすくなる。既存5 adapterとqualification fixtureが代替基礎。 | 中。外部plugin/compilerのversionごとに追従費用がかかる。 | runtime performance/bundleへの影響なし。build compatibility向上に直結し、SSR/RSC/Refreshの境界を守る。 | **各実装候補の必須qualification。** 単独の新機能としては出さない。 |
| 8 | 任意callback、imported helper、dynamic aliasの追跡範囲を一律拡張 | 一部の読取りを自動captureできる。明示Hook、managed annotation、selector Hook、component化で代替可能。 | 非常に高い。module境界、callback timing、React Hook ownerを一般に証明しにくい。 | 不正subscription/stale UI/Hook違反を生み得る。React Compiler、Concurrent、Fast Refresh、SSRすべてに広い検証が必要。 | **見送り。** 個別patternの証明と再現テストがある場合だけM18.xで扱う。 |

## PoC・benchmark

### 現行For/Index計測

既存`benchmarks/m10-list-bench.mjs`を指定HEADからbuildしたruntimeで実行。Node `v24.21.0`、React `19.3.0`、JSDOM、`--expose-gc`、100/1,000 rows、warmup 1、sample 3。host負荷が高くsample分布が広いため傾向確認用。時間は各操作の中央値。mount heapはforced GC前後のprocess差で、allocation rateやretained-heap証明ではない。

実行条件: `M10_LIST_SIZES=100,1000`, `M10_LIST_WARMUPS=1`, `M10_LIST_SAMPLES=3`, `M10_LIST_KINDS=for,index`。candidate比較は`M10_LIST_SIZES=1000`, `M10_LIST_KINDS=for,candidate-for`, `M10_LIST_OPERATIONS=singleUpdate,append,prepend,move,replaceAll`。JSX測定は`node benchmarks/m10-jsx-bench.mjs`の標準設定（5,000 iterations、warmup 1、sample 3）。

| 行数/実装 | mount ms / heap | 単一更新 ms / callback数 | append ms | prepend ms | move ms | 全件置換 ms | unmount ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100 `For` | 59.6 / 0.76 MB | 61.7 / 100 | 52.1 | 128.6 | 102.0 | 60.6 | 20.9 |
| 100 `Index` | 64.1 / 0.68 MB | 44.3 / 100 | 35.1 | 51.1 | 49.7 | 49.0 | 12.1 |
| 1,000 `For` | 531.4 / 6.01 MB | 533.7 / 1,000 | 611.7 | 993.0 | 623.3 | 461.1 | 62.7 |
| 1,000 `Index` | 1,406.5 / 6.00 MB | 1,044.9 / 1,000 | 1,063.0 | 693.4 | 645.3 | 638.7 | 62.6 |

`For`と`Index`はidentity semanticsもchild callback shapeも異なり、直接の代替比較ではない。1,000行`Index`はaccessor経由でcollectionを読み直す負荷が出る。単一machineの中央値で最適化を提案しない。

行ごとのmemo prototype (`candidate-for`)も1,000行、同じwarmup/sample設定で再計測した。

| 実装 | mount ms / heap | 単一更新 ms / callback数 | append ms / callback数 | prepend ms | move ms | 全件置換 ms | unmount ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 製品`For` | 1,255.0 / 6.08 MB | 608.5 / 1,000 | 614.8 / 1,001 | 689.6 | 512.6 | 740.9 | 28.7 |
| `candidate-for` | 1,049.0 / 10.60 MB | 248.2 / 1 | 328.7 / 1 | 930.3 | 726.3 | 827.8 | 65.9 |

単一更新は2.45倍速くcallbackが1件へ減った。mount heapは約74%増、prepend約35%遅、move約42%遅、全件置換約12%遅、unmount約2.3倍。sampleは3回のみで全体に揺れがある。M10の10,000行計測ではcandidate mount +63%、heap約1.94倍で、複数サイズの既存証拠と今回の大容量結果を合わせ、共通`For`への統合はしない。大量の単一行編集が支配的な実アプリに限定した別APIも、利用実態・heap上限・全変形操作の便益が示されるまでは作らない。

### JSX factory overhead

`benchmarks/m10-jsx-bench.mjs`: React 19.3、Node 24.21、5,000 factory call/sample、warmup 1、sample 3。通常propsのReact/RFSG出力同値 assertionはpass。factory-onlyでReact render/DOM updateは含まない。host no-props ratio RFSG/React 1.28、ordinary props 1.19、custom component ordinary props 1.11、multiple children 1.69。各sampleのp25/p75が広く、signal/binding専用caseは約28–148 µs/callに分散した。明確な優劣や実アプリの速度は判定できず、JSX runtime最適化は提案しない。過去M10のfactory計測も数倍の揺れから変更なしとしている。

### Managed transform / runtime / memory

- M17.7.1のcapture/perf比較では、8個のtransform fixtureと全example fileでcapture数と生成サイズに差なし。変換時間は誤差範囲。`auto` example 7 captures、`all` 9 capturesを維持した。
- M14以降のcomputed profile、M15のtransform scalability、M16のDOM retention、M17.3のcustom iterator overheadは対応recordに詳細と再現条件がある。新たなhot pathの連続悪化やretention pathは今回確認できず、runtime micro-optimization候補は追加しない。
- 高精度なPoCを行えなかった候補は診断APIの利用者workflow。M18.1のdogfoodで需要を確認した場合、M18.2でfixtureを作り、既存bundler warningをそのまま使う場合と比較する。製品コードやpublic APIは本調査で変更していない。

## v0.3.0の推奨取り込み

1. **まずdogfoodして課題を記録する。** `examples/react-router`でmanaged tracking、collection、form、JSX bindingの実利用を進め、5 bundlerとCompiler/SSR/Refreshのqualificationも更新する。機能数のために画面を膨らませず、現APIで回避できなかった課題だけを残す。
2. **条件付き第一候補: managed transform diagnosticsのstructured IDとopt-in strict policy。** DogfoodでCI warning policyの具体的需要が確認された場合、既存warningの内容・default severityを保ち、明示指定した場合だけ選んだdiagnostic IDをbuild errorにする。runtimeコード、Hooks、capture semanticsは変えない。PoCで次を満たしたときに限って公開API化する。
   - 現行のsource warningでは足りない具体的consumer workflow（CIで特定classをfail、またはID別集計）が確認できる。
   - warning IDが5 adapterで同じ位置・分類で出る。RSC skip、Hook safety、callback boundaryのfalse positive率もレビューする。
   - default buildを変えず、既存のwarning hook/`onwarn`と共存し、React Compiler ordering・Fast Refresh・SSRのfixtureを維持する。
   - runtime bundle差分は0、transform packageはサイズと変換時間を計測し、重大な負担を加えない。
3. **保留: JSX binding、Hooks/type aliases、collection adapters。** 導入前に最低2つの実アプリ・consumer利用例、現在の回避手段と比べた便益、挙動を定義できるDOM/React/native collection契約を提示する。
4. **見送り: For/Index一般最適化、任意callback自動capture、object snapshot。** 利益が限定的またはcost/semantic riskが実測・既往実装で上回っている。

Clef second opinion (default `clef-flash`) は、structured diagnosticsをすぐ公開するよりdogfoodingとqualificationを先にする案を72%で支持した。これは候補確率であり、判断そのもののconfidenceは低く (`0.1923`)、参考情報として扱う。本書の推奨も、いきなりAPIを採用せず、PoCを通過条件とする。

## 推奨するM18.x実装計画

| Milestone | 内容 | 完了条件 |
|---|---|---|
| M18.0 | この探索記録とroadmapを固定。公開・version操作は行わない。 | 基準SHA・既存API・既往判断・ローカル計測・次のgateを記録。 |
| M18.1 | `examples/react-router`とbrowser exampleをdogfoodし、利用者workflowとAPI上の詰まりを記録。React 19/Compiler/Fast Refresh/SSR/5 bundler matrixも更新する。 | 既存APIの代替で解決できるものと、未解決の具体例を分ける。一般的なfeature requestではなく再現可能な画面・型・build手順を残す。 |
| M18.2 | M18.1で需要が確認された場合だけmanaged diagnostics PoCを行う。stable ID候補、既存source warningとの重複、strict opt-in、consumer CI例を比較する。 | 少なくとも一つ具体的CI便益を実証。false positive/false negativeを表にし、Vite/Rollup/Webpack/Rspack/esbuildでID/loc/severity一致を確認。条件未達ならpublic API化を止める。 |
| M18.3 | PoCで採用条件を満たした候補だけ実装する。条件未達ならruntime/API変更をせず、issueと判断を記録する。 | plugin/API unit、型、React 19と必要なfocused Compiler/Fast Refresh/SSR/bundler testsが通る。runtime bundle不変、transform size/time予算内。 |
| M18.4 | 必要な候補だけを統合し、full review・benchmark・qualificationを実施する。 | 正確性を損なわず、測定可能な便益があり、v0.3.0へ入れるか個別に記録する。公開操作は別判断。 |

## 今回の範囲外

旧M18 Release Execution Checklistは延期する。release readinessの再判定、tag、publish、GitHub Releaseは今回行わない。本探索はM17.7.1の比較基準をfreezeするが、開発を終了・凍結するものではない。
