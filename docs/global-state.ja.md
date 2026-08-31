# グローバルステート

[English](global-state.md) | [日本語](global-state.ja.md)

signalは置いた場所で生きる普通の値なので、グローバルストアにproviderもcontextもselector APIも必要ありません。module scopeでsignalを作り、importするだけです。

```ts
// store.ts
import { deepSignal, signal } from "react-fine-grained-signals";

export const theme = signal<"light" | "dark">("light");
export const board = deepSignal({ filter: "all", tasks: [] as Task[] });
```

```tsx
import { board, theme } from "./store.js";

function FilterBadge() {
  useSignals();
  return <span className={theme.value}>{board.value.filter}</span>;
}
```

`useSignals()` が追跡するのは読み取りであって所有者ではありません。レンダー中の `.value` の読み取りは、そのsignalがどこで作られたかに関係なく、読んだコンポーネント自身の依存になります。module scope、ファクトリ、クロージャ、`useSignal()` のいずれでも挙動は同一で、property単位の追跡もそのまま働きます。上のコンポーネントが再レンダーするのは `filter` が変わったときだけで、タスクのtitleが変わったときではありません。

クライアントだけのアプリではこれで話は終わりで、signalがストアライブラリをそのまま置き換えられる唯一の場面でもあります。以下はすべて、module scopeが状態の置き場所として誤りになるケースの話です。

## サーバーレンダリング

module scopeはリクエスト単位ではなくプロセス単位です。moduleはサーバープロセスで一度だけ評価され、そのプロセスが処理するすべてのリクエストが同じsignalのインスタンスを共有します。このライブラリにリクエストスコープのストアは存在せず、`AsyncLocalStorage` へのバインドもレンダーごとのレジストリもないため、書き込みは単に次に読んだ者から見えます。

- リクエストAのレンダー中（あるいはloader、action、route handler内）の書き込みは、リクエストBからも見えます。別のユーザーのリクエストであっても同じです。
- 並行するリクエストは交錯します。`renderToPipeableStream` はチャンクの間でyieldするため、進行中の2つのレンダーが、どちらも制御していない順序で同じsignalを読み書きします。
- ハイドレーションはまっさらなmoduleから始まります。クライアントのバンドルは `store.ts` を初期値のまま評価し直すため、サーバー側での書き込みはクライアントが再現できないマークアップを生みます。つまりhydration mismatchであり、Reactがそのsubtreeのサーバー側HTMLを破棄することもあります。

開発中はこの3つがいずれも表面化しないことがあります。dev serverは編集のたびにmoduleを無効化して再評価するため、リクエスト間で状態を共有する時間が短くなるからです。本番で顕在化する種類のバグです。

### リークしないもの

購読はリークしません。サーバーレンダーはコミットされないからです。追跡フックのコミット時のlayout effectはサーバーでは `useEffect` にフォールバックし、Reactは `renderToString` や `renderToPipeableStream` の最中にeffectを実行しないため、`commit()` は一度も走らず、サーバー上でsignalが購読されることはありません。サーバーでのレンダー追跡は何も生まない記帳作業であり、リクエスト境界を越えるのは値であってリスナーではありません。

例外はmodule scopeで呼ぶ `effect()` です。これはimport時に、サーバーでも実行され、disposerが呼ばれることもないため、プロセスの寿命が尽きるまで依存を保持し続けます。サーバーで読み込まれるコードにmodule scopeのeffectを置かないか、代わりに `useSignalEffect()` から開始してください。

### リクエストごとのストア

signalそのものではなくファクトリをexportし、リクエストごとに1つ作って配ります。

```ts
export function createTaskStore() {
  const state = deepSignal(seedState());
  const remaining = computed(() => state.value.tasks.filter((task) => !task.done).length);
  return { state, remaining };
}

export function useTaskStore(): TaskStore {
  const storeRef = useRef<TaskStore | undefined>(undefined);
  if (storeRef.current === undefined) storeRef.current = createTaskStore();
  return storeRef.current;
}
```

`useRef` によるこの安定化は `useSignal()` や `useDeepSignal()` が内部で使っているものと同じで、それを複合ストアに適用しただけです。クライアントではマウントごとに1つ、サーバーではレンダーパスごとに1つになり、プロセスごとに1つには決してなりません。あとはReactのcontext（またはrouter自身のcontext）で配り、必要なコンポーネントから読みます。[`examples/react-router/`](../examples/react-router/) はこの形で作られています。[`app/lib/task-store.ts`](../examples/react-router/app/lib/task-store.ts) と、それを `useOutletContext<TaskStore>()` で受け取る各ルートを参照してください。

初期値は決定的でなければなりません。サーバーとクライアントの初回レンダーは同一のマークアップを生む必要があるため、リクエストごとに作るストアであっても `Date.now()`、`Math.random()`、`crypto.randomUUID()` を初期値の生成に使うことはできません。

リクエストごとに書き込まれないのであれば、SSR環境でもmodule scopeのsignalで問題ありません。import時に確定する設定値、feature flagのスナップショット、定数のルックアップテーブルなどです。危険なのはmodule scopeそのものではなく、プロセス寿命の保管場所にリクエスト固有のデータを置くことです。

## module scopeのその他の落とし穴

**Hot module replacement。** `store.ts` が差し替わると初期値のまま新しいsignalが作られるため、保存のたびに状態がリセットされます。さらに悪いことに、差し替えられなかったコンポーネント側のmoduleは古いsignalへの束縛を保持し続け、書き込みが見えなくなります。リセットを受け入れるか、差し替えをまたいでストアを保持する `import.meta.hot.accept` ハンドラを書いてください。

**ストアを別パッケージに置く場合。** リアクティビティには `alien-signals` のインスタンスが共有されていることが必要です。依存追跡がそのmodule自身のグローバルな状態に置かれているためです。ストアのパッケージが自前のコピーを解決してしまうと、読み取りは正しい値を返したまま、更新の伝播だけが黙って止まります。`alien-signals` をpeer dependencyにしているのはこのためです。[パッケージングの検討docs](design/packaging.ja.md)と[コアプリミティブ](core-primitives.ja.md#issignal)を参照してください。workspaceで重複を排除し、グローバルストアが片方では更新されるのにもう片方では更新されない場合は、まず重複を疑ってください。

**テスト。** Vitestがまっさらなmodule registryを与えるのはテスト*ファイル*ごとであってテストごとではないため、module scopeのsignalは同一ファイル内の次の `it()` へ値を持ち越します。`beforeEach` でリセットするか、テストの内側で状態を作ってください。このリポジトリのテストが各 `it()` の中でsignalを作っているのは、まさにこの理由によるものです。

関連: [Reactフック](hooks.ja.md)、[コアプリミティブ](core-primitives.ja.md)、[描画最適化](rendering-optimization.ja.md)。
