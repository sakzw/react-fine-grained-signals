# M0 非破壊の掃除

- 基準: v0.3.0 + `59dc430`
- 方針: 公開APIは変えない。v0.3.1としては公開せず、v0.4.0に含める。

## 実施内容

| 項目 | 内容 |
|---|---|
| `src/core/interop.ts` | 本体から呼ばれずテストからしか呼ばれない7関数を削除: `withInteropGraphCollector`、`withoutInteropGraphCollector`、`publishInteropGraphRead`、`pushInteropRenderScope`、`publishInteropRenderRead`、`withInteropSpeculativeMode`、`withoutInteropSpeculativeMode`。`withInteropRenderCollector`は`withoutInteropRenderCollector`（本体が使用）の実装なので残した |
| `src/core/signal-brand.ts` | 参照ゼロの`LEGACY_SIGNAL_BRAND_V1`を削除 |
| transform `experimentalCapture` | `transform.ts`のオプション宣言と1箇所の分岐を削除。`inspectFunction`の`synchronousBodyOnly`引数は別の呼び出し（`inspectFunction(..., undefined, true)`、5086行付近）が使うので残した |
| `react-compiler-compatibility.md`（英日） | managed出力を`try/finally`と説明していた節を、`useSignalCapture()`＋closure＋`"use no memo"`の現行方式に書き換えた |

削除前の確認: 7関数は`src`内で`interop.ts`自身以外から参照されていないことを`grep`で確認した（参照があったのは`getSharedInteropContext`、`getReadableInterop`、`attachReadableInterop`、`isInteropSpeculative`、`markInteropSpeculativeDeepRead`、`withoutInteropRenderCollector`で、これらは残した）。

## テストの変更

- `tests/interop-internals.test.ts`: 削除した関数を使う3件を削除し、`isInteropSpeculative`と`markInteropSpeculativeDeepRead`の1件に縮めた。
- `tests/cross-copy-smoke.mjs`: `pushInteropRenderScope`と`publishInteropRenderRead`で render scope を検証していたブロックを削除。
- `tests/phase4-duplicate-smoke.mjs`: `withInteropSpeculativeMode`系のブロックを削除。
- 上記2つのfixture（`cross-copy-interop-entry.ts`、`phase4-duplicate-entry.ts`）から、削除した関数のexportを外した。
- transform側: `loadModule`の`experimentalCapture`引数と、`react-concurrent-capture.test.ts`（2件、ファイルごと）を削除した。`react-execution.test.ts`の`experimental per-read capture codegen`（18件）は、オプションなしでもすべて通ったため、`managed per-read capture codegen`に改名して残した（下記のカバレッジの理由）。**M5の棚卸しで挙げられていた`react-concurrent-capture.test.ts`はこの時点で存在しない**。

これらのファイルはM1でさらに削除・置換される。M0では、M1より前に`main`が常に緑であるよう、最小限の編集にとどめた。

## React Compilerの実測（`babel-plugin-react-compiler` 1.0.0、2026-10-25）

managed出力（`useSignalCapture()`＋closure）を、`panicThreshold`を`none`と`all_errors`で試した。

| `reactCompiler` | 出力 | Compilerのevent | throw |
|---|---|---|---|
| `"auto"` | `"use no memo"`あり | `CompileSkip` | なし（両thresholdとも） |
| `"off"` | directiveなし | `CompileSuccess` | なし（両thresholdとも） |

## ゲート

| ゲート | 結果 |
|---|---|
| `pnpm lint` | エラー0（既存のwarningのみ） |
| `pnpm typecheck` | 成功 |
| `vitest run --maxWorkers=2` | 45ファイル、990件（変更前は45ファイル、992件。−2は削除した関数のテスト3件に1件を追加した差） |
| `pnpm test:transform` | 8ファイル、740件（変更前は9ファイル、742件。−1ファイル/−2件は`react-concurrent-capture.test.ts`）。初回に`unplugin.test.ts`のesbuild/webpack 4件と`transform.test.ts`のスタック深さ1件が落ちたが、単独実行と2回の再実行ではすべて通った。負荷時のtimeout・スタック深さに依存する不安定さで、変更前のコードに対する確認は取れていない |
| `pnpm build` | 成功 |
| `pnpm size` | すべて予算内（削除したコードはtree shakingで元々バンドルに入っておらず、サイズの差はない） |
| `pnpm test:consumer` | 成功 |
| 公開型 | `dist/*.d.ts`の内容が変更前と同一 |
| `pnpm test:browser` | 53件成功（chromium、firefox、webkit） |
| `tests/cross-copy-smoke.mjs`、`tests/phase4-duplicate-smoke.mjs` | 成功 |

## CIで見つかった問題

最初のpush（`3ba289b`）でGitHub CIのTestが失敗した。transformの分岐カバレッジが89.89%でしきい値90%を下回ったため（Website CIとE2Eは成功）。実験テスト18件を削除すると、現行コードの分岐（代入先のTS wrapper、tracked aliasを含む代入先、generatorの呼び出し、JSX属性の判定など）の約12本が、そのテストでしかカバーされなくなっていた。
18件は`experimentalCapture`なしでも通るため、削除せず`managed per-read capture codegen`として残した。分岐カバレッジは90.26%になった。ローカルの全ゲートでは`test:coverage`を回していなかったため見逃した。**以降のマイルストーンでは、テストを削除したときに`pnpm test:coverage`も回す。**

修正のpush（`9a68499`）で、Test、E2E、Website CIがすべて成功した。
