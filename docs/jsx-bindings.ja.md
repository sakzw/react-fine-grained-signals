# JSXのsignal子要素とhost binding

[English](jsx-bindings.md) | [日本語](jsx-bindings.ja.md)

提供される自動JSXランタイムを使うようにTypeScriptを設定します。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-alien-signals"
  }
}
```

SVGのテキスト内容を含め、ネイティブホスト要素の子としてsignalを使うと、その箇所が局所的なリアクティブリーフになります。signalが変わっても親コンポーネントは再レンダーされず、ランタイムがそのDOMノードだけを更新します。同じランタイムがDOMへ直接バインドできるネイティブHTML propsは次のものだけです。

- `title`、`id`、`className`、`hidden`、`disabled`
- `style`。object全体をbindingします(`style={signal}`)。style object内のper-property signal(例: `style={{ color: signal }}`)はサポートしません
- `input`、`textarea`、`select` の `value`、および `input` の `checked`
- `data-*` 属性と `aria-*` 属性

```tsx
const title = signal("Initial title");
const disabled = signal(false);
const boxStyle = signal({ color: "crimson" });
const newTitle = signal("");

export function Field() {
  return (
    <>
      <button title={title} disabled={disabled} style={boxStyle}>
        {title}
      </button>
      <input value={newTitle} onChange={(e) => { newTitle.value = e.target.value; }} />
    </>
  );
}
```

CSS propertyへbindingした数値は、Reactもunitless扱いする一部のproperty(`opacity`、`zIndex`、`flexGrow` など)を除き、`px` suffixを付けて書き込まれます。`--` で始まるkeyは `setProperty` を通じてCSS custom propertyとして書き込まれます。前回のstyle objectにはあり今回にはないkeyは、値を残さずclearされます。

`value` と `checked` は双方向bindingのため、他のallowlistとは異なる戦略を取ります。JSX runtimeはcontrolled propの代わりに `.peek()` から得た値で `defaultValue`/`defaultChecked` を代入します。Reactはmount時に一度だけそれを適用し、以降の再レンダーでは再適用しません。それ以降はdirect bindingのeffectがDOM propertyを保持し、`onChange` はそのまま残ります。DOMが既にその値を保持している場合は書き込みを省略するため、無関係な再レンダーや `onChange` からの同じ値のechoが編集中の状態を乱すことはありません。`value` にbindingされた*派生*値(例えばユーザーの入力をtrimしたりupper-caseしたりするsignal)は、派生後の文字列が入力と異なる場合、caretが動くことがあります。この部分はここでは解決していません。他の要素の `value`/`checked`(`<li value>`、`<option value>`、`<meter value>` など)は双方向bindingではない単なるwrite-only属性なので、`title`/`disabled` と同じdirect attribute bindingを使います。

これはこのruntimeが提供する最も細かい描画最適化ですが、対応するのはネイティブ要素のsignal子要素と上記の許可済みpropsだけです。Reactコンポーネントのpropsや子要素に渡したsignalはアンラップされません。

## 制約

- 上記の許可リスト外のイベントハンドラ、SVG props、その他のhost propsはdirect bindingされません。
- direct bindingによる書き込みはReactスケジューラの外側で行われる、実験的な最適化です。
- ホストpropをbindingするかどうかは、その要素の生存期間中変えないでください。通常の値とsignalを切り替えるとラッパーの種類が変わり、DOMサブツリーが再マウントされます。
- SSR（サーバーサイドレンダリング）とハイドレーションでは、サーバーとクライアントのsignal初期値を同一にしてください。リクエスト固有のsignalを共有モジュールスコープへ置かず、リクエストごとに作成してください。
- getterが実行時に例外を投げるようになったcomputedをbindingしている場合、そのcycleのDOM書き込みをスキップし、エラーを `console.error` で記録します（書き込みごとではなく、連続する失敗エピソードごとに1回）。エラーメッセージは `"react-alien-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` で、`{ cause: error }` 付きで記録されます。direct bindingはReactのrender cycleをバイパスするため、Error Boundaryはありません。Error Boundaryのセマンティクスが必要な場合は、[`useSignalValue`](hooks.ja.md)を使用してください。
- `value`/`checked`/`style` にはまだ未解決の点が2つあります。現在の状態は[直接バインディングの設計検討docs](design/direct-binding-value-checked-style.ja.md)を参照してください: 派生 `value` のcaret維持と、per-property単位のfine-grainedな `style` 追跡(`style={{ color: signal }}`)です。

関連: [描画最適化](rendering-optimization.ja.md)、[JSX制御フローユーティリティ](control-flow.ja.md)。
