# M11 `deepSignal`（object/arrayだけ）と`deepCollectionSignal`の分離（D6、D9、D10）

- 基準: M8完了時点（`c281fab`）

## 変更

### API

- `deepSignal(value)`: plain objectと配列だけを追跡する。
  - ルートにMap/Set/WeakMap/WeakSetを渡すと、型エラー（`PlainRoot<T>`が`never`になる）かつ実行時の`TypeError`（`use deepCollectionSignal() for a collection root`）。
  - ネストしたMap/Set/WeakMap/WeakSetは**追跡しない値**（D10）。proxyで包まず、identityを保つ。親プロパティへ別のインスタンスを代入したときだけ通知する。`state.value.tags.add(x)`は通知されない。throwはしない。
- `deepCollectionSignal(value)`（新規）: v0.3の`deepSignal`と同じ挙動。ルートとネストしたMap/Set/WeakMap/WeakSetを追跡する。
- Hook: `useDeepSignal`はobject/arrayだけ（`PlainRoot`で型でも拒否）、`useDeepCollectionSignal`を追加、`useDeepSignalValue`は両方のSignalを受け付ける。
- 型: `DeepCollectionSignal<T>`を`DeepSignal<T>`とは別のinterfaceにした。どちらも`deepSignalBrand`（`NotDeepSignal`で拒否される）を持ち、種類を分ける型専用marker（`plainDeepSignalKind`／`collectionDeepSignalKind`）を持つので、互いに代入できない。

### 内部構造

- **エンジンは1つ**（`createDeepSignalFactory`）。proxyのキャッシュ（`proxyToRaw`、`rawToMetadata`）とmetadataを共有する。
- コレクション対応（`reactiveCollectionProxy`、versionと掃除、`ReactiveCollectionIterator`、`getNativeCollectionKind`など約700行）を`src/core/deep-collections.ts`へ移した。`createCollectionSupport(context)`が、エンジンが渡す`CollectionContext`（`adapter`、`toRaw`、`wrap`、`prepareDeepValue`など）の上に`CollectionSupport`を作る。
- `deepCollectionSignal`は`src/core/deep-collection-signal.ts`にあり、これだけが`deep-collections.ts`をimportする。エンジンは`CollectionSupport`の型を受け取るだけで、コレクションのコードをimportしない。import時の副作用はない（`sideEffects: false`のまま）。
- 「モード」は`CollectionSupport | undefined`で表し、`wrap`・`prepareDeepValue`・`assertDeepDataGraph`・`cloneReactiveGraph`・`matchesNormalizedGraph`・`assertRootValue`に引数として渡す。`PropertyMetadata.support`に、そのobjectを最初にラップしたモードを記録する。
- グラフ検証・コピー・正規化比較のコレクション分岐（約40行）はエンジンに残した。`support`がないときは、MapやSetを`Date`と同じ「中身を覗くだけの不透明な値」として扱い、中に深いproxyが入っていれば従来どおり`cannot store a deep proxy inside an opaque value`で拒否する。

### 同じ生オブジェクトを両方から参照した場合の挙動（計画で「実装時に決めて記録」とされた点）

- **plain objectまたは配列**: `deepSignal`と`deepCollectionSignal`の両方にラップすると`TypeError`（`deepSignal() and deepCollectionSignal() cannot share the same plain object or array`）。片方のproxyをもう片方に代入した場合も、代入時に同じエラーになる。proxyのキャッシュを1つに保つため、モードの混在は許さない。
- **生のMap/Set/WeakMap/WeakSet**: `deepSignal`側では不透明な値（生のまま返る）、`deepCollectionSignal`側ではリアクティブなproxy。同じ生のMapを両方に入れてもエラーにはならない。コレクションproxy経由の変更は`deepCollectionSignal`の読み手だけに通知され、`deepSignal`側はそもそも追跡しない（`tests/deep-signal.test.ts`で固定）。
- 同じ種類のsignal同士（`deepCollectionSignal`が2つなど）は、これまでどおり独立している。

### 型による対策（計画の「追加の推奨」）— 採用しなかった

`deepSignal`の`.value`のgetter型で、ネストしたMap/Setを`ReadonlyMap`/`ReadonlySet`として見せる案を試した。TypeScript 5.1以降のgetter/setter別型で書けるが、次の理由で**採用しない**。

1. `#private`を持つクラスのインスタンスが、写像した型で元のクラスに代入できなくなる（`tests/deep-signal-types.ts`の`NominalBox`）。TypeScriptではクラスのインスタンスとplain objectを区別できない。
2. `unknown`が`{}`に写る、ジェネリックなコード（`useDeepSignalValue`の内部など）で`T | 写像後の型`が`T`に代入できない、といった型エラーが出る。
3. `state.value = { ...state.value, x: 1 }`のような根の置き換えで、読み取り側の型を書き込み側の型`T`に渡せなくなる。

試した時点の型エラーは10件超で、利用側で同じ書き換えを大量に求めることになる。代わりに、(a) docsで「ネストしたcollectionの変更は追跡されず、型は許してしまう」と明記、(b) ルートのcollectionは型で拒否（`PlainRoot`）、(c) 実行時の入口で案内付きエラー、とした。`tests/deep-signal-collections-types.ts`の末尾に、型が許すことを示す行を残してある。

## サイズ（`pnpm size`、gzip）

| scenario | M8まで | 今回 | 差 |
|---|---:|---:|---:|
| deep（`deepSignal`、`useDeepSignal`、`useDeepSignalValue`） | 12.82 kB | 10.10 kB | **−2.72 kB** |
| deep-collections（新設） | — | 13.35 kB | — |
| index-full | 16.17 kB | 16.72 kB | +0.55 kB |
| 他（signal-only、core、core+hooks、jsx-runtime、lite、utils） | — | — | 0〜±0.02 |

試作の見込み（`deep`で約−2.6 kB）に届いた。`deep-collections`は、v0.3の`deep`（12.82 kB）より約0.5 kB大きい。エンジンとコレクション対応の間に差し込み点（`CollectionSupport`、`CollectionContext`）ができたぶんで、コレクションを使う利用者が払うコスト。`index-full`（全exportを読む想定）も同じ理由で増えたが、予算（17.0 kB）には収まっているので**予算は上げていない**。`scripts/size-budget.json`は`deep`を下げ、`deep-collections`を新設した。`scripts/check-size.mjs`には`deep-collections`のscenarioと、`deep`にコレクション用のコードが入っていないことを調べる不在チェック（`DEEP_COLLECTION_MARKER`）を足した。

## テスト

- コレクション関連の既存テストを`deepCollectionSignal`へ移した: `deep-signal-collection-fixes`、`deep-signal-collection-sweep`（エンジン直呼びは`createCollectionSupport`を渡す）、`deep-signal-collections`、`deep-signal-symbol-keys`。`deep-signal.test.ts`のコレクションの3件は新設の`deep-collection-signal.test.ts`へ移動。
- 追加（`deep-signal.test.ts`）: ネストしたMap/Set/WeakMap/WeakSetをproxyで包まない（identity）、中身の変更は通知されない、別インスタンスへの差し替えは通知される、ルートのMap/Set/WeakMap/WeakSetが案内付きでthrow、不透明なMapの中の深いproxyを拒否、モードの混在（plain objectは`TypeError`、proxyの代入も）、生のMapの共有、同種のsignalの独立。
- 型（`deep-signal-collections-types.ts`）: ルートのcollectionを`deepSignal`に渡すと型エラー、2種類のsignalが互いに代入できない、`useDeepSignalValue`が両方を受け付ける。
- benchmark: `collection-sweep.mjs`、`collection-scaling.mjs`、`deep-collections.mjs`を`deepCollectionSignal`に切り替えた。consumer fixture（`labels`、`features`）も同様。

## docs

`docs/guides/core-primitives.md`（英日）に`deepCollectionSignal`の節を新設し、`deepSignal`の説明を「object/arrayだけ、ネストしたcollectionは不透明」に書き換えた。`hooks.md`（英日）に`useDeepCollectionSignal`、`control-flow.md`（英日）、website（`deep-signal.mdx`、`react-hooks.mdx`、`DeepSignalDemo`）を更新。移行ガイドは「v0.3でMap/Setを`deepSignal`に入れていた場合は`deepCollectionSignal`に変える」を、M10で載せる。

## ゲート

lint、typecheck（runtime・transform・examples・website）、runtime vitest（42ファイル・923件）、transform（`--maxWorkers=2`で8ファイル・733件。プラグイン側の`react-execution`のfixtureを`deepCollectionSignal`へ直した）、`pnpm size`、`test:consumer`、`test:browser`（53件）、website（build）は通過。CIはpush後に確認する。
