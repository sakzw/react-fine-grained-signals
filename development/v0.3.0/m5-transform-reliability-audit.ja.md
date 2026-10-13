# M5 — Transform reliability audit

## 現状（2026-10-13）

後続のM3統合で、`useSignalCapture()` per-read codegenは既定managed modeへ接続済み。したがって下記の「M3確定までは既定modeに接続しない」は当時の計画であり、現在の状態ではない。M3はbounded synchronous capture contractの下で完了判定した。M5では引き続き検出・diagnostic境界を閉じる。

module-level `"use server"` skip/warningと、JSX function prop/children callbackおよびdestructuring warningは実装済み。adapter unit suiteを含むplugin全体は399 tests passed。実際のVite、Rollup、Webpack、Rspack、esbuild buildで`"use server"` skip/source warning、`"use client"` transform、source-map sourceを確認した。M5 adapter matrixは完了。

この調査はM3のtracking実装に依存しない。現状のtransform契約と、v0.3.0で安全性を改善する範囲を記録する。ここに書かれた挙動は既存契約の棚卸しであり、新しい保証ではない。

- `mode: "auto"` は型情報を使わず、静的に識別できる名前付きJSX component/custom Hook内のrender-time `.value`（通常member、文字列literal、または不変なlocal string constantのcomputed key）を検出する。signal以外の `.value` も誤検出し得るが、実readでなければdependencyは追加しない。
- 実行時に決まるcomputed keyの `signal[key]` は、componentが別のreadや明示設定ですでに変換対象の場合、そのcapture内で動的に評価される。runtimeは実際のsignal accessorだけをdependencyとして記録し、通常のobject/array accessはdependencyを作らない。動的keyだけでは`auto`はtransformを選ばない。`const { value } = signal` は追跡しない。一方 `const { user } = deep.value` はroot readを検出するが、nested property readがcapture外に残るためsource-located warningを出す。property名`current`/`target`/`currentTarget`だけで内側のsignal readを除外するheuristicは削除した。
- 同一module内の一部同期helper/render callbackを追跡する。既にmanaged変換されるcomponentからの直接named/default import helper callもcaptureするが、signal readしかないimport先依存からは`auto`がcomponent変換を推論できない。import先が返すcallback、任意のrender prop、独自callback APIの実行時期は一般には解決できない。`map`等の対応表とasync/event/deferred callback除外を `transform.ts` で管理する。
- `"use client"` / `"use server"` やbundler environment/layerは現在自動判定しない。Server ComponentでHook挿入が起こり得る。現行回避策は`exclude`、`@noSignalTracking`、`mode: "manual"`。
- 診断にはimport/annotation/mixed-use曖昧性に加え、JSX function-valued prop/children callbackとdestructuring `.value` initializerのsource-located warningを追加した。cross-module callbackやdynamic aliasなどは引き続き一般的には検出できない。
- Vite、Rollup、Webpack、Rspack、esbuild adapterとそれぞれの統合テストがある。Webpack/Rspack loader差し替えはunplugin内部rule形状に依存し、fallback時にwarningを出す。今回、bundler suiteは再実行していない。

## M5の作業順と完了条件

1. **RSC安全性:** 明示directiveと信頼できるbundler metadataで識別できる範囲を決める。`"use client"`がないことだけをServer Componentの証拠にしない。曖昧な場合のdiagnostic/configurationを仕様化する。
2. **read分類:** static/computed key、dynamic key、destructuring、alias、helper境界を検出可能・非対応・誤検出の各分類に分け、`auto`で変換/警告/拒否する境界を定める。M3 per-read codegenは後続変更で既定modeへ統合済み。未解決のreadを静かに見逃さないdiagnostic境界は継続課題。
3. **callback/Hooks安全性:** 認識済みrender callback API、同一moduleの解決範囲、React Hookを含む関数の扱いを列挙し、未知のrender prop/deferred APIを推測でcaptureしない。
4. **診断:** 誤注入より安全側に倒すため、静的に疑わしいread漏れやRSC不整合に対する位置付きwarning/errorの候補を比較する。annotationとmanual modeで明示的に回避できることを確認する。
5. **adapter matrix:** Vite/Rollup/Webpack/Rspack/esbuildの対象拡張子、source map、warning位置、plugin順序、fallbackをsmoke testで確認する。

完了には、変換される/拒否される代表例をsource location付きで固定し、各adapterのwarning・source map・RSC方針を検証する。M3のexact trackingが示されない限りM3の採用判定は別 gate とする。

## 追加変更（2026-10-13）

module-levelの`"use server"`は明示的なserver-action boundaryとして扱う。該当module内をtransform対象から外し、JSXを返す候補関数にはsource location付きwarningを出す。`"use client"`は通常変換する。directiveのないServer Componentはclient/serverの判定材料がなく、引き続き`exclude`/annotation/manualで明示的に除外する。この挙動をtransform regression testと英語/日本語READMEに記録した。

`onX`以外のfunction-valued JSX propまたはJSX childrenに静的解決可能なinline/same-module callbackを渡し、tracked `.value` readがあればsource-located warningを出す。destructuring initializer内に`.value` readがある形もwarningにする。いずれも未追跡を自動で解消する診断ではない。cross-module callback、動的alias、`.value`を持つ通常objectとの誤判定は残るためREADMEに境界を記載する。

これはRSCの一般判定ではない。後続のadapter調査ではwarning locationのunplugin配送、各bundlerで`"use server"` moduleを確実に対象へ届けるかを検証する。

2026-10-13の実Vite gate: `vite-plugin-order.test.ts`で実際の`vite.build()`へ`"use server"`と`"use client"`のentryを渡し、server候補のcapture注入がskipされること、Vite loggerへsource code frame付きwarningが届くこと、client側は変換されること、双方のoutput source mapが元moduleを示すことを確認した。Rolldown自身もmodule-level directiveをbundle中に保持できないwarningを出すため、この確認はtransform段階の振る舞いを示すもので、RSC server runtimeへdirectiveを保持したまま配布する保証ではない。

2026-10-14のadapter matrix: `rollup-rsc.test.ts`と`webpack-rspack-esbuild-rsc.test.ts`は実ビルドを行い、Webpack 5.111.1、Rspack 2.2.8、esbuild 0.28.1でもserver directiveのskip、source-located warning、client transform、出力source mapを確認した。Rollupは4.62.4。新規adapter test 4件と既存Vite order testを含むfocused suiteは12/12 passedし、plugin全suiteは399/399 passed。これらはworkspaceからpluginを使うbuild smokeであり、公開tarballからの最終consumer smokeとは別gate。

