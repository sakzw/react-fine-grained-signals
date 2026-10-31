# deep signalを`isSignal`と`SignalInput`に渡したときの型

- 基準: `67fef04`

## 調べたこと

M8で`DeepSignal<T>`/`DeepCollectionSignal<T>`は`Signal<T>`を継承しなくなり、`peek()`は`DeepReadonly<T>`を返す。実行時には`registerSignal`で登録されるので`isSignal`はtrueを返す。型の側を確かめた。

### `isSignal`

- deep signalは`ReadonlySignal<unknown>`に代入できる（`peek(): DeepReadonly<T>`は`unknown`に代入できる。brandは`Omit<ReadonlySignal<T>, "value" | "peek">`で引き継いでいる）。`ReadonlySignal<T>`に代入できないのは、`T`に配列やcollectionがあるときだけ。
- そのため型ガード`value is ReadonlySignal<unknown>`は実行時と食い違わない。`number | DeepSignal<Todo[]>`を絞り込むと、trueの側は`DeepSignal<Todo[]>`のまま（`.value`は`Todo[]`）、falseの側は`number`になる。`unknown`からの絞り込みでは`.value`は`unknown`で、unionにしても`unknown | object`＝`unknown`なので得るものがない。
- **型ガードは変えず**、doc commentとguide（`core-primitives.md`英日）に「deep signalも含む」と書き、型テストで固定した。

### `SignalInput<T>`（`For`/`Index`/`Show`/`Match`）

- 実行時は動いていた。部品は自身のmanaged scopeの中で`each.value`を読み、`length`と各要素を読むので、`push`、`splice`、`length = 0`、要素の書き換え、`deepCollectionSignal`の`Set.add`/`Map.set`/値のproperty変更で、`For`/`Index`だけが再レンダーされる（親は再レンダーされない）。`Show`/`Match`もcallbackが読んだネストしたpropertyの変更で更新される。`each={state.value.items}`も同じ。
- 型は構造的に`ReadonlySignal<readonly T[]>`として通っていたが、`T`が`peek()`から推論され`DeepReadonly<item>`になっていた。行のevent handlerから`item.done = true`や`item.tags.push()`と書くと型エラーになり、`Show`の値を素の型の変数に代入することもできなかった。
- `SignalInput<T>`に`DeepSignal<Extract<T, object>> | DeepCollectionSignal<Extract<T, object>>`を加えた。同じgeneric interfaceへの推論は型引数から直接行われ、`ReadonlySignal`側の構造的な推論（`peek()`）より優先されるので、`T`は`.value`の素の型になる。
- deep signalは`T`について不変（`peek(): DeepReadonly<T>`だけを持つinterfaceでも不変になるので、条件型の`DeepReadonly<T>`がvariance測定で不変と判定されるためと見ている）なので、`DeepSignal<Todo[]>`は`DeepSignal<readonly Todo[] | ReadonlySet<Todo>>`に代入できない。`For`/`Index`/`ForMap`の`each`には、mutableな配列・`readonly`配列・`Set`・`Map`のdeep signalを別に並べた（`DeepArrayInput<T>`、`DeepCollectionSignal<Set<T>>`、`DeepCollectionSignal<Map<K, V>>`）。
- `DeepSignal`自体を共変にする（`DeepReadonly`の書き方を変える）案もあったが、`Signal<T>`をあえて不変にしている設計と関わるので、ここでは変えなかった。

## `useManagedRender`

`Show`、`Switch`、`For`、`Index`が同じ`useManagedSignals()`＋`try`/`finally`を持っていたので、内部のhelper `useManagedRender(render)`にまとめた。scopeはcomponentの先頭で開き、すべてのreturnはcallbackの中、returnの前に`finish()`する、という意味は同じ。

`utils`のsize: 7.12 kB gzip / 6.44 kB br / 24.22 kB raw → 7.11 / 6.42 / 24.19。

## テスト

- 新規: `tests/utils-deep-signal-types.tsx`。deep signalの`For`/`Index`/`Show`/`Match`で`T`が素の型、行からitemへの書き込みが通る、object rootを`For`に・`Set`を`Index`に渡すとエラー、`SignalInput`の推論、`isSignal`の絞り込み。変更前の型ではこのファイルで13件のエラーになることを確認した。
- `tests/control-flow.test.tsx`に「deep signal inputs」を追加（上の実行時の動き）。

## ゲート

lint、fmt:check、typecheck:runtime、vitest（`control-flow`、`ssr`、`use-signals-managed`、`runtime-exports`、`runtime-surface`、`deep-signal`）、`build:runtime`、`check-size.mjs`は通過。
