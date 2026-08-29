# JSX制御フローユーティリティ

[English](control-flow.md) | [日本語](control-flow.ja.md)

`react-fine-grained-signals/utils` は、Solidの `Show`、`Switch` / `Match`、`For` に着想を得た小さなReactコンポーネントを提供します。任意のサブパスであり、build pluginも独自JSXランタイムも必要ありません。条件または配列入力にsignalを渡すと、ユーティリティ自身がリアクティブ境界になるため、更新時に親コンポーネントを再レンダーしません。

```tsx
import { signal } from "react-fine-grained-signals";
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";

const signedIn = signal(false);
const showList = signal(true);
const users = signal([{ id: "ada", name: "Ada" }]);
const labels = signal(new Map([["ada", "Ada"]]));

export function Panel() {
  return (
    <>
      <Show when={signedIn} fallback={<p>ログインしてください。</p>}>
        {(value) => <p>ログイン済み: {String(value)}</p>}
      </Show>

      <Switch fallback={<p>不明な画面です。</p>}>
        <Match when={showList}><p>ユーザー一覧</p></Match>
        <Match when={false}><p>表示されません</p></Match>
      </Switch>

      <For each={users} by={(user) => user.id} fallback={<p>ユーザーはいません。</p>}>
        {(user) => <p>{user.name}</p>}
      </For>

      <For each={labels} by={([id]) => id}>
        {([id, label]) => <p>{`${id}: ${label}`}</p>}
      </For>

      <Index each={users}>
        {(user, index) => <p>{`${index}: ${user().name}`}</p>}
      </Index>
    </>
  );
}
```

`Switch` はtruthyな最初の `Match` だけを描画します。`Match` は `Switch` の子としてのみ意味を持ちます。`For` は新しいレンダラではなく、局所的なReactのリスト境界です。配列、`Set`、`Map`（子には `[key, value]` エントリが渡ります）を扱い、安定したReact keyのために必ず `by` を指定します。`by` は純粋で、render中に生成するのではなくitem由来の値を返してください。意図的に位置をidentityにする配列では `Index` を使います。子にはレンダー中に読む `() => item` accessorと数値indexが渡ります。

`deepSignal` は配列を扱うため、配列操作とitem内部の読み取りをリアクティブにできます。一方で `Map` と `Set` は `deepSignal` にとって意図的に不透明です。reactive plain object / arrayから直接得た `Map` / `Set` だけは、`.value` 経由で読み取り専用のruntime viewとして公開されます（TypeScript上の型は可変のままです）。`For` を更新するにはimmutable replacementを使います。つまりコピーを作り、変更してから新しいcollectionをsignalへ代入します（例: `const next = new Map(labels.value); next.set("bea", "Bea"); labels.value = next`）。render中にcollectionを変更しないでください。行コンポーネント内でsignalやdeep item propertyを読む場合は、その行で `useSignals()` を呼ぶかpluginを使い、行自身に購読を持たせてください。

関連: [コアプリミティブ](core-primitives.ja.md)、[Reactフック](hooks.ja.md)。
