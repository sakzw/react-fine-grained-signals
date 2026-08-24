# コアプリミティブ

[English](core-primitives.md) | [日本語](core-primitives.ja.md)

```ts
import { batch, computed, effect, signal, untracked } from "react-alien-signals";

const count = signal(0);
const doubled = computed(() => count.value * 2);

const dispose = effect(() => {
  console.log(doubled.value);
});

batch(() => {
  count.value = 1;
  count.value = 2;
});

const current = untracked(() => count.value);
dispose();
```

`signal` は書き込み可能な `Signal<T>` を、`computed` は読み取り専用の `ReadonlySignal<T>` を作成します。どちらも `.value` と `.peek()` を公開します。書き込み時の同値判定には `Object.is` を使用します。effectは解除関数（disposer）を返し、effectが返したクリーンアップ関数は次回の実行前と解除時に呼び出されます。

## ディープシグナル

`deepSignal` はプレーンオブジェクトと配列にプロパティ単位の追跡を追加します。Proxyはアクセス時に遅延生成されてキャッシュされるため、別名参照や循環参照でも同一性が安定して維持されます。

```ts
import { computed, deepSignal } from "react-alien-signals";

const state = deepSignal({
  user: { profile: { name: "Alice" } },
  items: ["first"],
});
const name = computed(() => state.value.user.profile.name);

state.value.user.profile.name = "Bob";
state.value.items.push("second");
```

監視できるのは、`state.value` を経由した代入、削除、標準的な配列操作だけです。`state.peek()` は依存関係を収集せず、生のルート値を返すため、読み取り専用として扱ってください。ルートにはデータプロパティを持つ変更可能なプレーンオブジェクトまたは配列が必要です。v1では、アクセサプロパティ、プロパティ記述子やプロトタイプの変更、`freeze` / `seal` を拒否します。ネストしたプレーンオブジェクトと配列はリアクティブになりますが、クラスインスタンス、関数、`Date`、`Map`、`Set`、Promise、既存のsignalは不透明な値として扱い、`deepSignal` によるProxy化や追跡は行いません。拡張不可のオブジェクトは部分的にリアクティブにせず、拒否します。

`state.value` の reactive plain object / array のProxyから**直接**取得した不透明な `Map` / `Set` だけは、読み取り専用viewとして公開されます。`Signal<T>` との型互換性を保つためTypeScript上の型は通常の可変 `Map` / `Set` のままですが、`set`、`add`、`delete`、`clear` はruntimeで `TypeError` になります。コピーとして新しい `Map` / `Set` を作成して変更し、代わりにその新しいcollectionを代入してください。

このviewの保証は不透明な境界をまたぎません。クラスインスタンス、`Date`、関数、collection entry、アクセサの戻り値、prototypeの状態、private field、closureの状態、`WeakMap` のentry、Promiseの内部状態は、rawかつ非リアクティブな領域です。これらの領域から得た値や、保存後に直接変更された不透明な値は、直接変更に対して保護されません。ユーザーコードを呼ばないため、書き込み時の検証はown data descriptorと `Map` / `Set` のentryだけを調べ、getter / setterは呼び出しません。検査できる値にlibrary Proxyが含まれる書き込みは拒否されますが、それ以外の内部領域は検査できません。

## signalの判定

`isSignal(value)` は、値が `signal`、`computed`、`deepSignal` のいずれかに由来するかを返します。カスタムJSXランタイムと制御フローコンポーネントはこの判定で分岐するため、偽陰性はエラーにならず、リアクティブなバインディングが通常のpropに劣化するという形で現れます。

そのため判定はpackage instanceをまたいで機能する必要があります。すべてのsignalは `Symbol.for("react-alien-signals.signal")` をキーとする列挙不可のbrandを持ち、その値はプロトコルバージョン（現在は `1`）です。`isSignal` は、サポートされたバージョンのbrandを持ち、かつ `peek()` を公開している値を受け入れます。これにより、packageが二重に解決された場合（pnpmのhoistingの差異、monorepoのconsumer、ESM/CJSの分裂）や、realmの境界をまたいだsignalも認識されます。brandは列挙不可なので、`Object.keys`、`JSON.stringify`、オブジェクトのスプレッド、Reactのprop差分には現れません。

これが解決するのは判定だけです。リアクティビティにはさらに `alien-signals` のinstanceが共有されていることが必要で、依存追跡がそのmoduleのglobalな状態に置かれているためです。peer dependencyにしている理由は[パッケージング](../README.ja.md#パッケージング)を参照してください。認識された外部のsignalは値を正しく読み取れますが、更新が伝播するのは下層のリアクティブコアが共有されている間だけです。

`deepSignal` の状態にbrandを代入すると例外になります。brandが付いた部分木はsignalとして判定され、リアクティブ化されなくなるためです。

関連: [Reactフック](hooks.ja.md)、[描画最適化](rendering-optimization.ja.md)。
