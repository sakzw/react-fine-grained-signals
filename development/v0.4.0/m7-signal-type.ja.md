# M7 `Signal`型の名目化と`FormBindableSignal`の統合（D7）

- 基準: M6完了時点（`9e0d53a`）

## 変更

- `ReadonlySignal<T>`に型専用のbrand（`declare const readonlySignalBrand: unique symbol`、実行時には存在しない）を付けて名目化した。`T`は共変のまま。
- `Signal<T>`に、書き込み側のmarker（`[signalWriteType]: (value: T) => void`）を移した。`Signal<T>`は不変になり、`Signal<"a" | "b">`を`Signal<string>`に代入できない。
- `FormBindableSignal`は**aliasを残さず削除**した。`bindValue`/`bindChecked`のprop型は`Signal<T>`を受け取る。
- 選択肢型のbinding（radio、select、checkbox group）の内部型`FormBindableChoiceSignal`は、`NarrowableSignal<T>`（`ReadonlySignal<T> & { value: T; [signalWriteType]: (value: never) => void }`）に置き換えた。計画は「prop型を`Signal<U>`（`U extends T`）に総称化する」としていたが、JSXの組み込み要素のprop型は総称にできないため、`value`は共変・書き込みmarkerは`never`を受ける型で同じ意味を表した。リテラルunionのsignalは受け付け、`ReadonlySignal`は拒否する。
- 戻り値の型: `signal()`、`computed({ get, set })`、`useSignal()`、`useWritableComputed()`は`Signal<T>`、`computed(getter)`と`useComputed()`は`ReadonlySignal<T>`。実行時のオブジェクトは変わらず、型の付け替え（`as unknown as`）だけ。
- `DeepSignal<T>`は`Signal<T>`を継承したまま（M8で独立したinterfaceにする）。

## 型だけを先に変えたときのエラー（計画の記録事項）

型を変えた直後の`pnpm typecheck`（runtime、transform、`examples/react-router`、website）のエラーは**8件、すべて`tests/`内**だった。`src/`、transform、examples、websiteはエラー0件（websiteはvendorをpackし直して確認）。数十件を超えないため、停止せずに続けた。

| 種類 | 件数 | 内容 |
|---|---:|---|
| 削除した名前のimport | 3 | `FormBindableSignal`を`tests/jsx-types.tsx`、`react-hooks.test.tsx`、`use-computed-types.ts`がimport |
| 構造的な偽物が`Signal`/`ReadonlySignal`に代入できなくなった | 2 | `{ value, peek }`のオブジェクトリテラル（`jsx-types.tsx`、`react-hooks.test.tsx`の構造的readable） |
| `@ts-expect-error`が不要になった | 3 | 「`Signal<T>`に広げるとbindingが使えない」という旧仕様の期待（`jsx-types.tsx`の2件、`use-computed-types.ts`の1件） |

**利用者への影響**: `FormBindableSignal`のimportを`Signal`に書き換える。`Signal<T>`で注釈した変数は、そのまま`bindValue`に渡せるようになる。`Signal<"a" | "b">`を`Signal<string>`に渡していたコードは型エラーになる（書き込み可能なSignalとしては正しい挙動）。構造的な`{ value, peek }`は`ReadonlySignal`と見なされなくなる（`useSignalValue`のruntime fallbackは残っているが、型では明示的なキャストが要る）。

## テスト

`tests/signal-types.tsx`（新規）に`@ts-expect-error`で次を固定した。
- 構造的な偽物の`{ value, peek }`が`Signal`/`ReadonlySignal`として通らない
- `Signal<"a" | "b">`と`Signal<string>`が互いに代入できない
- `ReadonlySignal`は共変（`ReadonlySignal<"a" | "b">`を`ReadonlySignal<string>`に渡せる）
- `Signal`は`ReadonlySignal`に代入できるが逆は不可
- 各作成関数の戻り値の型
- binding: textはリテラルunionを拒否、radio・select・checkbox groupはリテラルunionを受け付ける、`ReadonlySignal`は拒否

既存の`tests/jsx-types.tsx`は、旧仕様の期待を新仕様（`Signal<T>`注釈でbinding可）に書き換えた。

## docs

`FormBindableSignal`を`Signal`に置き換え、名目型・共変／不変の説明に直した: `docs/guides/core-primitives.md`、`hooks.md`、`jsx-bindings.md`（英日）、`website/src/pages/core-signals.mdx`、`react-hooks.mdx`。

## ゲート

lint、typecheck（runtime・transform・examples・website）、runtime vitest（41ファイル・911件）、transform（`--maxWorkers=2`、8ファイル・733件）、`pnpm size`（変化なし）、`test:consumer`、`test:browser`（53件）、website（build）は通過。CIは末尾の「GitHub CI」を参照。

## GitHub CI

65f1f00のpushで、Test、E2E、Website CIがすべて成功した。
