# JSXのsignal子要素とhost binding

[English](./jsx-bindings.md) | [日本語](./jsx-bindings.ja.md)

## セットアップ

このruntimeは明示的に有効化した場合のみ使われます。有効化とは、自動JSX変換の向き先をこのruntimeに変えることで、ファイル単位でもプロジェクト単位でも設定できます。

ファイル単位では、先頭行にpragmaを書きます。他のファイルはReactのJSXランタイムのままになるため、アプリの一部だけで直接バインディングを使いたい場合はこちらが適しています。

```tsx
/** @jsxImportSource react-fine-grained-signals */
```

プロジェクト全体で有効にする場合は `tsconfig.json` に設定します。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals"
  }
}
```

Viteはこの2つを `tsconfig.json` から読むため、`vite.config.ts` 側にJSXの設定は不要です。既定の変換でも `@vitejs/plugin-react` を使う場合でも同じで、[`tests/fixtures/consumer-vite`](../../tests/fixtures/consumer-vite)はこれに依存しています。

一方Babelは `tsconfig.json` を読みません。JSXの変換をBabelに任せるbuild（webpackの `babel-loader` が代表例です）では、preset側でランタイムを指定してください。

```js
// babel.config.js
export default {
  presets: [
    [
      "@babel/preset-react",
      { runtime: "automatic", importSource: "react-fine-grained-signals" },
    ],
  ],
};
```

どちらの場合も2つのentry pointが使われます。productionビルドでは `jsx-runtime`、開発時には `jsx-dev-runtime` で、本パッケージは両方を提供しています。自動runtimeでは表現できない唯一の形 — prop spreadの後に `key` を書く `<div {...props} key="k" />` — では、TypeScript、Babel、Oxcはpackage rootから `createElement` をimportする形にフォールバックします。本パッケージは、同じsignal bindingを持つ `createElement` もrootから提供しています。

どちらの形式でも選択されるruntimeは同じで、pragmaは適用範囲を絞るだけです。[`examples/react-router`](../../examples/react-router)は `tsconfig.json` に `jsx` だけを設定して `jsxImportSource` は置かず、2つのコンポーネントをpragmaで有効化しています。

これはこのruntimeが提供する最も細かい描画最適化ですが、対応するのはネイティブ要素のsignal子要素と、以下に挙げるpropsだけです。Reactコンポーネントのpropsや子要素に渡したsignalはアンラップされません。

## signalの子要素

SVGのテキスト内容を含め、ネイティブホスト要素の子としてsignalを使うと、その箇所が局所的なリアクティブリーフになります。signalが変わっても親コンポーネントは再レンダーされず、ランタイムがそのDOMノードだけを更新します。

```tsx
const title = signal("Initial title");

export function Heading() {
  return <h1>{title}</h1>;
}
```

対象になるのは、Reactが子要素をDOMノードとして描画する通常の子要素の位置です。`<title>`、`<textarea>`、`<style>` など、Reactが子要素を要素ごとの特別な方法で扱うhost要素は対象外です。そこに置いたsignalの子要素は、Reactがテキストを期待する位置でReact要素になるため、Reactが警告を出す、要素が空になる、または `[object Object]` が描画される、のいずれかになります(SSRでも同様です)。これらの要素では、追跡されたコンポーネント内で値を読む(`<title>{title.value}</title>`)か、テキスト入力欄であれば代わりに `value` をbindingしてください。`<option>{signal}</option>` は通常の子要素と同じように動作します。

## bindingできるhost props

同じランタイムがDOMへ直接バインドできるネイティブHTML propsは次のものだけです。

- `title`、`id`、`className`、`hidden`、`disabled`
- `style`。object全体をbindingします(`style={signal}`)。style object内のper-property signal(例: `style={{ color: signal }}`)はサポートしません
- `input`、`textarea`、`select` の `value`、および `input` の `checked`
- `data-*` と `aria-*` 属性

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

## style

CSS propertyへbindingした数値は、Reactもunitless扱いする一部のproperty(`opacity`、`zIndex`、`flexGrow` など)を除き、`px` suffixを付けて書き込まれます。`--` で始まるkeyは `setProperty` を通じてCSS custom propertyとして書き込まれます。前回のstyle objectにはあり今回にはないkeyは、値を残さずclearされます。要素がレンダーされたときの値からReactが書き込んだkeyを、bindingが付く前にsignalが落とした場合(例えば `<Activity>` やSuspense境界が要素を隠している間)も同様です。

## value と checked

`value` と `checked` は双方向bindingのため、他のallowlistとは異なる戦略を取ります。JSX runtimeはcontrolled propの代わりに `.peek()` から得た値で `defaultValue`/`defaultChecked` を代入します。Reactはmount時に一度だけそれを適用し、以降の再レンダーでは再適用しません。それ以降はdirect bindingのeffectがDOM propertyを保持し、`onChange` はそのまま残ります。DOMが既にその値を保持している場合は書き込みを省略するため、無関係な再レンダーや `onChange` からの同じ値のechoが編集中の状態を乱すことはありません。

- `value` にbindingされた*派生*値(例えばユーザーの入力をtrimしたりupper-caseしたりするsignal)は、派生後の文字列が入力と異なる場合、caretが動くことがあります。この部分はここでは解決していません。
- 他の要素の `value`/`checked`(`<li value>`、`<option value>`、`<meter value>` など)は双方向bindingではない単なるwrite-only属性なので、`title`/`disabled` と同じdirect attribute bindingを使います。
- bindingした `value`/`checked` は、Reactのcontrolled inputのように編集を拒否しません。bindingはsignalに従うだけで、`onChange` もそのまま残るため、`onChange` がsignalへ書き込まないことで編集を拒否しても、ブラウザはユーザーが入力した内容を保持します。例えば入力欄は `123a` を表示したままsignalは `123` のまま、あるいはcheckboxはチェックされた表示のままsignalは `false` のまま、となります。入力マスクやvalidationで入力欄を元に戻す必要がある場合は、`onChange` の中で `event.target.value = signal.peek()`(checkboxなら `event.target.checked = signal.peek()`)のように自分で戻してください。signalに変わらない値を書き込んでもbindingは実行されません。あるいは、その入力欄には素の `value`/`checked` を使ったReactのcontrolled inputを使ってください。これは次のform resetの挙動とは別の話です。
- formのresetは要素のdefault(`defaultValue`、`defaultChecked`、optionの `defaultSelected`)に戻します。bindingはsignalへの書き込みを反映するたびにdefaultも書き込んだ値へそろえるため、書き込みの後であれば(`<form action>` の中でも、`onReset` handlerの中でも、それ以外の場所でも)、`form.reset()`、resetボタン、`<form action>` 実行後のReact 19の自動resetはsignalの値に戻します。ただし、ユーザーがfieldを編集した後はこの限りではありません。`onChange` がsignalへ書き込んでいても、change eventに対するReact自身の処理がdefaultをownerが最後にレンダーした値へ戻すため、resetはそのレンダー時の値に戻り、fieldとsignalの値が食い違います。resetで表示する値を決めたい場合は、actionの中や `onReset` など、resetする時点でsignalへ書き込んでください。

## 制約

- allowlistにないevent handler、SVG props、その他のhost propsはdirect bindingされません。
- direct bindingの書き込みはReactのschedulerの外で行われ、実験的な最適化のままです。
- host propはレンダーごとに素の値とsignalを切り替えられます。要素の型は変わらず、子のstateも保たれます。切り替わるのはbindingの付け外しだけです(ただし `value`/`checked` をsignalと素の値で切り替えると、inputはReactのuncontrolled/controlledの間で切り替わり、React標準の警告が出ます)。
- bindingはhost要素自身のrefを通じて付けられます。渡したrefは、Reactが直接呼ぶ場合とまったく同じように要素を受け取ります。refが安定していれば、bindingが変わらない限り再レンダーで呼び直されることはありません。bindingが変わるのは、bindingが別のsignalや素の値に切り替わったときと、bindingしたpropや `style` が前回のレンダーと異なる値でレンダーされたとき(2回のレンダーの間に書き込みがあった場合)です。このときrefは同じcommitの中で一度外れ、再び付けられます。
- `deepSignal` はsignal childやbindingするpropには使えません。これらの位置はrootの置き換えしか追わないため、ネストした変更は表示に反映されません。TypeScriptはこれをエラーにします。deepな状態は追跡されたコンポーネント内で読むか、[`useDeepSignalValue`](./hooks.ja.md#usedeepsignalvalue) でprimitiveを選択してください。
- SSRとhydrationでは、signalの初期値がサーバーとクライアントで一致するようにしてください。リクエスト固有のsignalを共有のmodule scopeへ置かず、リクエストごとに生成してください。
- bindingしたcomputed signalのgetterが例外を投げた場合、そのサイクルのDOM書き込みはスキップされ、`console.error` にエラーが記録されます。記録は書き込みごとではなく、連続した失敗のエピソードごとに1回です。メッセージは `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` で、`{ cause: error }` が付きます。direct bindingはReactのrenderサイクルを経由しないため、投げられたエラーを捕まえるError Boundaryはありません。失敗するcomputedにError Boundaryのセマンティクスが必要な場合は [`useSignalValue`](./hooks.ja.md#usesignalvalue) を使ってください。
- `value`/`checked`/`style` については2点が未解決です。現状は[直接バインディングの設計検討docs](../../development/design/direct-binding-value-checked-style.ja.md)を参照してください: *派生* `value` におけるcaretの維持と、per-propertyの細かい `style` 追跡(`style={{ color: signal }}`)です。

関連: [描画最適化](./rendering-optimization.ja.md)、[JSX制御フローユーティリティ](./control-flow.ja.md)。
