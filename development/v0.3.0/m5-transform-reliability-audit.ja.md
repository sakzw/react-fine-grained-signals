# M5 — Transform reliability audit

## 現状（2026-10-13）

後続のM3統合で、`useSignalCapture()` per-read codegenは既定managed modeへ接続済み。したがって下記の「M3確定までは既定modeに接続しない」は当時の計画であり、現在の状態ではない。統合後もM3のexactness gateは未完了なので、M5の検出・diagnostic境界を閉じる必要がある。

module-level `"use server"` skip/warningと既知のJSX callback/destructuring warningは実装済み。adapter unit suiteを含むplugin全体は371 passed / 3 skippedで通過し、その後M4 opt-out testを追加してfocused testも通過した。5 adapter factoryを含むpacked consumer smokeも通過。実Vite/Rollup/Webpack/Rspack/esbuild consumer build全体、各adapter上のRSC directive配送・warning/source-map位置の組み合わせは未検証であり、M5は未完了。

この調査はM3のtracking実装に依存しない。現状のtransform契約と、v0.3.0で安全性を改善する範囲を記録する。ここに書かれた挙動は既存契約の棚卸しであり、新しい保証ではない。

- `mode: "auto"` は型情報を使わず、静的に識別できる名前付きJSX component/custom Hook内のrender-time `.value`（通常memberまたは静的文字列computed）を検出する。signal以外の `.value` も誤検出し得る。
- 動的keyの `signal[key]` と `const { value } = signal` はreadとして検出されない。一方 `const { user } = deep.value` はroot readを検出するが、M3 per-read prototypeではdestructure中のnested property readがcapture外に残り得る。
- 同一module内の一部同期helper/render callbackは追跡できるが、cross-module helper/callback、任意のrender prop、独自callback APIの実行時期は一般には解決できない。`map`等の対応表とasync/event/deferred callback除外を `transform.ts` で管理する。
- `"use client"` / `"use server"` やbundler environment/layerは現在自動判定しない。Server ComponentでHook挿入が起こり得る。現行回避策は`exclude`、`@noSignalTracking`、`mode: "manual"`。
- 診断にはimport/annotation/mixed-use曖昧性に加え、JSX function-valued prop callbackとdestructuring `.value` initializerのsource-located warningを追加した。JSX children callback、cross-module callback、dynamic aliasなどは引き続き一般的には検出できない。
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

`onX`以外のfunction-valued JSX propに渡す静的解決可能なinline/同一module callbackにtracked `.value` readがあれば、`auto` modeでsource-located warningを追加した。destructuring initializer内に`.value` readがある形もwarningにする。いずれも未追跡を自動で解消する診断ではない。JSX children callback、cross-module callback、動的alias、`.value`を持つ通常objectとの誤判定は残るためREADMEに境界を記載する。

これはRSCの一般判定ではない。後続のadapter調査ではwarning locationのunplugin配送、各bundlerで`"use server"` moduleを確実に対象へ届けるかを検証する。

