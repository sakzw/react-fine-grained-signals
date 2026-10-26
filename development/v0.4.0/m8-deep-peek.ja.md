# M8 `deepSignal(...).peek()`の戻り値を深いreadonly型に（D8）

- 基準: M7完了時点（`65f1f00`）

## 変更

- 実行時の挙動は変えない。`peek()`は引き続き生のオブジェクトを返す（`DeepSignalImpl.peek`は無変更）。
- `DeepReadonly<T>`型を追加し、`peek()`の戻り値の型にした（`@ts-expect-error`で固定）。
  - plain objectのpropertyは再帰的に`readonly`、配列・タプルは`readonly`な配列・タプル
  - `Map`→`ReadonlyMap`、`Set`→`ReadonlySet`（値は再帰的に`DeepReadonly`）
  - `WeakMap`/`WeakSet`は`set`/`delete`、`add`/`delete`を除いた型（`Omit`）
  - プリミティブ、`Date`、`RegExp`、`Error`、`Promise`、関数はそのまま
- `DeepSignal<T>`は`Signal<T>`を継承せず、`Omit<Signal<T>, "peek">`＋`peek(): DeepReadonly<T>`の独立したinterfaceにした。型専用のbrandと書き込みmarkerは引き継ぐので、`isSignal`の型ガード、`NotDeepSignal`、JSXのprop型（`ReadonlySignal & NotDeepSignal`）、`useDeepSignalValue`の引数は、今までどおり正しく受け付ける・拒否する（既存の`deep-signal-positions-types.tsx`などが通ることで確認）。
- `DeepReadonly`を`/`（ルート）と`core`からexport。
- docs: `core-primitives.md`（英日）と`website/src/pages/deep-signal.mdx`の`peek()`の説明を「追跡しない読み取り専用のスナップショット。変更は`.value`経由」に更新。

## 型の制約（仕様として記録）

1. **クラスのインスタンスは区別できない。** TypeScriptではplain objectとクラスのインスタンスを区別できないため、`DeepReadonly`はクラスのインスタンスも同じ`readonly`マップに写す。計画は「クラスのインスタンスはそのまま」としているが、型だけでは実現できない。`#private`を持つクラスは、`peek()`の型として元のクラス型に代入できなくなる（`tests/deep-signal-types.ts`の`NominalBox`で確認）。ただし`.value`経由の型（`T`）は変わらず、クラスのインスタンスは従来どおり使える。
2. **plain objectのrootなら、`DeepSignal`は構造的に`ReadonlySignal<T>`へ代入できる。** `readonly`は代入可能性に影響しないため。配列・`Map`・`Set`のrootは代入できない（計画の想定どおり、`DeepReadonly<T>`が`T`に代入できないため）。object rootでは`ReadonlySignal`経由で`peek()`を書けてしまう穴が残るが、`DeepSignal`が`Signal`でなくなったので、`Signal`が要求される場所（`bindValue`など）には渡らない。
3. `DeepSignal<T>`を`Signal<T>`として扱っていたコードは型エラーになる（利用者への影響）。移行ガイドに載せる。

## テスト

- 新規: `tests/deep-signal-peek-types.ts`。`state.peek().count = 1`、`state.peek().items.push(4)`、ネストしたpropertyへの代入と`push`がエラー、`.value`経由は通る。leafの型。`isSignal`の絞り込み。配列rootが`ReadonlySignal`に代入できない。
- 更新: `deep-signal-collections-types.ts`（`peek()`が`ReadonlyMap`、`.set()`/`.add()`/`WeakMap.set`/`WeakSet.add`がエラー、`get`は通る）、`deep-signal-positions-types.tsx`・`deep-signal-types.ts`（`DeepSignal`が`Signal`に代入できないことを`@ts-expect-error`に）。
- 計画の完了条件のうち`collectionState.peek().get(k)`は通るが`.set()`は通らない、はM11で`deepCollectionSignal`ができた後に同じ形で固定する。現状の`deepSignal`はコレクションも追跡するので、今の段階の`Map`/`Set`/`Weak*`の型テストで先に固定した。

## ゲート

lint、typecheck（runtime・transform・examples・website）、runtime vitest（41ファイル・911件、実行時の変更なし）、transform（8ファイル・733件）、`pnpm size`（変化なし）、`test:consumer`、`test:browser`（53件）、website（build）は通過。CIはpush後に確認する。
