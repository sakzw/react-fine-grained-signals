# Reactフック

[English](./hooks.md) | [日本語](./hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignalTracking } from "react-fine-grained-signals";

function Counter({ step }: { step: number }) {
  useSignalTracking();
  const count = useSignal(0);
  const scaled = useComputed(() => count.value * step, [step]);

  useSignalEffect(() => {
    console.log("count:", count.value);
  });

  return <button onClick={() => (count.value += step)}>{scaled.value}</button>;
}
```

## useSignal

```ts
useSignal<T>(initialValue: T): Signal<T>
```

コンポーネントの生存期間中、同じsignalを1つ保持します。

- `initialValue` が使われるのは初回レンダーのみで、以降は同じsignalが返ります。
- レンダー中に `.value` を読むには、そのコンポーネント自身で [`useSignalTracking()`](#usesignaltracking)（またはplugin）が必要です。
- `useSignal()` は書き込み可能な `Signal<T>` を返し、`bindValue` / `bindChecked` にそのまま渡せます。`Signal<T>` は `T` について不変なので、広い型ではなく正確な値の型で注釈してください。

## useDeepSignal

```ts
useDeepSignal<T extends object>(initialValue: T | (() => T)): DeepSignal<T>
```

property単位で追跡するdeep signalを、コンポーネントの生存期間中1つ保持します。

- 生成コストが高い初期値には、純粋なファクトリを渡してください: `useDeepSignal(() => ({ items: [] }))`。
- [`useSignalTracking()`](#usesignaltracking) 後に読んだpropertyは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。

## useComputed

```ts
useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>
```

依存配列(指定した場合)が変わらない間は同じidentityを保つ、読み取り専用のcomputed signalを作ります。書き込み可能なcomputedには[`useWritableComputed`](#usewritablecomputed)を使います。

- **依存配列を省略することは`[]`を渡すことと同じです。** getterはsignalだけを読む必要があります。通常の再レンダーではcomputed identityが安定するため、props、React state、その他のsignalではない値を捕捉しないでください。
- Fast Refreshは編集後にこのmemoized computedを再生成することがあり、React component stateを保ったまま新しいgetterを反映します。これは開発時の挙動で、本番では通常の再レンダー間でidentityが安定します。
- **signalではない値を捕捉する場合**は列挙します: `useComputed(() => count.value * step, [step])`。
- 依存配列の長さと順序は固定してください。省略(または`[]`)と空でない配列との切り替えを含め、長さが変わると、`useMemo`が置き換えのcomputedを作る前に例外になります。React標準のwarningだけに任せると、古いgetterが残ることがあります。

## useWritableComputed

```ts
useWritableComputed<T>(options: WritableComputedOptions<T>, dependencies?: DependencyList): Signal<T>
```

`{ get, set }`から書き込み可能なcomputed signalを作ります。`Signal<T>`を返すため、型が合う`bindValue`または`bindChecked`に渡せます。依存関係のルールは`useComputed`と同じで、依存配列の省略は`[]`と同じ、`get`と`set`が捕捉するsignal以外の値は列挙します。依存値が変わると、そのrenderで新しいgetterとsetterを持つ別のcomputedを作るため、返るsignalのidentityが変わります。以前のsignalは元のcallbackを保持します。form bindingではgetterが表示値の正本です。setterが入力を拒否または正規化した場合、Reactがユーザーイベントを処理した後にgetterの値へDOMを戻します。

## useSignalEffect

```ts
useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void
```

コミット後にeffectを開始し、アンマウント時（Strict Modeのリプレイ時を含む）に解除します。

- このHookでは依存配列の省略と`[]`は同じ意味です。どちらも初期callbackを保持し、通常のReact renderでは再接続しません。依存配列なしだと毎commit後に実行するReactの`useEffect`とは異なります。この2つの形式は途中で切り替えられます。
- props、state、その他のsignalではない値を捕捉する場合は、それらを列挙してください: `useSignalEffect(() => { /* signalとpropsを読む */ }, [prop])`。同じ位置の依存値が変わると、以前のeffectをcleanupして新しいcallbackで接続し直します。
- 依存配列の長さと順序を固定してください。空配列と非空配列の切り替えを含む長さ変更は、Reactがwarningを出して古いcallbackを保持する前に例外になります。
- callbackが返した関数はcleanupとして扱われ、次回の実行前と解除時に実行されます。

## useSignalTracking

```ts
useSignalTracking(): void
```

レンダー追跡のウィンドウを開きます。レンダー中にsignalの `.value` を読むコンポーネントでは、最初のフックとして1回、無条件に呼び出してください。

build pluginを使う場合、`mode: "auto"` は静的に認識できる `.value` readから対象関数を選択し、managed per-read captureを使います。pluginなしでbuildする場合、`mode: "manual"`を使う場合、または`task.done`のようなdeep-proxy property向けにambient collectionが必要な場合は、このcallを手で書きます。先頭文に直接importしたcallは`transform: "managed"`でも保持されます。2つのレイヤーの比較は[描画最適化](./rendering-optimization.ja.md)を参照してください。

- 引数も戻り値もありません。
- フック以降の同期的なsignal読み取りが自動収集され、そのいずれかが変わるとコンポーネントが再レンダーされます。
- `deepSignal` ではpropertyごとに個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。
- レンダー中にsignalを読むコンポーネントは、すべて自分で呼ぶ必要があります。親から継承されるウィンドウではありません。
- 境界はbest-effortです。同期的なコンポーネントレンダー以外で頼る前に、[追跡境界](#追跡境界)を読んでください。

### 追跡境界

収集ウィンドウが閉じるのは、次の `useSignalTracking()` 呼び出し時、Reactがコミットを始めた時点(layout effectやref callbackが走る前)、または現在の同期実行後のmicrotaskであり、コンポーネントがreturnした時点ではありません。開いたウィンドウの外での読み取りは、そのコンポーネント自身の子孫のlayout effectやrefも含めて、通常のreactiveな読み取りです。

読むコンポーネントがすべて自分で呼ぶ必要があるのはこのためです。呼んでいない兄弟・子孫コンポーネントの読み取りは、別のコンポーネントの開いたままのウィンドウに帰属してしまうことがあり、その場合、実際に読んだコンポーネントはそのsignalに対して無言で更新されなくなります。

build pluginの `transform: "managed"`（既定）は、静的に証明できる同期readを追跡します。top-level capture Hookを置き、readごとにcaptureするため、ユーザーが書いたHookは通常どおりtop-levelに残ります。対応patternとdiagnosticsは[managed tracking契約](../../packages/unplugin-react-fine-grained-signals/README.ja.md#managed-tracking契約)を参照してください。

### `useManagedSignals` からの移行

v0.4で `useManagedSignals` と `ManagedSignalsStore` を削除しました（`react-fine-grained-signals/internal` にはbuild pluginが生成するコードが使うものだけが残ります）。自分で書く追跡境界は `useSignalTracking()` だけです。`useManagedSignals()` のscopeを `try` / `finally` で閉じていた場合は、次のいずれかに移行してください。

- build pluginの `transform: "managed"`（既定）。静的に証明できる同期readをcaptureします。
- leaf hookの `useSignalValue` と `useComputed`。1つのコンポーネントが1つの値を購読します。
- `useSignalTracking()`。上で説明したbest-effortの制約があります。

### React Compiler

buildでReact Compilerを使う場合、bare `useSignalTracking()` には `"use no memo"` が必要です。build pluginは、transformした関数にこのdirectiveを付けます（`reactCompiler: "opt-out"`、既定）。付けないと、compilerがコンポーネントのJSXをcacheして更新が止まります。詳しくは[描画最適化](./rendering-optimization.ja.md)を参照してください。

詳細は[React Compilerとの互換性の検討docs](../../development/design/react-compiler-compatibility.ja.md)と[境界設計の検討docs](../../development/design/use-signals-boundary-design.ja.md)を参照してください。

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T // deepSignalはコンパイル時に拒否されます
```

1つのsignalを購読し、現在の値を返します。コンポーネント全体の `useSignalTracking()` ウィンドウではなく、名前の付いた購読を1つだけ張りたい場合の低レベルAPIです。

- 追うのはsignalの値の置き換えだけです。ネストした変更では再レンダーされないため、`deepSignal` は型でエラーになります。deepな状態から値を選ぶには [`useDeepSignalValue`](#usedeepsignalvalue) を使ってください。
- `source` には本パッケージが作ったsignalかcomputedを渡します。素の `{ value }` オブジェクトなど、それ以外の値を渡すと、レンダー中に `TypeError` をthrowします。

## useDeepCollectionSignal

```ts
useDeepCollectionSignal<T extends object>(initialValue: T | (() => T)): DeepCollectionSignal<T>
```

`Map`、`Set`、`WeakMap`、`WeakSet` も追跡する `useDeepSignal` です([`deepCollectionSignal`](./core-primitives.ja.md#deepcollectionsignal)を参照)。identityとfactoryのルールは `useDeepSignal` と同じです。`useDeepSignal` はcollectionを追跡しないため、`Map` や `Set` をルートにすると拒否されます。

## useDeepSignalValue

```ts
useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies?: DependencyList,
): S
```

deep signalから導出したプリミティブ1つを購読します。

```tsx
const name = useDeepSignalValue(state, (value) => value.user.name);
const label = useDeepSignalValue(
  state,
  (value) => `${prefix}: ${value.user.name}`,
  [prefix],
);
```

- `dependencies` を省略することは `[]` を渡すことと同じで、最初のselector closureを保持します。signalの状態だけを読むselectorに使ってください。props、React state、その他の捕捉値は自動では追跡されません。
- signal以外の捕捉値を使う場合は、`[prefix]` のようにすべて列挙すると、その値の変更時にselectorが更新されます。
- 依存配列は長さと順序を一定に保ってください。省略（または `[]`）と空でない配列との切り替えを含め、レンダー間で長さが変わると例外を投げます。
- selectorはプリミティブなsnapshotを返す必要があります。object、Proxy、functionを返すと、runtimeで `TypeError` になります。mutableな値は安定したsnapshot identityを保証できないためです。

関連: [コアプリミティブ](./core-primitives.ja.md)、[描画最適化](./rendering-optimization.ja.md)。
