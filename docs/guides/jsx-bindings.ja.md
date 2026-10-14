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

対象になるのは、Reactが子要素をDOMノードとして描画する通常の子要素の位置です。`<title>`、`<textarea>`、`<style>` など、Reactが子要素を要素ごとの特別な方法で扱うhost要素は対象外です。そこに置いたsignalの子要素は、Reactがテキストを期待する位置でReact要素になるため、Reactが警告を出す、要素が空になる、または `[object Object]` が描画される、のいずれかになります(SSRでも同様です)。これらの要素では、追跡されたコンポーネント内で値を読む(`<title>{title.value}</title>`)か、テキスト入力欄であれば `bindValue` を使ってください。`<option>{signal}</option>` は通常の子要素と同じように動作します。

## bindingできるhost props

同じランタイムがDOMへ直接バインドできるネイティブHTML propsは次のものだけです。

- `title`、`id`、`className`、`hidden`、`disabled`
- `style`。object全体(`style={signal}`)とsignal entryを含むobject(例: `style={{ color: colorSignal, width: 12 }}`)をbindingします
- text系 `input` と `textarea` の `bindValue`、checkbox `input` の `bindChecked`
- `value` と `checked` はReact標準の意味論を維持し、`select`もReact標準のcontrolled inputとして扱います
- `data-*` と `aria-*` 属性

```tsx
const title = signal("Initial title");
const disabled = signal(false);
const boxStyle = signal({ color: "crimson" });
const newTitle = signal("");
const enabled = signal(false);

export function Field() {
  return (
    <>
      <button title={title} disabled={disabled} style={boxStyle}>
        {title}
      </button>
      <input bindValue={newTitle} />
      <input type="checkbox" bindChecked={enabled} />
    </>
  );
}
```

`title` または `id` のbindingに `null` / `undefined` を書き込むと、React DOMと同じように属性が削除されます。

## style

CSS propertyへbindingした数値は、Reactもunitless扱いする一部のproperty(`opacity`、`zIndex`、`flexGrow` など)を除き、`px` suffixを付けて書き込まれます。`--` で始まるkeyは `setProperty` を通じてCSS custom propertyとして書き込まれます。前回のstyle objectにはあり今回にはないkeyは、値を残さずclearされます。要素がレンダーされたときの値からReactが書き込んだkeyを、bindingが付く前にsignalが落とした場合(例えば `<Activity>` やSuspense境界が要素を隠している間)も同様です。

個々のstyle valueにもsignalを指定できます。host refのcommit時にentryごとのsubscriptionを設置するため、signalの変更はowner componentを再レンダーせずCSS propertyへ反映されます。同じobjectにあるplain entryは、componentが再レンダーするまで固定です。後のrenderでstyle objectを置き換えるとbindingを再差分し、新しいshapeで削除されたpropertyをclearします。対象はwhole-object style bindingと同じHTML hostです。

## form binding

`value` と `checked` はReact標準の意味論を維持します。React controlled inputには通常の値を渡し、従来どおり `onChange` でstateを更新してください。RFSGの `bindValue` と `bindChecked` は別のdirect binding APIで、書き込み可能なsignalが必要です。

```tsx
const name = signal("");
const enabled = signal(false);

<input bindValue={name} />
<textarea bindValue={name} />
<input type="checkbox" bindChecked={enabled} />
```

`bindValue`はtext系input type（`text`、`search`、`tel`、`url`、`password`、`email`）と`textarea`に対応します。`bindChecked`はcheckbox inputのみ対応し、radio groupは非対応です。共有の選択値bindingが用意されるまでは、radio groupにはReact controlled propsを使ってください。`select`もReact標準の`value`/`onChange` contractのままです。

host refのattach後にbindingをsubscribeしてsignalの初期値を反映し、その後のsignal更新をownerの再レンダーなしでDOMへ書き込みます。native `input` eventはテキストをsignalへ、native `change` eventはcheckboxの状態をsignalへ反映します。`onChange`と`onInput` propsは変更せずReactへ渡します。direct listenerはReactのbubble handlerより先に動くため、`onChange` handlerでsignalへ書き戻せば入力値を補正できます。`onChange`が編集を無視しても、native bindingがすでにDOM値をsignalへコピーしています。

text controlでは同じ値の書き込みを省略します。focused fieldへの外部更新ではselection rangeを新しい文字列の長さに収まるように維持します。selection APIがないinput typeではcaret位置をブラウザに任せます。IME変換中の外部更新は`compositionend`まで遅延するため変換を中断せず、最後にpending signal値を適用します。signalへ反映した値は`defaultValue`/`defaultChecked`にも同期されるため、form resetは最後にbindingされたsignal値へ戻ります。

SSRではsignalの初期値を対応するdefault valueとして出力します。serverとclientの初期値を一致させてください。hydration時に既存host nodeへbindingをattachしますが、hydration前に行われた編集はsignalの初期値で上書きされる場合があります。

これらのpropsはRFSG JSX runtime（`jsxImportSource: "react-fine-grained-signals"`）でのみ認識され、DOMへ渡す前に取り除かれます。`value`または`checked`へsignalを渡すとmigration errorになります。direct bindingには`bindValue`/`bindChecked`を使い、React controlled semanticsには`signal.value`を渡してください。


## 制約

- allowlistにないevent handler、SVG props、その他のhost propsはdirect bindingされません。
- direct bindingの書き込みはReactのschedulerの外で行われ、実験的な最適化のままです。
- host propはレンダーごとに素の値とsignalを切り替えられます。要素の型は変わらず、子のstateも保たれます。切り替わるのはbindingの付け外しだけです(ただし `value`/`checked` をsignalと素の値で切り替えると、inputはReactのuncontrolled/controlledの間で切り替わり、React標準の警告が出ます)。
- bindingはhost要素自身のrefを通じて付けられます。渡したrefは、Reactが直接呼ぶ場合とまったく同じように要素を受け取ります。refが安定していれば、bindingが変わらない限り再レンダーで呼び直されることはありません。bindingが変わるのは、bindingが別のsignalや素の値に切り替わったときと、bindingしたpropや `style` が前回のレンダーと異なる値でレンダーされたとき(2回のレンダーの間に書き込みがあった場合)です。このときrefは同じcommitの中で一度外れ、再び付けられます。
- `deepSignal` はsignal childやbindingするpropには使えません。これらの位置はrootの置き換えしか追わないため、ネストした変更は表示に反映されません。TypeScriptはこれをエラーにします。deepな状態は追跡されたコンポーネント内で読むか、[`useDeepSignalValue`](./hooks.ja.md#usedeepsignalvalue) でprimitiveを選択してください。
- SSRとhydrationでは、signalの初期値がサーバーとクライアントで一致するようにしてください。リクエスト固有のsignalを共有のmodule scopeへ置かず、リクエストごとに生成してください。
- bindingしたcomputed signalのgetterが例外を投げた場合、そのサイクルのDOM書き込みはスキップされ、`console.error` にエラーが記録されます。記録は書き込みごとではなく、連続した失敗のエピソードごとに1回です。メッセージは `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` で、`{ cause: error }` が付きます。direct bindingはReactのrenderサイクルを経由しないため、投げられたエラーを捕まえるError Boundaryはありません。失敗するcomputedにError Boundaryのセマンティクスが必要な場合は [`useSignalValue`](./hooks.ja.md#usesignalvalue) を使ってください。
- *派生* `value` におけるcaretの維持は既知の制約です。現在の状態は[直接バインディングの設計検討docs](../../development/design/direct-binding-value-checked-style.ja.md)を参照してください。

関連: [描画最適化](./rendering-optimization.ja.md)、[JSX制御フローユーティリティ](./control-flow.ja.md)。
