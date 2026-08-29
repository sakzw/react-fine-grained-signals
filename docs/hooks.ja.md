# Reactフック

[English](hooks.md) | [日本語](hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignals } from "react-alien-signals";

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

レンダー中にsignalの `.value` を読む各コンポーネントでは、`useSignals()` を最初のフックとして1回、無条件に呼び出してください。引数も戻り値もありません。フック以降の同期的なsignal読み取りが自動収集され、そのいずれかが変わるとコンポーネントが再レンダーされます。

**追跡境界について:** `useSignals()` はbest-effortです。収集ウィンドウが閉じるのは、次の `useSignals()` 呼び出し時、コミット時のlayout effect、または現在の同期実行後のmicrotaskであり、コンポーネントがreturnした時点ではありません。レンダー中にsignalを読むコンポーネントは、すべて自分で `useSignals()` を呼ぶ必要があります。呼んでいない兄弟・子孫コンポーネントの読み取りは、別のコンポーネントの開いたままのウィンドウに帰属してしまうことがあり、その場合、実際に読んだコンポーネントはそのsignalに対して無言で更新されなくなります。厳密な境界が必要な場合は、ビルドプラグインの `transform: "managed"`（既定）を使用してください。詳細は[境界設計の検討docs](design/use-signals-boundary-design.ja.md)を参照してください。

`useSignal` と `useDeepSignal` は、コンポーネントの生存期間中に同じsignalを保持します。生成コストが高いディープ初期値には、`useDeepSignal(() => ({ items: [] }))` のように純粋なファクトリを渡してください。`useSignals()` 後に読んだdeep propertyは個別に追跡されるため、読んでいない隣接propertyの変更では再レンダーしません。`useSignalValue` は小さなリーフを明示的に購読する低レベルAPIとして利用できます。プリミティブなselectorを明示したい場合は `useDeepSignalValue(state, value => value.user.name, [])` を使用します。依存配列は必須で、長さと順序を一定に保ち、selectorが捕捉するsignal以外の値をすべて列挙してください。object、Proxy、functionをselectorが返すと、runtimeで `TypeError` を投げます。selectorはプリミティブなsnapshotを返す必要があります。`useSignalEffect` はコミット後にeffectを開始し、アンマウント時（Strict Modeのリプレイ時を含む）に解除します。依存配列を省略する場合、callbackはsignalだけを読む必要があり、最初のクロージャがコンポーネントの生存期間中保持されます。props、state、その他のsignalではない値を捕捉する場合は、`useSignalEffect(() => { /* signalとpropsを読む */ }, [prop])` のように任意の依存配列へ列挙してください。

`useComputed` には2つのモードがあります。

- 依存配列を省略する場合、getterはsignalだけを読む必要があります。最初のクロージャがコンポーネントの生存期間中保持されるため、props、React state、その他のsignalではない値を捕捉しないでください。
- getterがsignalではない値を捕捉する場合、その値をすべて依存配列に列挙します: `useComputed(() => count.value * step, [step])`。コンポーネントの生存期間中は、どちらか一方のモードを使い続けてください。

関連: [コアプリミティブ](core-primitives.ja.md)、[描画最適化](rendering-optimization.ja.md)。
