# Reactフック

[English](hooks.md) | [日本語](hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignals } from "react-fine-grained-signals";

function Counter({ step }: { step: number }) {
  useSignals();
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
- レンダー中に `.value` を読むには、そのコンポーネント自身で [`useSignals()`](#usesignals)（またはplugin）が必要です。

## useDeepSignal

```ts
useDeepSignal<T extends object>(initialValue: T | (() => T)): DeepSignal<T>
```

property単位で追跡するdeep signalを、コンポーネントの生存期間中1つ保持します。

- 生成コストが高い初期値には、純粋なファクトリを渡してください: `useDeepSignal(() => ({ items: [] }))`。
- [`useSignals()`](#usesignals) 後に読んだpropertyは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。

## useComputed

```ts
useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>
```

安定したidentityを持つcomputed signalを作ります。2つのモードがあり、コンポーネントの生存期間中はどちらか一方を使い続けてください。

- **依存配列を省略する場合**、getterはsignalだけを読む必要があります。最初のクロージャがコンポーネントの生存期間中保持されるため、props、React state、その他のsignalではない値を捕捉しないでください。
- **依存配列を渡す場合**、getterが捕捉するsignal以外の値をすべて列挙します: `useComputed(() => count.value * step, [step])`。

## useSignalEffect

```ts
useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void
```

コミット後にeffectを開始し、アンマウント時（Strict Modeのリプレイ時を含む）に解除します。

- 依存配列を省略する場合、callbackはsignalだけを読む必要があり、最初のクロージャがコンポーネントの生存期間中保持されます。
- props、state、その他のsignalではない値を捕捉する場合は、それらを列挙してください: `useSignalEffect(() => { /* signalとpropsを読む */ }, [prop])`。
- callbackが返した関数はcleanupとして扱われ、次回の実行前と解除時に実行されます。

## useSignals

```ts
useSignals(): void
```

レンダー追跡のウィンドウを開きます。レンダー中にsignalの `.value` を読むコンポーネントでは、最初のフックとして1回、無条件に呼び出してください。

build pluginをbuildに入れている場合、これを手で書く必要はありません。既定の `mode: "auto"` では、`.value` を読むコンポーネントとカスタムフックにplugin自身が境界を挿入します。手で書くのは、pluginを使わずにbuildする場合か、`mode: "manual"` で明示的にopt inさせたい場合です。2つのレイヤーの比較は[描画最適化](rendering-optimization.ja.md)を参照してください。

- 引数も戻り値もありません。
- フック以降の同期的なsignal読み取りが自動収集され、そのいずれかが変わるとコンポーネントが再レンダーされます。
- `deepSignal` ではpropertyごとに個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。
- レンダー中にsignalを読むコンポーネントは、すべて自分で呼ぶ必要があります。親から継承されるウィンドウではありません。
- 境界はbest-effortです。同期的なコンポーネントレンダー以外で頼る前に、[追跡境界](#追跡境界)を読んでください。

### 追跡境界

収集ウィンドウが閉じるのは、次の `useSignals()` 呼び出し時、コミット時のlayout effect、または現在の同期実行後のmicrotaskであり、コンポーネントがreturnした時点ではありません。

読むコンポーネントがすべて自分で呼ぶ必要があるのはこのためです。呼んでいない兄弟・子孫コンポーネントの読み取りは、別のコンポーネントの開いたままのウィンドウに帰属してしまうことがあり、その場合、実際に読んだコンポーネントはそのsignalに対して無言で更新されなくなります。

厳密な境界が必要な場合は、build pluginの `transform: "managed"`（既定）を使用してください。手書きの `try` / `finally` が不要なため、利用できる場合はこれが最もエラーの少ない選択肢です。

### pluginを使わずに厳密な境界を作る

`react-fine-grained-signals/runtime` は、同じ `useSignals` という名前で別の関数をexportしています。こちらはscope handleを返し、自分で閉じます。build時のtransformなしに、pluginのmanaged出力と同じ厳密な境界が得られます。

```tsx
import { useSignals } from "react-fine-grained-signals/runtime";

function Row() {
  const store = useSignals();
  try {
    // signalの読み取り
  } finally {
    store.f();
  }
}
```

- ウィンドウは `finally` が実行される箇所でちょうど閉じます。
- 同じ関数は `useManagedSignals` という名前でもexportされています。呼び出し箇所でmanagedの契約を、曖昧な `useSignals` aliasではなく明示的に示したい場合は、こちらをimportしてください。

### React Compiler

上のランタイムインポート境界は、bare `useSignals()` のような「無言で凍結する」ハザードにはあたりません。`babel-plugin-react-compiler` 1.0.0で計測したところ、compilerは `catch` のない `try` を下位表現に落とせないためcompileを中断し、functionをそのまま出力します。その結果、`"use no memo"` の有無にかかわらず、コンポーネントは書き込みのたびに更新され続けます。

このdirectiveが効くのはruntimeではなくbuildです。`panicThreshold: "all_errors"` の場合、directiveがなければ同じbail-outがbuildを失敗させ、あればログに記録されるだけで済みます。build pluginは自身のmanaged出力には既定の `reactCompiler: "auto"` でdirectiveを自動的に挿入しますが、手書きのランタイムインポート境界には手を加えません。buildが全errorでpanicする設定なら手書きで付けてください。また、このbail-outはcompilerの制約であって保証ではないため、将来のversionに備える意味でも付けておく価値があります。

詳細は[React Compilerとの互換性の検討docs](design/react-compiler-compatibility.ja.md)と[境界設計の検討docs](design/use-signals-boundary-design.ja.md)を参照してください。

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T
```

1つのsignalを購読し、現在の値を返します。コンポーネント全体の `useSignals()` ウィンドウではなく、名前の付いた購読を1つだけ張りたい場合の低レベルAPIです。

## useDeepSignalValue

```ts
useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies: DependencyList,
): S
```

deep signalから導出したプリミティブ1つを購読します。

```tsx
const name = useDeepSignalValue(state, (value) => value.user.name, []);
```

- `dependencies` は必須で、長さと順序を一定に保ち、selectorが捕捉するsignal以外の値をすべて列挙してください。レンダー間で長さが変わると例外を投げます。
- selectorはプリミティブなsnapshotを返す必要があります。object、Proxy、functionを返すと、runtimeで `TypeError` を投げます。

関連: [コアプリミティブ](core-primitives.ja.md)、[描画最適化](rendering-optimization.ja.md)。
