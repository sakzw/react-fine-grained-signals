# M5 React peerを`>=19.3`へ

- 基準: M4完了時点（`77fa926`）

## 変更

- `package.json`: `peerDependencies.react`を`>=19.3.0`、devDependencyの`react`/`react-dom`を`^19.3.1`に（npm上の19.3.1は2026-10-14公開で、1日以上経過）。lockfileを更新。このとき`pnpm install`の再解決で、推移依存の`rolldown`が1.2.11 → 1.2.13になった（supply-chain policyは通過）。
- `examples/react-router`と`tests/fixtures/consumer-vite`: React 19.2.8 → 19.3.1、`@types/react(-dom)` → 19.3.0。例のlockfileも更新。
- plugin側（`packages/unplugin-react-fine-grained-signals`）に`react`のpeerはない。
- 要件表記: `README.md`/`README.ja.md`、`website/src/pages/installation.mdx`・`index.mdx`を「React 19.3以降」に更新。

## 回避策とテストの棚卸し

- `grep -rn "Activity" src tests e2e`の結果、`Activity`をimportするのはテストだけで、`src`にはコメント以外の参照はない（`hooks.ts`、`react-adapter.mts`、`runtime/jsx.ts`のコメント）。
- **`useDeepSignalValue`の`getSnapshot`にある「購読がないとき再評価する」処理**（`hooks.ts`）を一時的に外して、19.3.1で試した。`react-deep-signal.test.tsx`の「Activityが表示されたときに古い選択を確定しない」を含む5件が失敗した。この処理は、初回commit前のconcurrent renderの整合性と、Activityによる切断の両方に必要で、#36947の修正では代替できない。**削除しない**（変更は戻した）。
- `react-adapter.mts`のActivity prerender関連（`#lifecycle`）は、React側の不具合の回避ではなく、隠れたツリーがcommit・activateされないことに対するライブラリ側の設計。19.3でも必要なので残した。
- transition関連のテスト（`react-concurrent-commit-consistency.test.tsx`、`core-runtime-audit-concurrent.test.tsx`）は、19.3.1でそのまま通る。期待値の変更は不要。transform側の`react-concurrent-capture.test.ts`はM0で削除済み。
- 19.3でtransitionが個別に描画されるようになった変更（#37290）を前提にしても、既存のtransitionのテストは19.3.1で全件成功しており、期待値は妥当と判断した。

## ゲート

lint、typecheck、runtime vitest（41ファイル・911件）、transform（8ファイル・733件）、`pnpm size`、`test:consumer`、`test:browser`（53件）、website（pack、typecheck、build）は通過。CIはpush後に確認する。
