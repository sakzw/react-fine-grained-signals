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
- text系 `input`、`textarea`、単一／複数選択 `select` の `bindValue`、checkbox `input` の `bindChecked`
- 明示bindingと併用しない `value` と `checked` はReact標準の意味論を維持します
- `data-*` と `aria-*` 属性

```tsx
const title = signal("Initial title");
const disabled = signal(false);
const boxStyle = signal({ color: "crimson" });
const newTitle = signal("");
const enabled = signal(false);
const selected = signal("a");
const selectedMany = signal<string[]>(["a"]);

export function Field() {
  return (
    <>
      <button title={title} disabled={disabled} style={boxStyle}>
        {title}
      </button>
      <input bindValue={newTitle} />
      <input type="checkbox" bindChecked={enabled} />
      <select bindValue={selected}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <select multiple bindValue={selectedMany}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
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
const amount = signal("12.5");
const enabled = signal(false);

<input bindValue={name} />
<input type="number" step="any" bindValue={amount} />
<textarea bindValue={name} />
<input type="checkbox" bindChecked={enabled} />
```

`bindValue`はtext系input type（`text`、`search`、`tel`、`url`、`password`、`email`）と`type="number"`（どちらも`FormBindableSignal<string>`）、`textarea`、`FormBindableSignal<string>`を使う単一選択select、`FormBindableSignal<string[]>`を使うmultiple selectに対応します。同じform ownerと`name`のradio inputは`FormBindableSignal<string>`を共有できます。各optionにはstringの`value`が必要です。同じform ownerと`name`のcheckbox inputは`FormBindableSignal<string[]>`を共有できます。各checkboxにはstringの`value`が必要です。`bindChecked`は独立したcheckbox 1つを同期する用途で、`FormBindableSignal<boolean>`が必要です。selectの配列bindingでは`multiple`を静的に`true`にしてください。型は動的booleanを拒否するため、動的な`multiple`にはcastが必要です。その場合は現在のSignal値と実際のDOM modeをruntimeで検証します。複数選択の変更値は`selectedOptions`から取得し、optionの文書順になります。後から追加・削除したoptionは監視され、現在のsignal値に従って選択状態を再同期します。

`type="number"`の`bindValue`が保持するのはDOMの`.value`文字列です。空欄は`""`であり、RFSGは`valueAsNumber`への変換、`min`/`max`へのclamp、`step`への丸めを行いません。数値入力のsanitizeとconstraint validationはブラウザーに任せます。例えば`rangeUnderflow`、`rangeOverflow`、`stepMismatch`、`valueMissing`、場合によっては`badInput`が`input.validity`で確認できます。入力途中の不正・未完成文字列はブラウザーによりsanitizeされて`.value`が空になる場合があり、RFSGがDOMの`.value`で取得できない文字列まで保持する保証はありません。

`type="range"`も`FormBindableSignal<string>`を使い、DOMの`.value`文字列を保持します。RFSGは`valueAsNumber`へparseせず、min/max/stepの補正も追加しません。ユーザー操作や値の代入に対するrange control固有の動作はブラウザーに任せます。アプリで数値が必要な場合は明示的にparseしてください。

```tsx
const amount = signal("");
const parsedAmount = computed(() => amount.value === "" ? null : Number(amount.value));

<input type="number" min="0" max="100" step="0.25" bindValue={amount} />
```

`Number("")`は`0`なので、変換前に空文字を判定してください。`-`や`1.`などの任意の入力途中文字列を保持する必要がある場合はtext inputを使い、別途validate/parseします。郵便番号など数値に見える識別子も、先頭のゼロや書式を保つためtext inputを使ってください。`stepUp()`/`stepDown()`をプログラムから呼ぶとnative controlの値は変わりますが、それ自体はsignalへ通知しません。プログラムから変更した値をbindingへ反映するには対応するinput eventを発生させてください。

native radio groupは`Signal`のidentityではなくform ownerと`name`で排他制御されます。そのため、同じform ownerと`name`を持つbinding対象radioは必ず同じ書き込み可能Signalを共有してください。異なるSignalを結ぶと、ブラウザーは兄弟radioをsignal更新イベントなしに解除するため、DOMとsignalが食い違います。同じRFSG runtime copyが両方のbindingを登録している場合、RFSGは異なるsourceを拒否します。React標準の`checked`/`defaultChecked` radioや、別のRFSG runtime copyによるbindingは検出境界をまたぐため、同じnative groupに混在させないでください。form ownerまたは`name`が異なるradioは独立して使えます。同じnative groupを複数React rootに分ける場合も、同じSignalを共有してください。

checkbox groupの配列は、別optionを選択しても既存の順序と重複を維持します。新たに選んだ値は重複がなければ末尾へ追加し、解除時はその値をすべて削除します。

JSX bindingの型はpackage capabilityである`FormBindableSignal<T>`を要求します。`signal()`、`useSignal()`、書き込み可能な`computed({ get, set })`はこの型を返します。再利用可能なform propsでも`Signal<T>`へ広げず、この型を保ってください。

```tsx
import type { FormBindableSignal } from "react-fine-grained-signals";

type TextFieldProps<TMeta> = {
  value: FormBindableSignal<string>;
  label: string;
  metadata?: TMeta;
};

function TextField<TMeta>({ value, label }: TextFieldProps<TMeta>) {
  return <label>{label}<input bindValue={value} /></label>;
}
```

このcapabilityはTypeScript専用のopaque markerであり、JavaScript propertyとしては存在しません。runtimeはpackageのprivate signal brandとvalueの書き込み可能性を検証します。`Signal<T>`と注釈した値にはJSX bindingに必要な型情報が残らず、getter-only computedも引き続き拒否されます。

明示bindingがDOM stateを所有します。`bindValue`と`value`/`defaultValue`(radioとcheckbox groupのoptionはstring `value`を指定します)、`bindChecked`と`checked`/`defaultChecked`は併用できません。明示的に`undefined`を渡したpropは指定なしとして扱うため、`bindValue={enabled ? field : undefined}`はbindingなしのfieldになります。runtimeで拒否し、静的に分かる競合はRFSG JSX型でも拒否します。React標準のcontrolled selectは引き続き`value={selected.value}`と`onChange`で利用できます。`bindValue`ではnative change listenerがReactの`onChange`より前にsignalを更新するため、正規化処理がなければhandler内のsignal代入は不要です。

host refのattach後にbindingをsubscribeしてsignalの初期値を反映し、その後のsignal更新をownerの再レンダーなしでDOMへ書き込みます。native `input` eventはテキストを、`change` eventはselectの値（multipleでは配列）をsignalへ反映します。`bindChecked`とradio／checkbox groupはtargetのnative `click`でReactのdelegated click handlerより先にsignalを更新するため、そのhandlerとclickから合成される`onChange`は最新のsignal値を読めます。`preventDefault()`でcancelされたclickは、その間にhandlerが別の値を書いていなければevent後に元のsignal値へ戻します。group全体の補正はevent伝播後へ遅らせてReactのsynthetic `onChange`を維持します。`onChange`と`onInput` propsは変更せずReactへ渡します。text inputでは要素上のnative listenerがReactのdelegated handlerより先に実行されます。binding setterは同期的に呼び出しますが、補正のDOM書き込みはeventの伝播後へ遅らせるため、React handlerは入力された文字列を受け取れます。`onChange`には追加処理や正規化の書き込みを記述できます。`onChange`で入力を無視してもsetterはすでに呼ばれているため、入力拒否にはなりません。

書き込み可能なcomputed bindingではgetterの値を正本とします。input eventが完全に伝播した後、次のtaskでgetterを読みます。DOMに同じeventで入力された値が残っており、getter値と異なる場合だけDOMを補正します。ブラウザによってはnative listener間でmicrotaskを実行し、Reactのdelegated handlerより前に補正されるため、taskへ遅延させます。これにより入力拒否と正規化を扱いながら、新しい入力やReact handlerによるDOM変更への古い補正を避けます。IME composition中はcomposition終了まで補正を遅らせます。

text controlとselectでは同じ値の書き込みを省略します。focused fieldへの外部更新ではselection rangeを新しい文字列の長さに収まるように維持します。selection APIがないinput typeではcaret位置をブラウザに任せます。IME変換中の外部更新は`compositionend`まで遅延するため変換を中断せず、最後にpending signal値を適用します。form resetは単一／複数selectを含め最新のsignal値へ戻します。reset eventがcancelされた場合はDOMとsignalを変更しません。optionが後から追加された場合は、その時点でsignalに一致する選択とreset用defaultを反映します。

SSRではsignalの初期値を対応するdefault valueとして出力します。serverとclientの初期値を一致させてください。hydration時に既存host nodeへbindingをattachしますが、hydration前に行われた編集はsignalの初期値で上書きされる場合があります。

これらのpropsはRFSG JSX runtime（`jsxImportSource: "react-fine-grained-signals"`）でのみ認識され、DOMへ渡す前に取り除かれます。`value`または`checked`へsignalを渡すとmigration errorになります。direct bindingには`bindValue`/`bindChecked`を使い、React controlled semanticsには`signal.value`を渡してください。


## 制約

- allowlistにないevent handler、SVG props、その他のhost propsはdirect bindingされません。
- direct bindingの書き込みはReactのschedulerの外で行われ、実験的な最適化のままです。
- host propはレンダーごとに素の値とsignalを切り替えられます。要素の型は変わらず、子のstateも保たれます。切り替わるのはbindingの付け外しだけです(ただし `value`/`checked` をsignalと素の値で切り替えると、inputはReactのuncontrolled/controlledの間で切り替わり、React標準の警告が出ます)。
- bindingはhost要素自身のrefを通じて付けられます。渡したrefは、Reactが直接呼ぶ場合とまったく同じように要素を受け取ります。refが安定していれば、bindingが変わらない限り再レンダーで呼び直されることはありません。bindingが変わるのは、bindingが別のsignalや素の値に切り替わったときと、bindingしたpropや `style` が前回のレンダーと異なる値でレンダーされたとき(2回のレンダーの間に書き込みがあった場合)です。このときrefは同じcommitの中で一度外れ、再び付けられます。
- `deepSignal` はsignal childやbindingするpropには使えません。これらの位置はrootの置き換えしか追わないため、ネストした変更は表示に反映されません。TypeScriptはこれをエラーにします。deepな状態は追跡されたコンポーネント内で読むか、[`useDeepSignalValue`](./hooks.ja.md#usedeepsignalvalue) でprimitiveを選択してください。
- `computed({ get, set })` とwritable `useComputed({ get, set })` は、値の型がfieldと合えばbindingできます。ユーザー入力はsetterを呼び、依存signalの更新はgetterを通してDOMに反映されます。setterが入力を拒否または正規化した場合はgetterを正本としてReact handlerの後にDOMを補正します。getterのみのcomputedは読み取り専用です。
- SSRとhydrationでは、signalの初期値がサーバーとクライアントで一致するようにしてください。リクエスト固有のsignalを共有のmodule scopeへ置かず、リクエストごとに生成してください。
- bindingしたcomputed signalのgetterが例外を投げた場合、そのサイクルのDOM書き込みはスキップされ、`console.error` にエラーが記録されます。記録は書き込みごとではなく、連続した失敗のエピソードごとに1回です。メッセージは `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` で、`{ cause: error }` が付きます。direct bindingはReactのrenderサイクルを経由しないため、投げられたエラーを捕まえるError Boundaryはありません。失敗するcomputedにError Boundaryのセマンティクスが必要な場合は [`useSignalValue`](./hooks.ja.md#usesignalvalue) を使ってください。
- *派生* `value` におけるcaretの維持は既知の制約です。現在の状態は[直接バインディングの設計検討docs](../../development/design/direct-binding-value-checked-style.ja.md)を参照してください。

関連: [描画最適化](./rendering-optimization.ja.md)、[JSX制御フローユーティリティ](./control-flow.ja.md)。
