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

lint、typecheck、runtime vitest（41ファイル・911件）、transform（`--maxWorkers=2`で8ファイル・733件）、`pnpm size`（変化なし）、`test:consumer`、`test:browser`（53件）、website（pack、typecheck、build）は通過。transformとブラウザは、並行して重い処理が走っていた回に既知の不安定な失敗（esbuild adapter、スタック深さ、ブラウザのcrash）が出たが、単独で再実行すると全件成功した（このマシンでは`bash`のfork失敗も出ており、資源不足が原因と見ている）。CIはpush後に確認する。
