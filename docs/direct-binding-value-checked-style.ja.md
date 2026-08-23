# `value`・`checked`・`style` の direct binding対応に関する設計検討

[English](direct-binding-value-checked-style.md) | [日本語](direct-binding-value-checked-style.ja.md)

状態: 設計検討中。APIや実装方針はまだ決定していません。

## 背景

現在のJSX runtimeは、native host elementの `title`、`id`、`className`、`hidden`、`disabled`、`data-*`、`aria-*` に渡されたsignalをdirect bindingします。`transformProps` がJSX propsからsignalを取り出し、`.peek()` で初期DOM状態を決め、要素を `ReactiveHost` で包みます。そのrefは、bindingされたpropごとに `effect()` を1つ設置し、`setDomProp` を通じてDOMへ直接書き込みます。signalが変わってもReactは所有componentを再レンダーせず、refのeffectだけが実行されます。

`value`、`checked`、`style` は現在このallowlistから明示的に除外されています。この検討の直接の動機は `value` です。`NewTaskForm` へ切り出す前の `examples/react-router/app/routes/home.tsx` は、controlled `<input>` の `value` propに `newTitle.value` を直接読んでおり、direct bindingの逃げ道がないため、1keystrokeごとに所有component全体が再レンダーされていました。`checked` にも同じ形の読み取りが別のfile、`TaskRow` の `checked={task.done}` にあります。`style` はこのcodebaseのどこでも現在使われていません。README.mdの「allowlistから除外」という同じ行に載っているためこのdocsの対象に含めているだけで、具体的な使用例があるわけではありません。`value` と `checked` のcaseで現時点でサポートされている唯一の答えは、`TaskRow` と `NewTaskForm` が既に使っているpattern、つまりreactiveなpropを専用のleaf componentへ切り出し、そのleafだけが `useSignals()` scopeを持って再レンダーされるようにすることです。

このdocsは、「leaf componentへ切り出す」と「allowlistを拡張する」を対等に比較できるよう、`value`・`checked`・`style` へのdirect binding対応が何を必要とするかを整理します。

## この3つが既存のallowlistより難しい理由

runtimeが既にdirect bindingしているpropは、Reactの視点から見るとすべてwrite-onlyです。ReactはDOMが最新のrenderを反映しているかどうかを判断するために `title`、`id`、`className`、`hidden`、`disabled` と比較することはなく、DOMがそれらをkeystrokeごとに突き合わせなければならないeventを発火することもありません。範囲外の `effect()` でこれらを書き込んでも安全なのは、同じDOM propertyへ書き込もうとする競合相手が他にいないからです。

`value` と `checked` は、この前提を2つの点で崩します。

- 双方向bindingであることです。`onChange`(signalではないため既に `hostProps` にそのまま残されています)はDOMから読んでsignalへ反映し、direct bindingのeffectはsignalからDOMへ書き戻します。effectが実行されるたびに、DOMが既にその値を保持していても無条件に `node.value`/`node.checked` を書き込むのは、fine-grainedなreactive UIライブラリがcontrolled inputの周りでどこも文書化している急所です。ブラウザとinput `type` によっては `selectionStart`/`selectionEnd` を乱したり、文字列を再整形したり(`<input type="number">` などで)します。文字列が結果的に変わっていなくても起こり得る失敗モードが1つあります — 進行中のIME compositionを中断させることです。
- `transformProps` はdirect-bound propを要素から取り除いているわけではありません。`title`/`disabled` などに対して既にそうしているのと同じように、`.peek()` に置き換えているだけです(`props[name] = readInitialValue(value)`)。これを `value`/`checked` にそのまま適用すると、inputはReact-controlledのまま残り、`value` は所有componentが実際に前回再レンダーしたときに `.peek()` が返した値に固定され、その間にrefのeffectが新しい値を直接DOMへ書き込みます。所有componentが無関係な理由で後から再レンダーされると、Reactには同じ古いpropが再び渡され、Reactのcontrolled input reconciliation ―― 前回自分が設定した値からDOMの実際の値が乖離していないかを追跡し、それをもとにDOMを強制的に同期し直す仕組み ―― が、direct bindingのeffectが書き込んだものを上書きしてしまいます。つまり `value`/`checked` を安全にサポートするには、「DOMへ書き込むeffectを追加する」だけでは足りません。要素がそもそもReactからcontrolledとして再主張されないようにする方法(例えば、propを本当に取り除き、初回paintには `defaultValue`/`defaultChecked` を代わりに使うなど)を決める必要があり、それは `transformProps` が今日allowlistの他のpropに使っているpeek-and-substitute方式とは異なるprop処理戦略です。

`style` は双方向bindingではないためcaretの問題はありませんが、別の形で現行モデルを崩します。runtimeが今日bindingしているpropはすべて、scalarなDOM propertyか単一の `setAttribute` 呼び出しです。`style` は単一のobject(`className` と同じ粗さでbindingできます)であるか、より有用には、個々のentry自体がsignalであるobject(`style={{ color: theme }}`)であり、後者には現行の `isReactiveHostProp` チェックには存在しないsub-property単位の追跡が必要です。`style` はnamespaceの挙動でも `className`・`hidden`・`disabled` と異なります。SVG要素は `className`(`SVGAnimatedString`)とは違い、`.style` を通じて標準的な `CSSStyleDeclaration` を公開するため、`style` には `setDomProp` の他の部分が抱えるSVG/MathML除外が不要かもしれません。

## 先行事例

Solidのcompiled JSXは、direct property assignmentである `prop:` とattribute bindingを区別しています。これは、このprojectが `title`/`disabled` などに既に使っているのと同じdirect writeの形です。Vueの `v-model` やPreactのcontrolled input向けsignal bindingは、いずれもDOMの現在値とこれから書き込む値を比較し、既に一致していればDOM書き込みを省略するguardを書き込み経路に持たせています。異なる2つのecosystemが独立にたどり着いたこのguardが、下記の選択肢1の直接の前例です。

## 将来の判断で達成したいこと

- signalが `onChange` から受け取ったばかりの `value` をそのまま往復して戻ってきたとき、caret/selectionの位置とIME composition状態を維持する。
- `checked` には、既存の `disabled` binding程度の単純さを、少なくとも一般的なcheckboxのcaseでは与える。caretを守る問題がそもそも存在しないためです。
- `style={signalOfStyleObject}` という粗い形は、今日と同じper-prop modelで少なくともサポートする。style object内のper-property signal(`style={{ color: signal }}`)は、同じ変更の必須要件ではなく、別途scopeする拡張として扱う。
- SSR/hydrationの契約を既存のallowlistと同一に保つ。初回renderは `.peek()` を使い、refがmountした後にdirect writeが引き継ぐ。
- `value`/`checked` の要素で2つの書き手が競合することを起こり得なくする。上のsectionで述べた通り、既存のpeek-and-substitute方式のprop処理(allowlistの他のpropに使われているもの)をそのまま使うと、要素は所有componentが前回実際に再レンダーしたときの値に固定されたままReact-controlledであり続け、direct bindingのeffectがそれを追い越して書き込む形になります。そのためこの目標には、両方を同時にbindingしないという運用上の注意だけでなく、この2つのpropに特有の異なるprop処理戦略がおそらく必要です。

## 非目標

- `value` にbindingされた*派生*値(例えばユーザーの入力をtrimしたりupper-caseしたりするsignal)のcaret維持を解決すること。`value` をdirect bindingするreactive UIライブラリはどれもこの問題に直面します。このdocsはこれを、排除すべきbugではなく、正確に説明すべき既知の制約として扱います。
- direct-bound要素に対して、React controlled inputのあらゆる挙動(例えば `defaultValue` のfallback semantics)を再現すること。
- nested `style` object内のsignal追跡(`style={{ color: signal }}`)の最終形を、この検討で決定すること。別途scopeする理由は下記の `style` の選択肢を参照。
- この検討から何が出荷されるにせよ、それでカバーされない範囲について、推奨されるleaf component pattern(`TaskRow`、`NewTaskForm`)を変更すること。

## 評価する選択肢

### 1. `value`/`checked`: 既に一致している場合はDOM書き込みを省略する

書き込む前に、DOM要素の現在の値(`node.value` / `node.checked`)とsignalの値を比較し、一致しない場合だけsetterを呼びます。先行事例で述べたPreact/Vueのguardと同じ発想です。

利点は、一般的なcase(keystrokeでsignalが更新され、effectが再実行されるが、DOMが既に保持している文字列とまったく同じ値であるため書き込みが省略され、caretが動かない)を解決でき、新しい公開APIも不要なことです。欠点は、`value` にbindingされた*派生*値(前述の非目標のcase)には効かないこと、IME compositionのtestが別途必要なこと(composition中は、DOM上の一時的な合成中テキストとsignalが確定した値が、書き戻す価値のないsignalの差として正当に食い違うことがあります)、そしてこれ単体では「この3つが難しい理由」で述べた別の問題を解決しないことです。所有componentが無関係な理由で再レンダーされると、Reactには依然として古いpeek済みのpropが渡され、それをDOMへ強制的に書き戻すのはこのeffectではなくReact自身のcontrolled input reconciliationです。これには(目標のsectionで述べた通り)`transformProps` がprop自体をどう扱うかの変更が必要で、このwrite-skip guardとは別の話です。

### 2. `value`: 強制的な書き込みでもselectionを維持する

選択肢1では書き込みを避けられない場合(派生値のcase)、書き込み前に `selectionStart`/`selectionEnd` を取得し、書き込み後に復元します。要素がfocusされているときに限ります。

利点は、選択肢1では解決しない派生値のcaseにもcaret維持を広げられることです。欠点は、`selectionStart`/`selectionEnd` がすべてのinput `type`(`number`、`date`、`color` など)に存在するわけではなく、throwするかnullを返すため、type単位のguardが実装に必要なことです。IME composition中にselectionを復元すると、それ自体がcompositionを壊しかねないため、これは選択肢1のidentity checkの隣に置くのではなく、組み合わせて動作する必要があります。

### 3. `checked`: `disabled` と同じモデルでdirect bindingする

caret用のguardなしで、既存のper-prop-name allowlistに `checked` を追加します。checkboxとradioには失うべきselection状態がそもそもありません。

利点は、既存の `disabled` bindingと機構的に同一であることです。興味深い失敗モードである、per-optionの独立した `computed` signalに支えられたradio groupで、1つを選択すると他がuncheckされる必要がある、というcaseも、各 `computed` が正しく `false` へ導出される限り既に正しく解決します。これはruntimeの新しい仕事ではなく、appのmodeling上の関心事です。欠点は、`value` と同様に双方向bindingであることに変わりはなく、`checked` propが同じ要素上でReact-controlledとdirect-bound双方に決してならないという同じ保証が必要で、`value` のtestをそのまま継承するのではなく専用のtestが必要なことです。

### 4. `style`(粗い形): `className` と同様にobject全体をbindingする

`style={signal}` を1つのbindingとして扱い、そのeffectが解決済みのobjectをnodeへ代入します(`Object.assign(node.style, value)` など)。既存のper-prop-name modelをそのまま再利用します。

利点は、新しい追跡モデルが不要で、caretの問題もなく、上記の `value`/`checked` の判断とは独立に出荷できることです。専用のcoercion処理(unit必須のCSS propertyに対する数値、`setProperty` を要する `--custom-property` entry、前回のobjectにあり今回のobjectにはないpropertyを、上書きではなくきちんとclearすること)は必要ですが、それ自体で閉じています。欠点は、より書き味の良い `style={{ color: signal }}` というper-property形を提供しないことです。1つのCSS propertyだけをreactiveにしたい利用者も、style object全体を `computed` 経由にする必要があります。

### 5. `style`(fine-grainedな形): style object内部にnestされたsignalを追跡する

JSX transformの境界(`transformProps` または隣接するhelper)で、`style` object内のvalueとしてsignalを検出し、それぞれのentryを個別のeffectとしてbindingします。signalではない通常のentryは、どのeffectにも触れられずobject propertyのまま残ります。

利点は、Solid的なAPIが提供する書き味に最も近づけることと、背景section で述べた通り、`.style` はHTML・SVG・MathMLで一様に存在するため、`setDomProp` の他の部分が抱えるSVG/MathML除外が不要になることです。欠点は、`isReactiveHostProp` が今日は最上位のprop valueしか見ておらず、object literalの1階層内側まで見に行くのは異なる形のtransformであること、signalとsignalでないentryが混在するstyle objectに対する専用testが必要なこと、そしてrenderをまたいで `style` prop全体が異なる形のobjectへ差し替わった場合の扱いを決める必要があることです。「host propがbindingされているかどうかは要素の生存期間中固定する」という既存の制約に相当するものが、render間でstyle objectへentryが追加・削除されるcaseにも必要になります。

### 6. まず `checked` と粗い `style` を出荷し、`value` とfine-grainedな `style` は保留する

選択肢3と4をそれぞれ独立した変更として進めます。どちらも `value` が抱えるcaret/compositionのriskや、fine-grainedな `style` が必要とするtransformの形の変更を伴わないためです。`value`(選択肢1・2)とfine-grainedな `style`(選択肢5)は、別途scopeするfollow-upとして後で再検討します。

利点は、除外listのうち難しくない半分を、難しい半分に足を引っ張られず届けられることと、`value` のcaret維持戦略を確定させる前に、`checked` と `style` のbindingを実際に使ってもらえることです。欠点は、この検討のそもそもの動機であるcase、つまりtext `<input>` の `value` が、後の判断が下るまでleaf component patternを必要とし続けることです。

### 7. `value`・`checked`・`style` を除外したまま、leaf component patternを答えとして文書化する

runtimeへの変更は行いません。reactiveなpropを専用のcomponentへ切り出す(`TaskRow` と `NewTaskForm` が既に行っているように)ことを、親を再レンダーさせずに変化の速いsignalを扱う、サポートされた方法として文書化します。

利点は、新しいcaret・composition・controlled/uncontrolledのedge caseをtestする必要がなく、このpatternは既にこのrepository自身の例で実証済みであることです。欠点は、direct bindingの他の部分にはないergonomicsの隙間が残ることです。利用者は、`value`/`checked`/`style` に限ってはcomponent切り出しに頼る必要があることを、JSXの型からの手がかりなしに、自分で知っていなければなりません。

## 判断基準

採用する選択肢には、少なくとも次の実行可能なtestが必要です。

- direct-bindingされた `<input value={signal} onChange={...} />` へ入力してもcaretが動かないこと。同じ値のechoの場合と、(選択肢2を採用する場合は)派生・正規化された値の場合の両方。
- IME compositionの一連(`compositionstart` → `compositionupdate` → `compositionend`)が、composition中に同じsignalの別の購読者が書き戻しても壊れずに完了すること。
- `value`/`checked` へのdirect writeそれ自体が、native `input`/`change` eventを発火しないこと(`onChange` を通じたfeedback loopがないこと)。
- 所有componentの無関係な再レンダー(`ReactiveHost` のref callbackを作り直し、bindingされたeffectを解体・再構築します。このcallbackはrenderのたびに新しいclosureになるためです)が、focusされたdirect-bound `value`/`checked` 要素を、その再レンダー時に固定された古い値へReactのcontrolled input reconciliationが引き戻すことを許さず、進行中の編集やIME compositionをそれ自体で目に見える形で乱さないこと。
- per-optionの独立した `computed` signalに支えられた `type="radio"` groupで、`checked` のdirect bindingが兄弟を正しくuncheckすること。
- SSRでrenderされた `value`/`checked`/`style`(`.peek()` から)が、clientの初回paintのDOM状態と完全に一致すること。これはconsole警告の不在ではなく、hydration後に実際のDOM propertyを読んで確認します。Reactはcontrolledな `value`/`checked` の不一致に対して仕様上hydration mismatch警告を出さないため、警告の不在を確認するtestは空虚に通ってしまいます。
- React 19 Strict Modeのdev-mode double-invokeで、refのeffectがfocus・caret・進行中のIME compositionを失わないこと。これは上の通常の再レンダーのcaseが既にカバーする範囲を超えた部分についてです。
- `style` のcoercion。unit不要と必須が混在する数値CSS property、`--custom-property` entry、前回のstyle objectにはあり今回にはないproperty(上書きではなくclearされる必要がある)。
- fine-grainedな `style` 追跡を出荷する場合: signalとsignalでないentryが混在するstyle objectで、値が変わったsignalのentryだけが更新され、兄弟propertyは触れられないこと。

## 現在の推奨

方針を決定するまでは、`value`・`checked`・`style` はdirect bindingの対象外のままとし、変化の速いsignalを親のrenderから切り離す方法としては、`TaskRow` と `NewTaskForm` が既に使っているleaf component patternをサポートされた方法とします。このdocsは各propが何を必要とするかを記録するものであり、選択肢を決定したり実装の時期を定めたりするものではありません。
