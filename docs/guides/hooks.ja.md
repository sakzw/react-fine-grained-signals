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
useSignal<T>(initialValue: T): FormBindableSignal<T>
```

コンポーネントの生存期間中、同じsignalを1つ保持します。

- `initialValue` が使われるのは初回レンダーのみで、以降は同じsignalが返ります。
- レンダー中に `.value` を読むには、そのコンポーネント自身で [`useSignalTracking()`](#usesignaltracking)（またはplugin）が必要です。
- `useSignal()` は書き込み可能な `Signal<T>` の一種である `FormBindableSignal<T>` を返します。汎用フォームコンポーネントへ渡す場合も、この型を保ってください。`Signal<T>` に注釈すると型が広がり、`bindValue` / `bindChecked` が要求するcapabilityが失われます。

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

### pluginを使わずに厳密な境界を作る

`react-fine-grained-signals/runtime` は `useManagedSignals` をexportしています。scope handleを返すため、`try` / `finally` で自分で閉じます。build時のtransformなしにlexical boundaryを作れます。

```tsx
import { useManagedSignals } from "react-fine-grained-signals/runtime";

function Row() {
  const store = useManagedSignals();
  try {
    // signalの読み取り
  } finally {
    store.finish();
  }
}
```

- runtime scopeは `finally` の位置で閉じます。そこで同期的に実行される読み取りなら、同期的に呼び出したhelper内の読み取りも含めて収集できます。
- このlexical scopeは、現在のpluginの `transform: "managed"` 出力と同等ではありません。pluginはtop-levelの `useSignalCapture()` Hookを挿入し、実行箇所が同期的だと静的に証明できるreadだけを個別にcaptureします。helper内だけのreadや動的に選ばれるreadが漏れる場合があるため、既存境界を移行する前にplugin guideを確認してください。

### React Compiler

上のランタイムインポート境界は、bare `useSignalTracking()` のような「無言で凍結する」ハザードにはあたりません。`babel-plugin-react-compiler` 1.0.0で計測したところ、compilerは `catch` のない `try` を下位表現に落とせないためcompileを中断し、functionをそのまま出力します。その結果、`"use no memo"` の有無にかかわらず、コンポーネントは書き込みのたびに更新され続けます。

このdirectiveが効くのはruntimeではなくbuildです。`panicThreshold: "all_errors"` の場合、directiveがなければ同じbail-outがbuildを失敗させ、あればログに記録されるだけで済みます。build pluginは自身のmanaged出力には既定の `reactCompiler: "auto"` でdirectiveを自動的に挿入しますが、手書きのランタイムインポート境界には手を加えません。buildが全errorでpanicする設定なら手書きで付けてください。また、このbail-outはcompilerの制約であって保証ではないため、将来のversionに備える意味でも付けておく価値があります。

詳細は[React Compilerとの互換性の検討docs](../../development/design/react-compiler-compatibility.ja.md)と[境界設計の検討docs](../../development/design/use-signals-boundary-design.ja.md)を参照してください。

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T // deepSignalはコンパイル時に拒否されます
```

1つのsignalを購読し、現在の値を返します。コンポーネント全体の `useSignalTracking()` ウィンドウではなく、名前の付いた購読を1つだけ張りたい場合の低レベルAPIです。

- 追うのはsignalの値の置き換えだけです。ネストした変更では再レンダーされないため、`deepSignal` は型でエラーになります。deepな状態から値を選ぶには [`useDeepSignalValue`](#usedeepsignalvalue) を使ってください。

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

関連: [コアプリミティブ](./core-primitives.ja.md)、[描画最適化](./rendering-optimization.ja.md)。
