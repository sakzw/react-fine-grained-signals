# `value`・`checked`・`style` の direct binding対応に関する設計検討

[English](direct-binding-value-checked-style.md) | [日本語](direct-binding-value-checked-style.ja.md)

状態: ほぼ実装済みです。`style`(粗い形、選択肢4)と `value`/`checked`(選択肢1・3、および目標sectionのprop処理戦略の変更)は出荷済みです — 下記の該当選択肢の注記を参照してください。未決定のまま残っているのは、派生 `value` のcaret維持(選択肢2)とper-property単位のfine-grainedな `style` 追跡(選択肢5)です。

## 背景

現在のJSX runtimeは、native host elementの `title`、`id`、`className`、`hidden`、`disabled`、`style`、`data-*`、`aria-*` に渡されたsignalをdirect bindingします。`transformProps` がJSX propsからsignalを取り出し、`.peek()` で初期DOM状態を決め、要素を `ReactiveHost` で包みます。そのrefは、bindingされたpropごとに `effect()` を1つ設置し、`setDomProp`(`style` の場合は選択肢4で説明する専用の `applyStyle` helper)を通じてDOMへ直接書き込みます。signalが変わってもReactは所有componentを再レンダーせず、refのeffectだけが実行されます。

`value`、`checked`、`style` は、この検討を始めた時点ではこのallowlistから明示的に除外されていました。`value` はこの検討の直接の動機でした。`examples/react-router/app/routes/home.tsx` は、controlled `<input>` の `value` propに `newTitle.value` を直接読んでおり、direct bindingの逃げ道がないため、1keystrokeごとに所有component全体が再レンダーされていました。(これを解消するleaf component切り出しは、この検討の過程で一度試し、後から意図的に元に戻しました。元の再レンダーを再現可能なまま残すためです。`value` bindingが出荷されて検証できた後 ―― 文字列の途中にcaretを置いてtypingすると、jsdomではなく実際のChromium上でPlaywrightを使い、挿入した文字のちょうど後ろにcaretがある正しい文字列になること、filterタブを切り替えて引き起こした無関係な再レンダーでもfieldが乱れないことを確認しました ―― exampleを `value={newTitle}` というdirect bindingの形に更新し、現在はそちらを使っています。)`checked` にも同じ例の中に双方向bindingされた読み取りがありました。`TaskRow` の `checked={task.done}` です。ただし `TaskRow` はtask list内で既に独立した `useSignals()` leafであるため、この読み取りが自身の行を超えて再レンダーを引き起こしたことは実際にはありません。`checked` をこのdocsの対象に含めていたのは、`value` と同じreconciliationのriskの理屈からであり、そのfileで観測されたbugがあったからではありません。`style` はこのcodebaseのどこでも使われていません。README.mdの「allowlistから除外」という同じ行に載っているためこのdocsの対象に含めていただけで、具体的な使用例があったわけではありません。このdocsがbindingを出荷する前は、`value` のようなcaseに対する一般的な答えは、reactiveなpropを専用のleaf componentへ切り出し、そのleafだけが `useSignals()` scopeを持って再レンダーされるようにすることでした ―― `TaskRow` が今もtask listで示しているpatternであり、このdocsが出荷した選択肢でカバーされない範囲については今も変わらぬ答えです。

このdocsは、「leaf componentへ切り出す」と「allowlistを拡張する」を対等に比較できるよう、`value`・`checked`・`style` へのdirect binding対応が何を必要とするかを整理します。

## この3つが既存のallowlistより難しい理由

runtimeが既にdirect bindingしているpropは、Reactの視点から見るとすべてwrite-onlyです。ReactはDOMが最新のrenderを反映しているかどうかを判断するために `title`、`id`、`className`、`hidden`、`disabled` と比較することはなく、DOMがそれらをkeystrokeごとに突き合わせなければならないeventを発火することもありません。範囲外の `effect()` でこれらを書き込んでも安全なのは、同じDOM propertyへ書き込もうとする競合相手が他にいないからです。

`value` と `checked` は、この前提を2つの点で崩します。

- 双方向bindingであることです。`onChange`(signalではないため既に `hostProps` にそのまま残されています)はDOMから読んでsignalへ反映し、direct bindingのeffectはsignalからDOMへ書き戻します。effectが実行されるたびに、DOMが既にその値を保持していても無条件に `node.value`/`node.checked` を書き込むのは、fine-grainedなreactive UIライブラリがcontrolled inputの周りでどこも文書化している急所です。ブラウザとinput `type` によっては `selectionStart`/`selectionEnd` を乱したり、文字列を再整形したり(`<input type="number">` などで)します。文字列が結果的に変わっていなくても起こり得る失敗モードが1つあります — 進行中のIME compositionを中断させることです。
- `transformProps` は、既定では direct-bound propを要素から取り除きません。`title`/`disabled` などに対して既にそうしているのと同じように、`.peek()` に置き換えているだけです(`props[name] = readInitialValue(value)`)。これを `value`/`checked` にそのまま適用すると、inputはReact-controlledのままになり、`value` は所有componentが実際に再レンダーするたびに `.peek()` から新しく供給されます(すべてのrenderで再計算されるため、内容がstaleになることはありません)。一方でrefのeffectは、renderとrenderの間に新しい値を直接DOMへ書き込みます。これを直接test(prop置き換えの部分だけを一時的にpeek-and-substitute方式へ戻し、選択肢1のwrite-skip guardは残したまま)してみたところ、ここで試したcaseでは目に見えるbugを再現できませんでした。React 19自身のcontrolled inputのcommit処理は、これから適用しようとする値をDOMが既に保持している場合、native writeを省略しているようです。これはPreactとVueが自ら追加していると先行事例で述べたguardと同じものです。つまり失敗モードは、ここで当初想定していたよりも狭く、おそらくtiming/stalenessが絡むedge case(time-slicingされるrenderやSuspenseで中断されるrenderなど、判断基準で既に挙げている類のもの)に限られ、簡単に再現できるものではなさそうです。それでも変わらず成り立つことがあります。将来のReactのversionでもこの内部guardがこのcaseをカバーし続けるかどうかに関係なく、`value`/`checked` をそのままcontrolled propとして残すことは、Reactが所有componentの無関係な再レンダーのたびにこのpropを再diffし、場合によっては再書き込みすることを意味します。これはallowlistの他のpropがmount後には一切行わない仕事です。そしてその正しさは、`defaultValue`/`defaultChecked`(mount時に一度だけ適用され、その後は一切触れられないという、公開されておりversionに依存しない意味を持つ)ではなく、文書化されていないReact内部の実装詳細に依存することになります。uncontrolledなpropへ置き換える ―― `value`/`checked` を本当に取り除き、初回paintには代わりに `defaultValue`/`defaultChecked` を使う ―― ことで、このpropのreconciliationからReactを完全に外すことができます。これは `transformProps` が今日allowlistの他のpropに使っているpeek-and-substitute方式とは異なるprop処理戦略であり、このdocsが出荷するのはこちらです(選択肢1の実装済み注記を参照)。

`style` は双方向bindingではないためcaretの問題はありませんが、別の形で現行モデルを崩します。runtimeが今日bindingしているpropはすべて、scalarなDOM propertyか単一の `setAttribute` 呼び出しです。`style` は単一のobject(`className` と同じ粗さでbindingできます)であるか、より有用には、個々のentry自体がsignalであるobject(`style={{ color: theme }}`)であり、後者には現行の `isReactiveHostProp` チェックには存在しないsub-property単位の追跡が必要です。`style` はnamespaceの挙動でも `className`・`hidden`・`disabled` と異なります。SVG要素は `className`(`SVGAnimatedString`)とは違い、`.style` を通じて標準的な `CSSStyleDeclaration` を公開するため、`style` には `setDomProp` の他の部分が抱えるSVG/MathML除外が不要かもしれません。

## 先行事例

Solidのcompiled JSXは、direct property assignmentである `prop:` とattribute bindingを区別しています。これは、このprojectが `title`/`disabled` などに既に使っているのと同じdirect writeの形です。Vueの `v-model` やPreactのcontrolled input向けsignal bindingは、いずれもDOMの現在値とこれから書き込む値を比較し、既に一致していればDOM書き込みを省略するguardを書き込み経路に持たせています。異なる2つのecosystemが独立にたどり着いたこのguardが、下記の選択肢1の直接の前例です。

## 将来の判断で達成したいこと

- signalが `onChange` から受け取ったばかりの `value` をそのまま往復して戻ってきたとき、caret/selectionの位置とIME composition状態を維持する。
- `checked` には、既存の `disabled` binding程度の単純さを、少なくとも一般的なcheckboxのcaseでは与える。caretを守る問題がそもそも存在しないためです。
- `style={signalOfStyleObject}` という粗い形は、今日と同じper-prop modelで少なくともサポートする。style object内のper-property signal(`style={{ color: signal }}`)は、同じ変更の必須要件ではなく、別途scopeする拡張として扱う。
- SSR/hydrationの契約を既存のallowlistと同一に保つ。初回renderは `.peek()` を使い、refがmountした後にdirect writeが引き継ぐ。
- `value`/`checked` の要素に2つの書き手ができることを避ける。Reactのcontrolled input reconciliationとdirect bindingのeffectの両方が、同じDOM propertyに触れる状態です。上のsectionで述べた通り、allowlistの他のpropに使っているpeek-and-substitute方式のprop処理をそのまま使うと、要素はReact-controlledのままになり、Reactが所有componentの無関係な再レンダーのたびにこのpropを再diffし、場合によっては再書き込みすることになります。その正しさは文書化された保証ではなく、React内部の実装詳細に依存することになります。この目標には、この2つのprop向けに、別の明示的なprop処理戦略が必要です。両方を同時にbindingしないという運用上の注意だけでは足りません。

## 非目標

- `value` にbindingされた*派生*値(例えばユーザーの入力をtrimしたりupper-caseしたりするsignal)のcaret維持を解決すること。`value` をdirect bindingするreactive UIライブラリはどれもこの問題に直面します。このdocsはこれを、排除すべきbugではなく、正確に説明すべき既知の制約として扱います。
- direct-bound要素に対して、React controlled inputのあらゆる挙動(例えば `defaultValue` のfallback semantics)を再現すること。
- nested `style` object内のsignal追跡(`style={{ color: signal }}`)の最終形を、この検討で決定すること。別途scopeする理由は下記の `style` の選択肢を参照。
- この検討から何が出荷されるにせよ、それでカバーされない範囲について、推奨されるleaf component pattern(`TaskRow` が示すもの)を変更すること。

## 評価する選択肢

### 1. `value`/`checked`: 既に一致している場合はDOM書き込みを省略する

書き込む前に、DOM要素の現在の値(`node.value` / `node.checked`)とsignalの値を比較し、一致しない場合だけsetterを呼びます。先行事例で述べたPreact/Vueのguardと同じ発想です。

利点は、一般的なcase(keystrokeでsignalが更新され、effectが再実行されるが、DOMが既に保持している文字列とまったく同じ値であるため書き込みが省略され、caretが動かない)を解決でき、新しい公開APIも不要なことです。欠点は、`value` にbindingされた*派生*値(前述の非目標のcase)には効かないこと、IME compositionのtestが別途必要なこと(composition中は、DOM上の一時的な合成中テキストとsignalが確定した値が、書き戻す価値のないsignalの差として正当に食い違うことがあります)、そしてこれ単体では、無関係な再レンダーを引き続きカバーし続けるかどうかをReact自身のcontrolled inputのwrite-skip挙動に依存したままにしてしまうことです(「この3つが難しい理由」参照)。目標sectionのprop処理戦略の変更と組み合わせることで、この依存を完全に取り除けます。

**目標sectionのprop処理戦略の変更と合わせて実装済みです。** `value` と `checked` は現在 `REACTIVE_PROP_NAMES` に含まれています。`isControlledTwoWayProp`(`src/runtime/jsx.ts`)は、Reactが実際にcontrolled/uncontrolledとして扱うtagに双方向の扱いを限定します。`value` は `input`、`textarea`、`select`、`checked` は `input` です。これらの要素では、`transformProps` がcontrolled propを削除し、`.peek()` から得た値で `defaultValue`/`defaultChecked` を代入します。そして `createReactiveRef` は新しい `setControlledProp` helperを通じて書き込み、これがこの選択肢のwrite-skip guardを実装しています(`if (input.value !== next) input.value = next` と、`checked` 版の同等処理)。それ以外の要素(`<li value>`、`<option value>`、`<meter value>` など)の `value`/`checked` は、通常のpeek-and-substitute経路のままです。避けるべきreconciliationがそもそもない、単なるwrite-only属性だからです。`tests/react.test.tsx`、`tests/ssr.test.tsx`、`tests/jsx-types.tsx` の型levelのcheckでカバーしています。記録しておく価値のある留保が1つあります。prop置き換えの半分だけを一時的に元に戻すdifferential run(`value` を文字通りのcontrolled propのままにし、`setControlledProp` のwrite-skip guardは残す)を行っても、`tests/react.test.tsx` のcaret維持testは失敗しませんでした。つまりそのtestが確認しているシナリオだけでは、このrepositoryが現在使っているReactのversionにおいて、prop置き換えの半分が必要であることを単体では証明できていません。それでもこの変更を残しているのは、「この3つが難しい理由」で述べた理由からです。React内部の挙動への依存ではなく文書化された挙動への依存にできること、そしてこのpropについてrenderごとのreconciliationの仕事を避けられることです。この2つの戦略を実際に区別できる将来のtest(通常の同期的な再レンダーではなく、判断基準にあるtiming/stalenessの条件がおそらく必要です)があれば、この論拠はさらに強くなります。

その後のレビューで、実装上の問題が2つ見つかり、どちらも修正してtestでカバーしています。`setControlledProp` は元々、配列値の `value`(`<select multiple>` に対するReact自身の型)を `String(value)` で書き込んでいました。これは意味のないカンマ区切り文字列を生成し、mount後の更新のたびに選択状態を静かに壊してしまいます。修正として、`select.multiple` を検出し、代わりに各 `<option>` の `.selected` を切り替えるようにしました。これはmulti-value selectに対するDOM自身の文書化されたAPIです(`setMultiSelectValue`、test: 「binds a signal directly to a multi-select's value via per-option selection」)。また `applyStyle`(選択肢4)は、`null` でない値ならなんでもstyle objectとして扱っていたため、`any` 型や型安全でない呼び出し元がobjectでない値を渡すと、`Object.keys` が文字列や配列のindexを辿ってしまい、無意味なkeyを書き込んでしまう可能性がありました。plain objectのみ受け付けるように修正しています。既知だが修正していない点: マッチする `<option>` 自体がmount時の静的な子要素ではなく、signalから後で描画される `<select>` は、選択状態が表示されないまま固まることがあります。`value` のeffectはbindingされたsignalが変わったときにしか再実行されず、`<select>` へ新しい `<option>` が追加されたことには反応しないためです。このnoteを書くまで未testかつ未記載でした。きちんと修正するにはselectの子要素list自体を監視する必要があり、ここではscope外とします。

### 2. `value`: 強制的な書き込みでもselectionを維持する

選択肢1では書き込みを避けられない場合(派生値のcase)、書き込み前に `selectionStart`/`selectionEnd` を取得し、書き込み後に復元します。要素がfocusされているときに限ります。

利点は、選択肢1では解決しない派生値のcaseにもcaret維持を広げられることです。欠点は、`selectionStart`/`selectionEnd` がすべてのinput `type`(`number`、`date`、`color` など)に存在するわけではなく、throwするかnullを返すため、type単位のguardが実装に必要なことです。IME composition中にselectionを復元すると、それ自体がcompositionを壊しかねないため、これは選択肢1のidentity checkの隣に置くのではなく、組み合わせて動作する必要があります。

### 3. `checked`: `disabled` と同じモデルでdirect bindingする

caret用のguardなしで、既存のper-prop-name allowlistに `checked` を追加します。checkboxとradioには失うべきselection状態がそもそもありません。

利点は、既存の `disabled` bindingと機構的に同一であることです。興味深い失敗モードである、per-optionの独立した `computed` signalに支えられたradio groupで、1つを選択すると他がuncheckされる必要がある、というcaseも、各 `computed` が正しく `false` へ導出される限り既に正しく解決します。これはruntimeの新しい仕事ではなく、appのmodeling上の関心事です。欠点は、`value` と同様に双方向bindingであることに変わりはなく、`checked` propが同じ要素上でReact-controlledとdirect-bound双方に決してならないという同じ保証が必要で、`value` のtestをそのまま継承するのではなく専用のtestが必要なことです。

**選択肢1と同じ変更の一部として実装済みです** — その選択肢の注記を参照してください。`value` と `checked` はどちらも `isControlledTwoWayProp`/`setControlledProp` を一緒に通ります。根底にある双方向binding問題とその修正は2つのpropで同一であり、`checked` には守るべきcaretがないというだけです。`tests/react.test.tsx`(checkboxのtest。無関係な再レンダーを乗り越えることを含む)と `tests/ssr.test.tsx` でカバーしています。

### 4. `style`(粗い形): `className` と同様にobject全体をbindingする

`style={signal}` を1つのbindingとして扱い、そのeffectが解決済みのobjectをnodeへ代入します(`Object.assign(node.style, value)` など)。既存のper-prop-name modelをそのまま再利用します。

利点は、新しい追跡モデルが不要で、caretの問題もなく、上記の `value`/`checked` の判断とは独立に出荷できることです。専用のcoercion処理(unit必須のCSS propertyに対する数値、`setProperty` を要する `--custom-property` entry、前回のobjectにあり今回のobjectにはないpropertyを、上書きではなくきちんとclearすること)は必要ですが、それ自体で閉じています。欠点は、より書き味の良い `style={{ color: signal }}` というper-property形を提供しないことです。1つのCSS propertyだけをreactiveにしたい利用者も、style object全体を `computed` 経由にする必要があります。

**実装済みです。** `style` は `REACTIVE_PROP_NAMES` に加えられ、`createReactiveRef` はこれを特別扱いして `setDomProp` の代わりに(`src/runtime/jsx.ts` の)`applyStyle` を呼びます。前回renderのkey集合を保持して、新しいobjectから消えたpropertyをclearする必要があり、状態を持たない `setDomProp` の経路ではそれができないためです。`applyStyle` は、CSS propertyが小さなunitless allowlist(Reactの一覧のうち共通する部分に合わせています)に含まれない限り、bindingされた数値に `px` を付け、`--custom-property` entryは `setProperty` を通じて書き込み、前回のstyle objectにはあり今回にはないkeyをclearします。背景sectionで述べた通り `.style` はSVGやMathML要素にも一様に存在しますが、scopeは他のallowlistと同じくHTML hostのみに留めました。非HTML hostへのdirect `style` bindingの拡張は、この変更に含めず、別途後で判断することとして残しています。`tests/react.test.tsx`、`tests/ssr.test.tsx`、`tests/jsx-types.tsx` の型levelのtestでカバーしています。

### 5. `style`(fine-grainedな形): style object内部にnestされたsignalを追跡する

JSX transformの境界(`transformProps` または隣接するhelper)で、`style` object内のvalueとしてsignalを検出し、それぞれのentryを個別のeffectとしてbindingします。signalではない通常のentryは、どのeffectにも触れられずobject propertyのまま残ります。

利点は、Solid的なAPIが提供する書き味に最も近づけることと、背景section で述べた通り、`.style` はHTML・SVG・MathMLで一様に存在するため、`setDomProp` の他の部分が抱えるSVG/MathML除外が不要になることです。欠点は、`isReactiveHostProp` が今日は最上位のprop valueしか見ておらず、object literalの1階層内側まで見に行くのは異なる形のtransformであること、signalとsignalでないentryが混在するstyle objectに対する専用testが必要なこと、そしてrenderをまたいで `style` prop全体が異なる形のobjectへ差し替わった場合の扱いを決める必要があることです。「host propがbindingされているかどうかは要素の生存期間中固定する」という既存の制約に相当するものが、render間でstyle objectへentryが追加・削除されるcaseにも必要になります。

### 6. まず `checked` と粗い `style` を出荷し、`value` とfine-grainedな `style` は保留する

選択肢3と4をそれぞれ独立した変更として進めます。どちらも `value` が抱えるcaret/compositionのriskや、fine-grainedな `style` が必要とするtransformの形の変更を伴わないためです。`value`(選択肢1・2)とfine-grainedな `style`(選択肢5)は、別途scopeするfollow-upとして後で再検討します。

利点は、除外listのうち難しくない半分を、難しい半分に足を引っ張られず届けられることと、`value` のcaret維持戦略を確定させる前に、`checked` と `style` のbindingを実際に使ってもらえることです。欠点は、この検討のそもそもの動機であるcase、つまりtext `<input>` の `value` が、後の判断が下るまでleaf component patternを必要とし続けることです。

**この選択肢は上書きされました。** このdocsの以前の版は、選択肢3を選択肢4と一緒に先に出荷する「難しくない半分」としてまとめ、`value` は後回しにしていました。`checked` には守るべきcaretがそもそもないため、双方向bindingの問題を丸ごと回避できるという前提でした。レビューでこの理屈が不完全だと判明しました。`checked` は `value` と同じReact reconciliationの仕組みに制御されているため(「この3つが既存のallowlistより難しい理由」参照)、目標sectionのprop処理戦略の変更なしに `checked` だけを出荷していたら、caret/IMEの複雑さが上乗せされないだけで同じ競合を引き継いでいたはずです。そのことが明らかになると、prop処理戦略の変更(controlled propを本当に取り除き、代わりに `defaultValue`/`defaultChecked` を使う)は、`checked` に適用するのと `value` に適用するのとで難易度が変わらないことが分かりました ―― 本当に難しいまま残るのは選択肢2のcaret固有の作業であって、reconciliationの修正そのものではありません。そのため `style`(選択肢4)、`value`/`checked` のwrite-skip guard(選択肢1)、`checked` 自体のbinding(選択肢3)、そして目標sectionのprop処理戦略の変更は、すべて一緒に出荷されました。未決定のまま残っているのは、派生 `value` のcaret維持(選択肢2)とfine-grainedな `style`(選択肢5)だけです。

### 7. `value`・`checked`・`style` を除外したまま、leaf component patternを答えとして文書化する

runtimeへの変更は行いません。reactiveなpropを専用のcomponentへ切り出す(`TaskRow` がtask listで既に示しているpattern)ことを、親を再レンダーさせずに変化の速いsignalを扱う、サポートされた方法として文書化します。

利点は、新しいcaret・composition・controlled/uncontrolledのedge caseをtestする必要がなく、このpatternは既にこのrepository自身の例で実証済みであることです。欠点は、direct bindingの他の部分にはないergonomicsの隙間が残ることです。利用者は、`value`/`checked`/`style` に限ってはcomponent切り出しに頼る必要があることを、JSXの型からの手がかりなしに、自分で知っていなければなりません。

**採用しませんでした**。未出荷のまま残っている部分(派生 `value` のcaretとfine-grainedな `style`)、およびallowlistに完全に含まれないホストpropに対する、変わらぬ答えとしてのみ残ります。

## 判断基準

採用する選択肢には、少なくとも次の実行可能なtestが必要です。出荷済みのものには印を付けています。それ以外は、未決定の作業(派生 `value` のcaretとfine-grainedな `style`)に引き続き当てはまります。

- ✅ direct-bindingされた `<input value={signal} onChange={...} />` へ入力してもcaretが動かないこと。同じ値のechoについて(`tests/react.test.tsx`)。派生・正規化された値(選択肢2)は、その選択肢を出荷していないためカバーしていません。
- IME compositionの一連(`compositionstart` → `compositionupdate` → `compositionend`)が、composition中に同じsignalの別の購読者が書き戻しても壊れずに完了すること ―― カバーしていません。jsdomにはnativeなIME composition simulationがないため、実ブラウザでのtest(`pnpm test:browser` を参照)か、手作りのcomposition event列のどちらかが必要です。
- ✅ `value`/`checked` へのdirect writeそれ自体が、native `input`/`change` eventを発火しないこと(`tests/react.test.tsx` の各caseに暗黙的に含まれています。どのtestもeffect自身の書き込みによる余分な `onChange` 呼び出しを観測していません)。
- ✅(留保付き)所有componentの無関係な再レンダーが、direct-bindingされた `value`/`checked` 要素をReactに戻させず、caretも乱さないこと(`tests/react.test.tsx` の「does not let an unrelated re-render move the caret...」)。留保: そのtestをpeek-and-substitute方式(目標sectionのprop処理戦略の変更なし)に対して差分実行しても、同様に失敗しませんでした ―― 選択肢1の実装済み注記を参照。prop処理戦略の変更は、「この3つが難しい理由」で述べた構造的な理由から残しており、このtestが必要性を証明しているからではありません。
- per-optionの独立した `computed` signalに支えられた `type="radio"` groupで、`checked` のdirect bindingが兄弟を正しくuncheckすること ―― 明示的なtestではまだカバーしていませんが、選択肢3の理屈は変わらず当てはまります。
- ✅ SSRでrenderされた `value`/`checked`/`style`(`.peek()` から)が、clientの初回paintのDOM状態と完全に一致すること。hydration後に実際のDOM propertyを読んで確認します(`tests/ssr.test.tsx`)。
- React 19 Strict Modeのdev-mode double-invokeで、refのeffectがfocus・caret・進行中のIME compositionを失わないこと ―— `value`/`checked` のtestをStrict Modeで包んだ明示的な版ではまだカバーしていません。
- ✅ `style` のcoercion。unit不要と必須が混在する数値CSS property、`--custom-property` entry、前回のstyle objectにはあり今回にはないproperty(`tests/react.test.tsx`)。
- fine-grainedな `style` 追跡を出荷する場合: signalとsignalでないentryが混在するstyle objectで、値が変わったsignalのentryだけが更新され、兄弟propertyは触れられないこと ―― 該当なし。選択肢5は出荷していません。

## 現在の推奨

`style`(粗い形、選択肢4)、そして目標sectionのprop処理戦略の変更と合わせた `value`/`checked`(選択肢1・3)は出荷済みです。direct bindingの対象外として残っているのは、派生 `value` のcaret維持(選択肢2)とper-property単位のfine-grainedな `style` 追跡(選択肢5)で、どちらも未決定であり、`TaskRow` が示すleaf component切り出しpatternが、どちらのcaseに対しても、またallowlistに完全に含まれないホストpropに対しても、引き続き答えです。この検討のそもそもの動機であるcase ―― `home.tsx` の新規task入力のtext `<input>` の `value` ―― は直っています。そのinputは現在 `value={newTitle}` というdirect bindingの形を使っており、typing中も無関係な再レンダーをまたいでもcaretが動かないことを実際のブラウザで確認済みです。このdocsは、`value`/`checked` の一般的なcaseについては「leaf componentへ切り出す」と「allowlistを拡張する」を天秤にかける必要がもうありません。残る2つの未決事項については、引き続き必要です。
