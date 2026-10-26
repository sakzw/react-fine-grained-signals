# M3 追跡境界Hookの整理

- 基準: M2完了時点（`e2e57aa`）

## 変更

- `useManagedSignals`と`ManagedSignalsStore`を公開entry（`/internal`）から削除した。利用者向けの境界APIは`useSignalTracking`だけになった（`useSignalCapture`は生成コード専用で`/internal`にある）。
- transformの認識コードから外した: `isNamedUseManagedSignalsImport`の`useManagedSignals`分岐、namespace import経由の判定、`findRuntimeImports`/`addRuntimeImport`の`importedName`型unionの`"useManagedSignals"`。plugin（`unplugin.ts`）のdocコメントも更新。手書きの`useManagedSignals`を含むファイルは、transformから見て境界のない通常の関数として扱われる。
- **ライブラリ内部には残した**: `src/react/use-signals.ts`の`useManagedSignals`と`react-adapter.mts`の`useManagedSignals`は削除していない。`Show`/`Match`/`For`/`Index`（`src/utils.tsx`）が、`try/finally`で閉じる厳密なscopeとして内部で使っているため。どの公開entryからもexportされない。計画の「削除する」は公開APIとして実施した。
- docs: `docs/guides/hooks.md`（英日）の「pluginを使わずに厳密な境界を作る」と「React Compiler」の節を、移行先（plugin、`useSignalValue`/`useComputed`、`useSignalTracking()`）と`"use no memo"`の説明に置き換えた。`rendering-optimization.md`（英日）、`website/src/pages/managed-transform.mdx`の言及も更新。
- 設計メモ: `development/design/use-signals-boundary-design.md`（英日）に、§7（bare APIの縮小）のv0.4での結果を追記。`react-compiler-compatibility.md`（英日）の「手動ランタイムインポート境界」の節は、v0.3時点の計測として履歴に縮めた。

## テスト

- 削除: `react-compiler.test.ts`の手書き境界のテスト6件とfixture、`unplugin.test.ts`の「手書きのuseManagedSignals境界は触らない」1件、`consumer-smoke.mjs`の`.finish(`数の検証と、fixtureの`ManagedBoundary`。`tests/runtime-exports.test.ts`は「`/internal`に`useManagedSignals`がない」ことの検証に変えた。
- 維持: ライブラリ内部のscopeを調べるテスト（`use-signals-managed`など）は`../src/react/use-signals.js`から直接importする形にした。transformの「control:」テスト（手書き境界がhook順序を壊すことを示す対照）は、testのregistryに内部の`useManagedSignals`を足して維持した。
- 例: `examples/react-router/app/components/ActivityRow.tsx`を、`useSignalTracking()`と`"use no memo"`に書き換えた。
- ベンチマーク: `benchmarks/m10-list-bench.mjs`は`dist/internal.js`の`useManagedSignals`に依存しており、**そのままでは動かない**（M0〜M2の時点の履歴ベンチ）。`react-render.mjs`・`react-retained-heap.mjs`は`BENCH_MANAGED_IMPL=try-finally`（v0.2.1のbaseline checkout用）のときだけ使うので、通常は影響しない。いずれもゲートではないため、今回は直していない。

## ゲート

lint、typecheck、runtime vitest（41ファイル・910件）、transform（`react-execution` 317件を含め、timeoutする既知の2テストを除いて通過）、`pnpm size`（変化なし、予算内）、`test:consumer`、`test:browser`（53件）、website（pack、typecheck、build）は通過。完了時のファイル数・件数は変更前と同じ。CIは末尾の「GitHub CI」を参照。

## 追補（v0.4.0の準備後）

- `benchmarks/m10-list-bench.mjs`を、`useManagedSignals`＋`try/finally`から、`useSignalCapture()`＋本体を`store.capture(() => { ... })`で包む形へ移行した（5つのcomponent）。`M10_LIST_SIZES=100`の小さな条件で実行し、動くことを確認した。ゲートではない。
- ライブラリ内部の`useManagedSignals`（`utils.tsx`の`Show`/`Switch`/`For`/`Index`が使用）は、**意図して残す**ことにした。`utils.tsx`を`useSignalCapture`に書き換える案を検討したが、次の理由で見送った。
  1. 削れるコードがほとんどない。`react-adapter.mts`の`useManagedSignals`は数行で、`RenderStore`などの本体は`useSignalCapture`と共有している。
  2. 厳密なscopeには意味がある。`utils`は`children`のrender propも含めて関数本体全体をscopeで包むため、render prop内のreadも、そのcomponentに帰属する。`capture`に移すと本体全体を`capture(() => ...)`で包むことになり、同じ挙動を作るために別の不安定さ（`Switch`のループ内の複数read、`Index`の後から呼ばれるaccessorとの境界）を持ち込む。
  3. 影響するテストが多い（`use-signals-managed`ほか約14箇所）。利用者への影響はなく、公開APIからは既に消えているので、リスクに見合う利益がない。

## GitHub CI

a42757cのpushで、Test、E2E、Website CIがすべて成功した。
