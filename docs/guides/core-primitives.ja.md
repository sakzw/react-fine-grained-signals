# コアプリミティブ

[English](./core-primitives.md) | [日本語](./core-primitives.ja.md)

```ts
import { batch, computed, effect, signal, untracked } from "react-fine-grained-signals";

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

## signal

```ts
signal<T>(initialValue: T): Signal<T>
```

書き込み可能なリアクティブ値を作成します。

- `.value` で読み書きします。追跡中のスコープ内で読むと依存として登録されます。
- `.peek()` は依存を登録せずに現在の値を読みます。
- 書き込み時の同値判定には `Object.is` を使うため、等しい値の代入では何も通知されません。

## computed

```ts
computed<T>(getter: () => T): ReadonlySignal<T>
computed<T>(options: { get: () => T; set: (value: T) => void }): Signal<T>
```

遅延評価される読み取り専用の派生値を作成します。`signal` と同じ `.value` と `.peek()` を公開し、getterが読んだ依存が変化したあと、次の読み取り時に再評価されます。

getterとsetterを持つオブジェクトを渡すと、書き込み可能なcomputedを作成します。getterが値の真偽を決め、`.value`への代入はユーザー定義のsetterを呼びます。別のsignalへ値をコピーするものではありません。setterは依存追跡なし、かつbatch内で実行されるため、setter内で別のsignalを読むことはcomputedの依存にならず、複数の書き込みはsetter完了後に購読者へ通知されます。

```ts
const first = signal("John");
const last = signal("Smith");
const fullName = computed({
  get: () => `${first.value} ${last.value}`,
  set: (value) => {
    const [nextFirst = "", ...rest] = value.split(" ");
    first.value = nextFirst;
    last.value = rest.join(" ");
  },
});

fullName.value = "Ada Lovelace";
console.log(fullName.value); // "Ada Lovelace"
```

getterだけの形式は引き続き`ReadonlySignal<T>`で、書き込みが必要なJSX form bindingには使えません。getter/setter形式は書き込み可能な`Signal<T>`を返し、値の型が合えば`bindValue`、`bindChecked`、単一・複数select bindingで使えます。setterとgetterが完全な逆変換でなくてもかまいません。代入後の読み取り値は、setterが変更した状態からgetterが導出した値です。

`Signal<T>`と`ReadonlySignal<T>`は名目的な型です。それぞれ型専用のmarker（JavaScript propertyではありません）を持つため、TypeScriptは、packageが作ったsignalと、任意の`{ value, peek() }`オブジェクトを区別します（`isSignal`もruntimeで後者を拒否します）。`ReadonlySignal<T>`は`T`について共変です。`Signal<T>`は書き込みにも使うため不変で、`Signal<"a" | "b">`を`Signal<string>`が期待される場所には渡せません。runtimeではpackageのprivate signal brandと書き込み可能性を確認します。

### getterが例外を投げた場合

再評価の引き金になった書き込みはそのまま正常に完了します。エラーはキャッシュされ、そのcomputedを次に読み取ったときの `.value` と `.peek()` から再度投げ直されるため、Reactの描画中に `useSignalValue` / `useSignalTracking()` がそのcomputedを読み取った場合はError Boundaryまで届きます。

getterが失敗する前に読んでいた依存であれば、その後の書き込みで次回読み取り時に正しく再評価され、getterが成功する入力に戻ればcomputedは復帰します。一方、getterが例外を投げるより前に到達できず読まれなかった依存は追跡されないため、その依存だけへの書き込みはそれ単独では再評価を引き起こしません。

## effect

```ts
effect(fn: () => void | (() => void)): () => void
```

`fn` を即座に実行し、以降は `fn` が読んだsignalが変化するたびに再実行します。解除関数（disposer）を返します。

- `fn` が返した関数はクリーンアップとして扱われ、次回の実行前と解除時に呼び出されます。
- 投げられた例外は、その実行の引き金になった書き込みへ伝播せず封じ込められます。
- 別のeffect(またはcomputed)の実行中に作られたeffectは、v0.1と同じくその実行元に所有されます。所有元の次回の実行時と解除時に、ネストしたeffectも解除され、そのクリーンアップは所有元自身のクリーンアップより先に走ります。ネストしたeffectを自分で解除しても問題ありません。
- 自分自身のdisposerを呼んだeffectは、同じ実行の中でその後に読んだsignalも含めて、すべての依存から外れます。

### エラーの封じ込め

`effect()` のコールバック（本体または返されたクリーンアップ関数）が例外を投げても、その実行を引き起こした書き込みには伝播しません。runtimeが例外を封じ込めて報告するため、同じflushでキューに入っている他のeffectを取り消しません。失敗したeffectは後の書き込みにも反応し、クリーンアップの失敗も本体の再実行を妨げません。

エラーは握り潰されず、必ず報告されます。`console.error` に `"react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish."` というメッセージが `{ cause: error }` 付きで記録されます。ホストが [`reportError()`](https://developer.mozilla.org/ja/docs/Web/API/Window/reportError) を実装している環境（ブラウザ、Web Worker、Deno、Bun）では、さらに元のエラーがそこへ渡されて `error` イベントとしてdispatchされるため、`window.onerror` や `addEventListener("error")` のハンドラ、テレメトリSDKからは未捕捉エラーとまったく同じように観測できます（実際に未捕捉の例外が発生するわけではありません）。Nodeにはサポート対象のどのバージョンにも `reportError` グローバルが存在しないため、そちらでは `console.error` が報告手段となります。

この封じ込めが対象とするのは、effectの本体やクリーンアップから投げられる*同期的な*例外です。そうした例外が `uncaughtException` を発生させることはないため、それ単独でNodeのサーバーやスクリプト、テストのプロセスを終了させることはありません。一方、`async` なeffect本体は対象外で、rejectされたPromiseはunhandled rejectionとして表面化し、Nodeでは既定で致命的なままです。そのため `await` する処理には独自の `try` / `catch` が必要です。封じ込められた失敗は引き金となった書き込みには届かないので、独自に処理したい場合は実際の失敗箇所、つまりeffectの本体やクリーンアップの内側で対処してください。報告処理自体も完全にガードされています。`console.error` が例外を投げるようにされていても、`reportError` が例外を投げるgetterとして定義されていても、封じ込めたeffectの失敗が再び外へ抜け出すことはありません。

## batch

```ts
batch<T>(fn: () => T): T
```

書き込みをまとめ、コールバックが完了するまでeffectへの通知を遅延させます。コールバックの戻り値をそのまま返します。

## untracked

```ts
untracked<T>(fn: () => T): T
```

依存関係を収集せずにコールバックを実行し、その戻り値を返します。effectやcomputedの内側から、購読せずにsignalを読みたい場合に使います。インストールされた本パッケージの別のcopyによる追跡も抑止するため、自前のcopyを同梱したライブラリからでも、アプリのsignalを追跡なしで読めます。

## deepSignal

```ts
deepSignal<T extends object>(initialValue: T): DeepSignal<T>
```

プレーンオブジェクト、配列、同一realmの標準collectionにプロパティまたはkey単位の追跡を追加します。Proxyはアクセス時に遅延生成されてキャッシュされるため、別名参照や循環参照でも同一性が安定して維持されます。

```ts
import { computed, deepSignal } from "react-fine-grained-signals";

const state = deepSignal({
  user: { profile: { name: "Alice" } },
  items: ["first"],
});
const name = computed(() => state.value.user.profile.name);

state.value.user.profile.name = "Bob";
state.value.items.push("second");
```

- 監視できるのは、`state.value` を経由した代入、削除、標準的な配列操作だけです。
- `state.peek()` は依存関係を収集せず生のルート値を返すため、読み取り専用として扱ってください。
- ルートにはデータプロパティを持つ変更可能なプレーンオブジェクト、配列、または同一realmの標準collectionが必要です。v1では、アクセサプロパティ、プロパティ記述子やプロトタイプの変更、`freeze` / `seal` を拒否します。拡張不可のオブジェクトも、部分的にリアクティブにせず拒否します。
- ネストしたプレーンオブジェクト、配列、`Map`、`Set`、`WeakMap`、`WeakSet`はリアクティブです。クラスインスタンス、関数、`Date`、Promise、既存のsignalは不透明な値として扱います。
- 配列の変更メソッド(`push`、`splice`、`sort` など)は、呼び出し側を変更対象の配列に購読させません。通知されるのは、影響を受けたindex、`length`、keyを読んでいる側だけです。そのため、effect内での `push` によって、そのeffectが以後の `push` のたびに再実行されることはありません。
- keyの列挙や自身のkeyの確認(`Object.keys`、`for...in`、`Object.hasOwn`、`hasOwnProperty.call`)は、値ではなくkeyの有無に依存します。`Object.getOwnPropertyDescriptor(...).value` を通じた値の読み取りは値の読み取りとして追跡されないため、プロパティそのものを読んでください。
- `Object.prototype` から継承したkey(`constructor`、`toString` など)も、辞書的なオブジェクトではリアクティブなままです。読み取りや存在確認は、そのkeyが自身のプロパティになった時点で再実行されます。

### Reactive collections

collectionは既定でリアクティブです。collectionをroot値として渡すこともできます。

```ts
const state = deepSignal(new Map<string, { count: number }>());
state.value.set("item", { count: 1 });
```

Mapの`get`と`has`はkeyごとに別々に追跡されます。`size`、key iteration、entry iterationも別の依存です。Setの`has`、`size`、iterationも別に追跡されます。Weak collectionはkey操作だけを追跡し、列挙、`size`、`clear`はできません。

plain objectや配列であるcollectionのkey、member、valueはrawで保存され、読み出し時にdeep proxyとして返ります。このruntimeが作ったraw keyとproxy keyは同じentryとして扱います。元のcollectionや`.peek()`からcollectionを変更しても通知されません。Weak collectionの初期entryは走査できないため、reactive proxy経由のmethod呼び出し時にkeyを正規化し、戻り値を遅延wrapします。symbol keyの可否はnative runtimeのWeakMap/WeakSet key規則に従います。同一realmの組み込みcollectionのみ対応します。

deep proxyを含むplain object(carrier)をMapのkeyまたはSetのmemberにすると、正規化されたコピーが保存され、entryの同一性は最初に挿入した呼び出し側のobjectで固定されます。その後carrierを変更しても同じentryを指し続け(`set`、`add`、`get`、`has`、`delete`で2つ目のentryは作られません)、保存済みコピーには後の変更は反映されません。entryを削除してから再追加すると新しいコピーが保存されます。すでに存在するkeyや変更のないvalueは再検証されないため、`Map.set(existingKey, value)`がkeyのグラフ全体を走査することはありません。

リアクティブなSetの`union`、`intersection`、`difference`、`symmetricDifference`は、リアクティブでない通常の`Set`を返します。メンバーは他の読み出し経路と同じで、レシーバのメンバーはdeep proxy、引数にしかないメンバーは引数が保持していた同一性のままです(リアクティブなcollectionのメンバーはproxy、通常の`Set`内のobjectはそのまま)。返されたproxyを変更するとstateが更新されますが、返された`Set`自体への追加・削除はstateに影響しません。引数はネイティブの`GetSetRecord`と同じ順序(`size`、`has`、`keys`を各1回)で検証・読み出しされます。

## isSignal

```ts
isSignal(value: unknown): value is ReadonlySignal<unknown>
```

値が `signal`、`computed`、`deepSignal` のいずれかに由来するかを返します。カスタムJSXランタイムと制御フローコンポーネントはこの判定で分岐するため、偽陰性はエラーにならず、リアクティブなバインディングが通常のpropに劣化するという形で現れます。

### packageのcopyは1つだけにする

`react-fine-grained-signals` は1つのcopyだけをinstallしてください。すべてのsignalは `Symbol.for("react-fine-grained-signals.signal.v2")` をキーとする列挙不可のbrandを持ち、各copyは独自のグラフを持つため、signalはそれを作ったcopyからしか読めません。2つ目のcopyが読み込まれている場合（pnpmのhoistingの差異、monorepoのconsumer、ESM/CJSの分裂）、混在は更新されない値を黙って返すのではなくエラーになります。`effect`、`computed`、追跡されるコンポーネントの内側でcopyをまたいで読むと `Multiple copies of react-fine-grained-signals are loaded` をthrowし、`isSignal` も他方のcopyが作ったsignalに対してthrowします。brandは列挙不可なので、`Object.keys`、`JSON.stringify`、オブジェクトのスプレッド、Reactのprop差分には現れません。

重複はinstall側で解消してください。package managerのdedupe（pnpmの `dedupe-peer-dependents`、`npm dedupe`）を実行するか、bundlerが1つのcopyに解決するようにします（ViteとRollupの `resolve.dedupe: ["react-fine-grained-signals"]`、webpackの `resolve.alias`）。

検出には限界があります。`effect`、`computed`、追跡されるコンポーネントの外で別のcopyのsignalを単純に読む場合は、スタックに目印がないためエラーにならず、そのsignalの現在値が返ります。何も更新されませんが、これはリアクティブなコードの外で値を読むのと同じ挙動です。

brandのキーはv0.2の世代を表します。v0.1.xは `react-fine-grained-signals.signal` を使っており、v0.2のsignalを認識しません（逆も同じです）。1つのページでは本パッケージのメジャー系列を1つに揃えてください。

`deepSignal` の状態にbrandを代入すると例外になります。brandが付いた部分木はsignalとして判定され、リアクティブ化されなくなるためです。

関連: [Reactフック](./hooks.ja.md)、[描画最適化](./rendering-optimization.ja.md)。
