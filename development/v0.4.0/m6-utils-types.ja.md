# M6 utilsの型整理（`Show`/`Match`）

- 基準: M5完了時点（`1cab3b0`）

## 変更

- `Truthy<T>`型を追加し（`Exclude<T, null | undefined | false | 0 | "" | 0n>`）、`/utils`からexportした。
- `Show`の関数child、`Match`（`equals`なし）のoverloadと`MatchProps`の`equals`なしの側、`Switch`内のキャストを、`NonNullable<T>`から`Truthy<T>`に変えた。実行時の判定（`!value`）は変えていない。
  - `0 | 1 | 2 | null`のsignalでは`1 | 2`、`boolean`では`true`、`"" | "a" | undefined`では`"a"`になる。`number`や`string`のような広い型は変わらない（一部の値だけがfalsyなため）。
  - `equals`ありの`Match`は`MatchValue<T, E>`のままで、falsyな値も扱える。
- docs: `docs/guides/control-flow.md`（英日）の型の宣言と、`Show`の関数childの説明を更新。

## 計画との食い違い（要確認）

計画は「使われていない`MatchProps`を削除する」としているが、**`MatchProps`は使われている**。

- `Switch`の実装（`match.props as MatchProps<unknown, unknown>`）と`collectMatches`が使っている。
- `docs/guides/control-flow.md`（英日）が公開型として載せ、`tests/utils-types.tsx`が型の検証に使っている（`equals`の値が`T`の外だとエラーになること、など）。
- 計画が指す「`Match`のoverloadが参照していない」は事実だが、型としては`equals`あり／なしの両方の形を表す公開型になっている。コメントの`legacy truthy matching`は`equals`なしの形を指していて、「古いコード」の意味ではない。

そのため**削除せずに残した**。削除する場合は、`Switch`の内部型を別名にし、docsとテストを直す必要がある。メンテナの判断を待つ。

## テスト

`tests/utils-types.tsx`に、`@ts-expect-error`で次を固定した。
- `0 | 1 | 2 | null`で、callbackの値が`1 | 2`（`0`は代入できない）
- `boolean`で`true`
- `Match`（`"" | "a" | undefined`）で`"a"`（`""`は代入できない）
- `number | null`で`number`（`null`は代入できない）
- `Truthy`自体が、falsyなリテラルを持たない

既存の型テストは、そのまま通る。

## ゲート

lint、typecheck、runtime vitest（41ファイル・911件）、transform（`--maxWorkers=2`で8ファイル・733件）、`pnpm size`（変化なし）、`test:consumer`、`test:browser`（53件）、website（pack、typecheck、build）は通過。transformとブラウザは、並行して重い処理が走っていた回に既知の不安定な失敗（esbuild adapter、スタック深さ、ブラウザのcrash）が出たが、単独で再実行すると全件成功した（このマシンでは`bash`のfork失敗も出ており、資源不足が原因と見ている）。CIは末尾の「GitHub CI」を参照。

## 追補: `MatchProps`の扱い（メンテナ判断後、v0.4.0の準備中に実施）

上の食い違いについて、メンテナから「直してよい」と判断があったため、公開型としての`MatchProps`を削除した。

- `src/utils.tsx`: exportされていた`MatchProps`をやめ、`Switch`が`Match`要素から読む内部のinterface（`MatchElementProps`、非export）に置き換えた。`Match`のoverloadは変更なし。
- `tests/utils-types.tsx`: `MatchProps`の型を直接検証していたテスト（`directEqualsProps`など6件）を削除した。`equals`の型制約は、`Match`をJSXで使う既存のテスト（`equals`が`T`の外だとエラーになる、など）が引き続き固定している。
- `docs/guides/control-flow.md`（英日）: `MatchProps`の宣言を、`Match`の2つの形（`equals`あり／なし）の説明に置き換えた。
- 移行ガイド・リリースノート（`docs/migration/v0.4*.md`、`docs/releases/v0.4.0.md`）に、`MatchProps`のexport削除を載せた。

## GitHub CI

0fc2fee（実装）と9e0d53a（README）のpushで、0fc2feeはTest、E2E、Website CIがすべて成功した。9e0d53aはTestとE2Eが成功した（websiteに触れていないのでWebsite CIは走っていない）。
