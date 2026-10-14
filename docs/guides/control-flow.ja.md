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
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
```

`when` がtruthyな間だけchildrenをレンダーします。

```tsx
<Show when={signedIn} fallback={<p>Please sign in.</p>}>
  {(value) => <p>Signed in: {String(value)}</p>}
</Show>
```

- 関数childrenには絞り込まれたtruthyな値が渡されます。素のnodeを渡した場合はそのままレンダーされます。
- `fallback` の既定値は `null` です。

## Switch と Match

```ts
interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}

interface MatchProps<T> {
  when: SignalInput<T>;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
```

`Switch` は、`when` がtruthyな最初の `Match` をレンダーします。

```tsx
<Switch fallback={<p>Unknown view.</p>}>
  <Match when={showList}><p>User list</p></Match>
  <Match when={false}><p>Never rendered</p></Match>
</Switch>
```

- `Match` に意味があるのは `Switch` の子として置いた場合だけです。単体では何もレンダーしません。
- 一度マッチすると、それ以降の分岐は評価されません。

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

`deepSignal`は同一realmの`Map`、`Set`、`WeakMap`、`WeakSet`を既定で追跡し、ネストしたcollectionも対象です。`.value`経由で読み書きしてください。元のcollection参照や`.peek()`経由の変更は通知されません。Mapのkey読み取り、membership、size、iterationは、それぞれ独立したdependencyを使います。Weak collectionはネイティブで可能なkey操作だけを追跡します。

`.value`から取得したcollectionの変更はリアクティブで、変更されたkeyやiteration dependencyを読んだconsumerへ通知されます。collectionをその場で更新できます。周囲のstate更新が分かりやすくなる場合はimmutable replacementも使えます。

```ts
const next = new Map(labels.value);
next.set("bea", "Bea");
labels.value = next;
```

render中にcollectionを変更しないでください。

関連: [コアプリミティブ](./core-primitives.ja.md)、[Reactフック](./hooks.ja.md)。
