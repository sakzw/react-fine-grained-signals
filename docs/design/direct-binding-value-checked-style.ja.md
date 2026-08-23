# `value`・`checked`・`style` の direct binding対応に関する設計検討

[English](direct-binding-value-checked-style.md) | [日本語](direct-binding-value-checked-style.ja.md)

**状態:** `value`/`checked` と粗い形の `style` bindingは実装・出荷済みです。以下の2つの設計課題は本当に未決定のまま残っており、APIも実装方針も決まっていません。

## 実装済み(出荷済み)

JSX runtimeは、allowlistに含まれるnative host propに渡されたsignalをdirect bindingします。mount時に `.peek()` からDOMを初期化し、その後の変更はrefが設置する `effect()` を通じて書き込み、そのpropについてはReactの再レンダーを経由しません(`src/runtime/jsx.ts` の `transformProps` / `ReactiveHost`。allowlist全体はREADMEの「JSX signal children and host bindings」を参照してください)。

- **`value`/`checked`。** `isControlledTwoWayProp` と `setControlledProp` が、Reactが実際にcontrolledとして扱うtag ―― `value` は `input`/`textarea`/`select`、`checked` は `input` ―― に双方向の扱いを限定します。controlled propは `.peek()` から得た値で `defaultValue`/`defaultChecked` に置き換えられるためReactは再diffせず、DOMが既に同じ値を持っている場合は書き込みを省略します。`<select multiple>` は `setMultiSelectValue`(`String(value)` ではなく各 `<option>.selected` を切り替え)を通ります。それ以外の `value`/`checked` を持つ要素(`<li value>`、`<option value>`、`<meter value>` など)は、通常のpeek-and-substitute経路のままです。
- **`<select>` の再同期。** `bindSelectValue` が通常のper-value effectに加えて、selectのsubtreeへ `MutationObserver` を設置します。これにより、mount後に追加された(例えばoption自体がsignalから描画される場合の)マッチする `<option>` も正しく選択されます。以前はbindingされたsignalだけを監視し、DOMの `<option>` listの変化には反応しなかったため、選択状態が空のまま固まっていました。
- **IME compositionの安全性。** `bindTextValue` が、componentが独自のcomposition handlerを宣言しているかどうかに関係なく、`compositionstart`/`compositionend` をnode自身で直接追跡します。composition中に要求された `value` の書き込み ―― inputの `onChange` からではなく、同じsignalの別の購読者から発生したものも含む ―― は、即座に適用されず composition終了まで遅延されるため、進行中のcompositionを中断できなくなりました。
- **`style`(粗い、object全体の形)。** `applyStyle` が解決済みのobjectを代入し、unit必須の数値propertyには `px` を付け、`--custom-property` entryは `setProperty` で書き込み、前回にはあり今回にはないkeyをclearします。scopeはHTML hostのみです。
- `tests/react.test.tsx`(`<select>` の再同期、IME composition、独立した `computed` に支えられたradio groupの兄弟unchecking、`value` bindingをStrict Modeで包んだdouble-invoke testを含む)、`tests/ssr.test.tsx`、`tests/jsx-types.tsx` でtest済みです。

## 未実装 ―― 未決定の設計課題

### 派生 `value` のcaret維持

出荷済みのwrite-skip guard(`if (input.value !== next) input.value = next`)が助けになるのは、signalがDOMが既に保持している文字列をそのまま送り返してくる場合 ―― 通常の `onChange` の往復 ―― だけです。*派生*値、つまりユーザーの入力をtrimしたりupper-caseしたりして変換するsignalには何も効きません。派生後の文字列が実際に入力された文字列と異なると、identity checkが失敗して書き込みが実行され、caretが末尾へ飛ぶことがあります。

`value` をdirect bindingするreactive UIライブラリはどれもこの問題に直面します。現時点ではこれは**文書化され受け入れられた制約**であり、このprojectは解決を約束しておらず、実装も一切試みていません。

**候補となる修正案(未決定):** 強制的な書き込みを行う前に `selectionStart`/`selectionEnd` を取得しておき、書き込み後に復元します。要素がfocusされているときに限ります。

- 出荷済みguardがカバーできない派生値のcaseにもcaret維持を広げられます。
- `selectionStart`/`selectionEnd` はすべてのinput `type`(`number`、`date`、`color` など)に存在するわけではなく、throwするかnullを返すため、type単位のguardが必要です。
- IME composition中にselectionを復元すると、それ自体がcompositionを壊しかねません。既存のwrite-skip checkと単に並べて動かすのではなく、組み合わせて動作するように設計する必要があります。
- prototypeは存在しません。上記の論点を超えてscopeされていません。

**出荷されるまでの間:** reactiveなpropを専用のleaf componentへ切り出してください(`TaskRow` が既に示しているpattern)。そのleafだけが再レンダーされます。

### fine-grainedなper-property `style` 追跡

出荷済みのbindingは `style={signal}` を1つのobject全体書き込みとしてしか扱いません。個々のentry自体がsignalであるstyle object、つまり `style={{ color: signal }}` はサポートしていません。1つのCSS propertyだけをreactiveにしたい利用者は、現状style object全体を `computed` 経由にする必要があります。

**候補となる方法(未決定):** JSX transformの境界(`transformProps` または隣接するhelper)で `style` object内のvalueとしてsignalを検出し、それぞれのentryを個別のeffectとしてbindingします。signalでないentryはそのまま触れません。

- Solid的なAPIの書き味に最も近づけます。また `.style` はHTML・SVG・MathMLに一様に存在するため、`setDomProp` の他の部分が抱えるSVG/MathML除外も不要になります。
- `isReactiveHostProp` は今日、最上位のprop valueしか見ていません。object literalの1階層内側まで見に行くのは異なる形のtransformで、まだ設計されていません。
- signalとsignalでないentryが混在するstyle object向けの専用testが必要です。
- render をまたいで `style` prop全体が異なる形のobjectへ差し替わった場合の扱いを決める必要があります。「host propがbindingされているかどうかは要素の生存期間中固定する」という既存の制約に相当するものが、render間でstyle objectへentryが追加・削除されるcaseにはまだ定義されていません。
- prototypeは存在しません。上記の論点を超えてscopeされていません。

**出荷されるまでの間:** style object全体を `computed` 経由にするか、単一propertyのreactivityが必要ならleaf component patternに頼ってください。

## 非目標

- direct-bound要素に対して、React controlled inputのあらゆる挙動(例えば `defaultValue` のfallback semantics)を再現すること。
- 上記でカバーされない範囲について、推奨されるleaf component pattern(`TaskRow` が示すもの)を変更すること。
