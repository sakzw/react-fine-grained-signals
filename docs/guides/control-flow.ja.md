# JSX制御フローユーティリティ

[English](./control-flow.md) | [日本語](./control-flow.ja.md)

```tsx
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";
```

`react-fine-grained-signals/utils` は、Solidの `Show`、`Switch` / `Match`、`For` に着想を得た小さなReactコンポーネントを提供します。任意のサブパスであり、build pluginも独自JSXランタイムも必要ありません。

以下で `SignalInput<T>` と書かれている入力は `T | ReadonlySignal<T>` です。素の値でもsignalでも渡せます。signalを渡した場合、ユーティリティ自身がリアクティブ境界になるため、更新時に再レンダーされるのはユーティリティであって親コンポーネントではありません。

## Show

```ts
interface ShowProps<T> {
  when: SignalInput<T>;
  fallback?: ReactNode;
  children: ReactNode | ((value: Truthy<T>) => ReactNode);
}
```

`when` がtruthyな間だけchildrenをレンダーします。

```tsx
<Show when={signedIn} fallback={<p>Please sign in.</p>}>
  {(value) => <p>Signed in: {String(value)}</p>}
</Show>
```

- 関数childrenには、`Truthy<T>` 型のtruthyな値が渡されます。`T` から `null`、`undefined`、`false`、`0`、`""`、`0n` が取り除かれるため、`0 | 1 | null` のsignalなら `1` になります。`number` や `string` のような広い型は変わりません。素のnodeを渡した場合はそのままレンダーされます。
- `fallback` の既定値は `null` です。

## Switch と Match

```ts
interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}
```

`Match`は2つの形をoverloadで型付けしています。`when`と`equals`を渡す形（childには、一致したリテラルに絞り込まれた値が渡されます）と、`when`だけの形（childには`Truthy<T>`が渡され、`equals`は渡せません）です。

`Switch` は最初にマッチした `Match` をレンダーします。`equals` を省略した場合、
`when` は従来どおりtruthy判定です。`equals` を指定した場合は `Object.is` で値を比較します。
predicate callbackではなく値比較です。`0`、`false`、`""`、`null`、`undefined`などのfalsy値も
一致対象にできます。

```tsx
<Switch fallback={<p>Unknown view.</p>}>
  <Match when={showList}><p>User list</p></Match>
  <Match when={view} equals="list">{(value) => <p>{value} view</p>}</Match>
  <Match when={view} equals="details"><p>Details</p></Match>
  <Match when={count} equals={0}><p>No items</p></Match>
</Switch>
```

- `Match` に意味があるのは `Switch` の子として置いた場合だけです。単体では何もレンダーしません。
- 一度マッチすると、それ以降の分岐は評価されません。
- `when={view}` のようにsignal自体を渡すと、`Switch` が値を読み取って購読します。
  `when={view.value === "list"}` はJSXを作る親が式を評価するため、親が購読して再レンダーする場合があります。
- `equals={undefined}` は明示的な `Object.is(value, undefined)` 比較です。`equals` を省略した場合とは異なり、
  `undefined` も一致できます。equals分岐のfunction childrenには、`equals` の型に絞られた一致値が渡ります。

## For

```ts
interface ForProps<T> {
  each: SignalInput<readonly T[] | ReadonlySet<T> | null | undefined>;
  fallback?: ReactNode;
  by: (item: T, index: number) => Key;
  children: (item: T, index: number) => ReactNode;
}

interface ForMapProps<K, V> {
  each: SignalInput<ReadonlyMap<K, V> | null | undefined>;
  fallback?: ReactNode;
  by: (entry: readonly [K, V], index: number) => Key;
  children: (entry: readonly [K, V], index: number) => ReactNode;
}
```

itemが安定したidentityを持つリストをレンダーします。新しいレンダラーではなくローカルなReactのlist境界であり、reconciliationは引き続きReactが担当します。

```tsx
<For each={users} by={(user) => user.id} fallback={<p>No users.</p>}>
  {(user) => <p>{user.name}</p>}
</For>

<For each={labels} by={([id]) => id}>
  {([id, label]) => <p>{`${id}: ${label}`}</p>}
</For>
```

- 配列、`Set`、`Map` を受け付けます。`Map` の場合、`by` とchildrenの両方が `[key, value]` のentryを受け取ります。
- `by` は常に必須です。純粋であり、render中に生成するのではなくitemから導出してください。
- collectionが変わると、`For` はすべてのitemについて `by` と `children` を呼び出します。React keyは行のidentityとstateを保ちますが、変更されていない行のcallback実行やReactのreconciliation処理を省略するものではありません。
- 行コンポーネント内でsignalやdeep item propertyを読む場合は、その行で `useSignalTracking()` を呼ぶかpluginを使い、行自身に購読を持たせてください。

## Index

```ts
interface IndexProps<T> {
  each: SignalInput<readonly T[] | null | undefined>;
  fallback?: ReactNode;
  children: (item: () => T, index: number) => ReactNode;
}
```

行のidentityが意図的に位置そのものである配列をレンダーします。そのため `by` は取りません。

```tsx
<Index each={users}>
  {(user, index) => <p>{`${index}: ${user().name}`}</p>}
</Index>
```

- childrenが受け取るのはitem自体ではなく、render時に読むためのaccessor `() => item` です。
- itemが固有のidentityを持つ場合は `For` を使ってください。

## Map と Set の入力

`deepCollectionSignal`は同一realmの`Map`、`Set`、`WeakMap`、`WeakSet`を、ネストしたcollectionも含めて追跡します(`deepSignal`はそれらを追跡しない値として扱います)。`.value`経由で読み書きしてください。生のcollection参照や`.peek()`は通知を迂回します。

`.value`から取得したcollectionの変更はリアクティブで、変更されたkeyやiteration dependencyを読んだconsumerへ通知されます。collectionをその場で更新できます。周囲のstate更新が分かりやすくなる場合はimmutable replacementも使えます。

```ts
const next = new Map(labels.value);
next.set("bea", "Bea");
labels.value = next;
```

render中にcollectionを変更しないでください。

関連: [コアプリミティブ](./core-primitives.ja.md)、[Reactフック](./hooks.ja.md)。
