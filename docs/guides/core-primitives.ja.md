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
```

遅延評価される読み取り専用の派生値を作成します。`signal` と同じ `.value` と `.peek()` を公開し、getterが読んだ依存が変化したあと、次の読み取り時に再評価されます。

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

プレーンオブジェクトと配列にプロパティ単位の追跡を追加します。Proxyはアクセス時に遅延生成されてキャッシュされるため、別名参照や循環参照でも同一性が安定して維持されます。

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
- ルートにはデータプロパティを持つ変更可能なプレーンオブジェクトまたは配列が必要です。v1では、アクセサプロパティ、プロパティ記述子やプロトタイプの変更、`freeze` / `seal` を拒否します。拡張不可のオブジェクトも、部分的にリアクティブにせず拒否します。
- ネストしたプレーンオブジェクトと配列はリアクティブになります。クラスインスタンス、関数、`Date`、`Map`、`Set`、Promise、既存のsignalは不透明な値として扱い、Proxy化や追跡は行いません。
- 配列の変更メソッド(`push`、`splice`、`sort` など)は、呼び出し側を変更対象の配列に購読させません。通知されるのは、影響を受けたindex、`length`、keyを読んでいる側だけです。そのため、effect内での `push` によって、そのeffectが以後の `push` のたびに再実行されることはありません。
- keyの列挙や自身のkeyの確認(`Object.keys`、`for...in`、`Object.hasOwn`、`hasOwnProperty.call`)は、値ではなくkeyの有無に依存します。`Object.getOwnPropertyDescriptor(...).value` を通じた値の読み取りは値の読み取りとして追跡されないため、プロパティそのものを読んでください。
- `Object.prototype` から継承したkey(`constructor`、`toString` など)も、辞書的なオブジェクトではリアクティブなままです。読み取りや存在確認は、そのkeyが自身のプロパティになった時点で再実行されます。

### 不透明な Map と Set

`state.value` の reactive plain object / array のProxyから**直接**取得した不透明な `Map` / `Set` だけは、読み取り専用viewとして公開されます。`Signal<T>` との型互換性を保つためTypeScript上の型は通常の可変 `Map` / `Set` のままですが、`set`、`add`、`delete`、`clear` はruntimeで `TypeError` になります。コピーとして新しい `Map` / `Set` を作成して変更し、代わりにその新しいcollectionを代入してください。

### viewの保証が及ばない範囲

このviewの保証は不透明な境界をまたぎません。クラスインスタンス、`Date`、関数、collection entry、アクセサの戻り値、prototypeの状態、private field、closureの状態、`WeakMap` のentry、Promiseの内部状態は、rawかつ非リアクティブな領域です。これらの領域から得た値や、保存後に直接変更された不透明な値は、直接変更に対して保護されません。ユーザーコードを呼ばないため、書き込み時の検証はown data descriptorと `Map` / `Set` のentryだけを調べ、getter / setterは呼び出しません。検査できる値にlibrary Proxyが含まれる書き込みは拒否されますが、それ以外の内部領域は検査できません。

## isSignal

```ts
isSignal(value: unknown): value is ReadonlySignal<unknown>
```

値が `signal`、`computed`、`deepSignal` のいずれかに由来するかを返します。カスタムJSXランタイムと制御フローコンポーネントはこの判定で分岐するため、偽陰性はエラーにならず、リアクティブなバインディングが通常のpropに劣化するという形で現れます。

### package instanceをまたぐ判定

そのため判定はpackage instanceをまたいで機能する必要があります。すべてのsignalは `Symbol.for("react-fine-grained-signals.signal.v2")` をキーとする列挙不可のbrandを持ち、その値はプロトコルバージョン（現在は `1`）です。`isSignal` は、サポートされたバージョンのbrandを持ち、かつ `peek()` を公開している値を受け入れます。これにより、packageが二重に解決された場合（pnpmのhoistingの差異、monorepoのconsumer、ESM/CJSの分裂）や、realmの境界をまたいだsignalも認識されます。brandは列挙不可なので、`Object.keys`、`JSON.stringify`、オブジェクトのスプレッド、Reactのprop差分には現れません。

このキーはv0.2の世代を表します。v0.1.xは `react-fine-grained-signals.signal` を使っており、そのsignalはv0.2の追跡に参加できません(v0.2のsignalもv0.1.xの追跡には参加できません)。そのため2つの世代は、互いのsignalを意図的に認識しません。混在させると、更新されない値を描画する代わりに、JSXで明示的に失敗します。1つのページでは本パッケージのメジャー系列を1つに揃えてください。詳しくは[移行ガイド](../migration/v0.2.ja.md#v01xとv02の混在)を参照してください。

identityとreactivityは別のcontractを使います。公開signalのshapeを `isSignal()` が認識するための `SIGNAL_BRAND` と、RFSG package copy間でリアクティブなreadを伝えるprivateな `ReadableInteropV1` protocolは別物です。各copyは `alien-signals/system` 上に独自runtimeを持つため、alien-signals moduleの共有は不要です。copyをまたぐbatch呼び出しは1つのatomic transactionにはなりません。詳しくは[パッケージングの検討docs](../../development/design/packaging.ja.md)を参照してください。

`deepSignal` の状態にbrandを代入すると例外になります。brandが付いた部分木はsignalとして判定され、リアクティブ化されなくなるためです。

関連: [Reactフック](./hooks.ja.md)、[描画最適化](./rendering-optimization.ja.md)。
