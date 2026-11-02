# managedの追跡範囲を狭めるかの判断材料

- 基準: `3d24005`（main）
- 対象: `packages/unplugin-react-fine-grained-signals`の`transform: "managed"`。README「Managed tracking contract」（234〜260行）と`src/internal/transform.ts`
- 目的: managedの推論を、Vue/Solidのような覚えられる構文上の契約へ狭めるか、今の推論を続けるかを決める。この文書は判断材料で、コードとテストは変更していない。

## 要点

1. **alias（値の流れ）の推論が効くのはdeep signalだけ。** `signal()`はshallowなので、`.value`を読んだ場所が捕捉されていれば、その値をどこへ流しても追跡は変わらない（再renderで計算し直すため）。aliasが要るのは、`deepSignal`などのproxyを局所変数に取り出して、あとからそのpropertyを読む場合だけ。
2. **狭めた契約（下のN）は、Vue/Solidより厳しくなる。** Vueが「追跡が切れる」と書いているのは、primitiveを取り出した場合だけ。nestedなobjectは取り出してもproxyのままで、runtimeが追跡する。Solidのstoreも、JSX内で読めば追跡される。Nでは、取り出したproxyのproperty readも追跡されない。つまりNは「Vue/Solid並み」ではなく、より厳しい契約になる。
3. **保留中の5件のうち、Nで消えるのはalias由来の2件だけ。** その2件も「追跡しない」と決めるだけで、直るわけではない。残り3件（`st.value.a = 2`、`<theme.value.Icon />`、class field）は構文上の問題で、どちらの契約でも直す必要がある。
4. **影響はテストの一部に集中する。**
   - 既存テスト。`react-execution`はNで24件、Cで19件が変わる（内訳は§3.2の表）。`transform.test.ts`はNで7件、Cで4件。
   - read-shapes。112件中、変わるのは「an object getter」の1件だけ。
   - 一方で、read-shapesとruntime differentialはdeep signalを1件も使っていない。alias推論の誤りは、今の網の外にある。
5. **推奨: v0.4.0は今の契約で出す。** 5件は今の契約の中で直す。あわせてdeep signalのalias caseをread-shapesに加え、oracleと比較する。狭める判断はそのあとの版に回す。理由は§6。

## 1. 推論機能の一覧

### 1.1 値の流れ（alias）の推論

「頻度」は実際のReactコードでの出現頻度の**見積もり（判断）**で、計測ではない。deep signalを使うコードを前提にしている。

| # | 機能 | 例 | READMEの行 | 実装 | テスト | 頻度（判断） |
|---|---|---|---|---|---|---|
| A1 | `const`の識別子alias | `const user = state.value.user; user.name` | Aliases | `collectTrackedReadAliases`のVariableDeclarator（5307-5313）、`hasTrackedReadInMemberChain`（3727）、`isTrackedAliasReference`（3806） | exec 88、1294。transform 4099 | 高い |
| A2 | 式の中のalias（`u as T`、`flag ? u : x`、`[u]`、`{ u }`、`u ?? {}`、`show(u)`） | `show(flag ? u : other)` | Aliases | `computeTrackedReadInExpression`のIdentifier visitor（3793-3801） | exec T1 3084（12行） | 中 |
| A3 | 単純な`const` object分割代入の静的展開 | `const { user: { profile } } = state.value; profile.name` | 2行目 | `expandTrackedObjectDestructuring`（6398-6459）、`getStaticConstDestructuredBindings`（3045-3081）、`applyManaged`のloop（6530-6534） | transform 4075、4123、4148。exec 1116、1194、1226、1260、1331、1355、1395、1425 | 高い |
| A4 | 上記以外のpattern（default、rest、配列、`let`）を1つのcaptureで評価し、束縛をalias化 | `const [first] = state.value.items; first.name` | 2行目 | VariableDeclarator visitor（6152-6186）、`capturedDestructuring`（5944）、`patternBindings`（5165） | transform 4173 | 中 |
| A5 | 分割代入の代入式。代入式自体はcaptureし、代入先はaliasにしない（保留1） | `({ user } = state.value)` | 2行目（「evaluated as authored」） | AssignmentExpression visitor（6206、6232） | transform 4207、4231 | 低い |
| A6 | あとから代入される`let`のalias | `let items; items = state.value.items;` | Named functions…行の「a `let` alias assigned later」 | collectorのAssignmentExpression（5314-5322）。`??=`、`\|\|=`、`&&=`も含む | exec 2567、3893、3806の1行 | 中〜低 |
| A7 | 要素代入で容器がaliasになる | `box[0] = task` | Aliases | `containerRoot`（5279-5287）、5323-5325 | exec 3116 | 低い |
| A8 | `push`/`unshift`/`add`/`set`で容器がaliasになる | `for (const t of tasks) visible.push(t)` | Aliases | `container`（5288-5302） | exec 3104、3806 | 中（JSXの配列を組み立てるloopで見かける） |
| A9 | for...ofのloop変数のalias | `for (const task of state.value.tasks) task.title` | Reads inside…行 | collectorのForOfStatement（5328-5338）、capture側の再登録（6105-6111）。代入形のloop head（`for ({ row } of …)`）は対象外（保留2） | exec 2065、2567。transform 4303 | 中〜高 |
| A10 | 読むhelperの戻り値のalias | `const t = getTask(); t.title` | Aliases（「the result of a capturing helper call」） | `scanSource`の`call`（5228-5233）、`resolvedCallReads`（5196） | exec 3092 | 中 |
| A11 | object literalのgetterが読むと、objectがaliasになる | `const view = { get d() { return s.value * 2 } }; view.d` | Named functions…行 | `scanSource`のgetter処理（5234-5249） | exec 2567、T2の1行（3160）。read-shapes「an object getter」 | 低い |
| A12 | 局所helperの本体が呼び出し元のaliasを読む | `const items = state.value.items; const text = () => items[0].title; text()` | Synchronous helper call | `targetAliasGraphMayRead`（4981-5032）、`resolvedCallMayReadTrackedValue`（5034-5059） | exec 338、3886 | 中〜低 |
| A13 | Hookの引数に渡したaliasは読みとして扱わない | `useState(u)` | Hook calls…行 | `isTrackedAliasReference`（3812-3819） | exec 4220 | 中 |
| A14 | auto選択で、aliasの定義がreadを含むかどうか（dry run） | A1と同じ | auto選択の段落 | `aliasCarriesRead`/`referencesReadingAlias`（5679-5706） | selection-capture-consistency経由 | （内部） |

### 1.2 構文で決まる規則（どちらの案でも残す）

| # | 機能 | 例 | 実装 | 頻度（判断） |
|---|---|---|---|---|
| S1 | `.value`とそこから続くchain | `state.value.user.name`、`rows.value.map(cb)` | `visitMember`（5972）、`isTrackedValueRead`（2145） | 非常に高い |
| S2 | trackedな引数を受け取るcall、読むinline callback、IIFE | `JSON.stringify(state.value.p)`、`items.filter((i) => i.done.value)` | `visitCall`（5820）、`callReadsTrackedValue`（5525） | 高い |
| S3 | 同じmoduleのhelperの本体（推移的に） | `{total()}` | `cachedTargetMayRead`（5066）、`targetFunctionMayReadTrackedValue`（5102） | 高い |
| S4 | `in`、object/array/JSX spread、強制型変換、template literal | `"k" in state.value.p`、`<p {...s.value} />` | BinaryExpression、ObjectExpression、JSXSpreadAttribute、TemplateLiteralの各visitor | 中 |
| S5 | 更新、複合代入、論理代入、`delete` | `count.value++`、`state.value.n ??= 1` | UpdateExpression、AssignmentExpression、UnaryExpression | 中 |
| S6 | for...of/for...inのsourceのiteration | `for (const x of list.value)` | ForOfStatement、ForInStatement（6021-6151） | 高い |
| S7 | Hookを基点にしたchainの分割 | `useStore().value.name` | `wrapAfterHookBase`（5870）、`splitHookBase` | 中 |
| S8 | runtime keyの予防capture | `sig[key]` | `isPotentialDynamicMemberRead`（2200） | 低い |

### 1.3 呼び出し先の証明（別の軸）

解決できない呼び出しは予防としてcaptureし、組み込み名のmethodは、所有するdata（props、state）に対するものだけ省く。この「proven callee/ownership」は4103〜4960行付近の約850行ある（M17.7）。値の流れの推論とは別の軸で、誤ると取りこぼしではなく余分なcaptureになる。

この文書の案では変えない。それでも狭めるなら選択肢は2つある。

- **すべてcaptureする。** Hook以外の呼び出しをすべてcaptureし、ownershipを削除する。挙動は単純になるが、capture数が増える。M17.7では、propsへの組み込みcallが401件から1件に減っている。性能への影響は計測していない。
- **証明できたものだけcaptureする。** 本体が読むと証明できた呼び出しだけをcaptureする。importしたhelperの読みが黙って追跡されなくなるので、勧めない。

## 2. 狭めた契約の案

### 案N（構文だけで決める）

1. **readの位置。** `.value`のmember読み取りを、componentの同期renderコードで評価したもの。書き方は`.value`、`["value"]`、定数文字列のkeyのどれでもよい。同期renderコードには本体、parameter default、JSXのtagとattributeを含む。入れ子の関数とclass bodyは含まない（4.を除く）。
2. **captureする単位。** readとそこから続くchain（member、そこへのcall、`?.`、`!`、`as`）。それに加えて、同じ式の中で値を消費するいちばん内側の演算も含める。
   - call/newの引数
   - `in`の右辺、spread、強制型変換、template literal
   - 代入先のchainに`.value`を含む更新、複合代入、論理代入、`delete`
   - 右辺がreadを含む分割代入の宣言と代入式（patternをcaptureの中で評価する）
   - sourceがreadを含むfor...of/for...in（分割代入のloop headはcaptureの中で評価する）
3. **値は追跡を運ばない。** 2.の式から取り出した束縛はただの値として扱う。対象は、`const`、分割代入した名前、loop変数、あとから代入する`let`、`push`や要素代入で受け取った配列やobject、helperの戻り値。それを通じた後のreadはcaptureしない。signal object自体の別名（`const t = s; t.value`）は`.value`を書くので追跡される。
4. **読む呼び出し。**
   - inline callbackまたはIIFEの本体が1.のreadを含むなら、その呼び出しをcaptureする。
   - 同じmoduleの、再代入されない関数（局所、module、object literalのmethod）の本体が、推移的に1.のreadを含むか、captureされる呼び出しをするなら、その呼び出しをcaptureする。
   - 再代入されない局所またはmoduleの`const` object literalのgetterも、ここに含める。これを外すと、A11はshallow signalでも黙って追跡されなくなり、警告もできないため。
   - 呼び出し元のaliasを読むclosure（A12）は数えない。
5. **変えないもの。** 解決できない呼び出しの予防capture、ownership、async、generator、event handler、Hookのcallback、timer、`untracked`、`.peek()`、RFGS001〜004。
6. **警告（RFGS010の候補）。** 3.の束縛が、その後のrenderでmember読み取り、iteration、spread、`in`、call引数に使われたら警告する。transformには型がないので、deepかshallowかは分からない。そこで2段階にする。
   - 同じmoduleで`deepSignal`、`deepCollectionSignal`、`useDeepSignal`、`useDeepCollectionSignal`から作ったと証明できるsignalなら警告する。
   - それ以外（importしたstoreなど）は警告しない。全部に警告すると、objectを持つshallow signalで誤検出になる。

利用者向けの1文の説明は次のとおり。

> 「renderで`.value`を書いた式は、その式の中で起きる読み取りまで追跡される。取り出した値をあとで読んでも追跡されないので、`state.value.user.name`のように毎回signalから読むか、`useDeepSignalValue`で値を選ぶ」

### 案C（中間）

Nに、alias規則を1つだけ戻す。

- **残すalias規則。** 次の束縛はaliasとして扱い、後のrenderでの参照をすべてcaptureする（今と同じ）。
  - `const`の束縛（識別子でも、どの分割代入patternでもよい）
  - for...of/for...inのloop headで宣言した変数
  - いずれも、初期化式またはsourceが1.のreadか、別のaliasを含むもの
- **やめるもの。** `let`/`var`への代入（A6）、分割代入の代入先（A5）、代入形のloop head、容器（A7、A8）、helperの戻り値（A10）、closure（A12）、getterによるalias化（A11。Nの4.で扱う）、静的展開（A3）。静的展開は、patternを1つのcaptureで評価する形に置き換える。束縛は`const`の規則でaliasになる。

利用者向けの説明は次のとおり。

> 「`const`で受けた値とloop変数は追跡される。`let`への代入や、配列やobjectへ入れた値は追跡されない」

## 3. 影響

### 3.1 機能ごとの変化

| # | 案N | 案C | 利用者がする移行 |
|---|---|---|---|
| A1 | deepと証明できれば警告、それ以外は黙って追跡されない | 追跡（変化なし） | N: `state.value.user.name`と毎回読む |
| A2 | 警告（引数のときだけ）、それ以外は黙って追跡されない | 追跡 | N: 同上 |
| A3 | patternの読み取りは追跡。後の`profile.name`は警告/追跡されない | 追跡。出力の形だけ変わる | N: 同上、または`useDeepSignalValue` |
| A4 | A3と同じ | 追跡 | 同上 |
| A5 | 警告/追跡されない（今も束縛は追跡されないので、見かけは同じ） | 警告/追跡されない | `const`で受け直す（C）か、毎回読む |
| A6 | 黙って追跡されない（初期化のreadは追跡） | 黙って追跡されない | `const`にする |
| A7、A8 | 警告（引数として渡す場合）/追跡されない | 黙って追跡されない | loopの中でJSXを作る。`map`にする |
| A9 | 警告/追跡されない | 追跡 | N: `list.value.map(...)`にする |
| A10 | 黙って追跡されない | 黙って追跡されない | helperの中で`.value`まで読んで値を返す |
| A11 | 追跡（Nの4.に含めた場合） | 同左 | なし |
| A12 | 黙って追跡されない | 黙って追跡されない | helperに引数で渡すか、helperの中でsignalから読む |
| A13 | 例外規則が不要になる | 変化なし | なし |
| S1〜S8、1.3 | 変化なし | 変化なし | なし |

N6の警告は、deepと証明できたときしか出ない。そのため、importしたstoreを使う典型的な構成では、Nの「警告」の欄は実際には「黙って追跡されない」になる。

### 3.2 既存テストへの影響（読んで分類した。テストは変更していない）

| ファイル | 件数 | Nで変わる | Cで変わる |
|---|---|---|---|
| `react-execution.test.ts` | 124箇所（`it.each`/loopは1件と数えた） | 24件: 出力文字列だけ7、警告8（すべて同じmoduleの`deepSignal`）、黙って追跡されない9 | 19件: 出力文字列だけ11、黙って追跡されない8 |
| `transform.test.ts` | 218 | 7件: 出力1、追跡されない1（4352）、警告5（4075、4099、4123、4231、4303。`warnings`が`[]`であることを確かめている） | 4件: 出力のみ（`_trackedSource`/`_trackedNested`。4094〜4169の7箇所） |
| `diagnostics.test.ts` | 22 | 4件（IDの一覧、README表、`RFGS010`を不正とする検証、fixture）。意味論ではなく、IDが増えるため | 0 |
| `shared-predicates`、`react-compiler`、`unplugin` | 43、24、58 | 0（`react-compiler` 362は出力の形が変わるので要確認） | 0 |
| `read-shapes.ts`（`selection-capture-consistency`、`runtime-differential`が使う） | 112 | 1件（「an object getter」。Nの4.にgetterを含めれば0） | 同左 |

- **`react-execution`で変わる主なテスト。**
  - 案N: T1（3084、12行）、3092（helperの戻り値）、3104/3116（容器）、3806（5行）、2065の`task.title`、2706（for...in）、1260〜1425（分割代入したalias）。
  - 3886と3893は、もう存在しないalias解析の規模を測るテストなので、削除するか、置き換える。
  - 4220は、Hookの引数を警告の対象から外さないと`warnings`が`[]`の検証で落ちる。
  - 88と338は、別のreadが同じkeyを購読しているので、再renderの結果は変わらない。出力文字列の検証だけが落ちる。
- **出力の検証方法。** `transform.test.ts`はsnapshotを使っていない。`toContain`と正規表現で出力を確かめているので、変更は数行の局所的な修正で済む。

### 3.3 網の外にあるもの

read-shapesの112件は、shallowな`s`、`st`、`list`だけを使い、書き込みは値全体の置き換えだけ。そのため、alias推論を全部消しても、`runtime-differential`（oracleとの比較）はほとんど落ちない。

裏返すと、今のalias推論の取りこぼし（レビューで見つかってきたもの）は、どれもoracleとの比較の外にある。どちらの案を選んでも、deep signalのnestedな書き込みを含むcaseを足さない限り、契約と実装のずれを機械では検出できない。

## 4. 保留中の5件

| 指摘 | (a) 今の契約での扱い | (b) 案Nでの扱い | 案C |
|---|---|---|---|
| 1. `({ user } = state.value)` | 代入式はcaptureされるが、`user`がaliasにならない（collectorのAssignmentExpressionが識別子とmemberの左辺しか見ていない、5318-5326）。左辺がpatternなら`patternBindings`でflowを足す。数行で直る | 仕様どおり追跡しない。deepと証明できればRFGS010 | Nと同じ（代入先は`let`扱い） |
| 2. `for ({ row } of list.value)` | iterationと代入はcaptureされるが、`row`がaliasにならない（5332-5337が宣言と識別子しか見ていない）。代入形のpatternもflowに足す。数行 | 同上 | 同上 |
| 3. `st.value.a = 2`を純粋な書き込みとして扱う | `isWriteTarget`が`.value`から上へchainをたどって代入先とみなし、`st.value`のgetter readを数えない。oracle（`useSignalTracking`）は購読する。「代入先chainの途中の`.value`はreadとしてcaptureする」と決めて直すか、「render中の書き込みは追跡しない」と明記する | 同じ判断が必要（構文の問題） | 同左 |
| 4. `<theme.value.Icon />` | JSXのtagは`JSXMemberExpression`なので、`.value`として検出されない。tagを`const _Tag = capture(() => theme.value.Icon)`に取り出すなど、評価順を保つ形で直す | 同じ修正が必要（Nの1.はJSXのtagを含む） | 同左 |
| 5. class fieldの初期化式をrenderのreadと数える | 選択の誤り（余分な選択）。field初期化は`new`のときに実行されるので、class bodyを同期renderから外し、`new LocalClass()`だけを呼び出しとして扱う | 同じ修正が必要（Nの1.でclass bodyを除外） | 同左 |

狭めて消えるのは1と2だけで、それも「追跡しない」と決めるだけ。今の契約のまま直す方が、作業はむしろ小さい。

## 5. コードへの影響

`transform.ts`は6770行。

| 削除・単純化する部分 | 行（概算） | N | C |
|---|---|---|---|
| `collectTrackedReadAliases`、`patternBindings` | 5162-5348（約190） | 削除 | 約60行に縮小（`const`とloop headだけ） |
| `expandTrackedObjectDestructuring`、`getStaticConstDestructuredBindings`、`applyManaged`のloop | 6385-6459、3045-3081、6530-6534（約120） | 削除 | 削除 |
| `targetAliasGraphMayRead`、`resolvedCallMayReadTrackedValue`、cache | 4958-5059の一部（約90） | 削除 | 削除 |
| dry runのalias判定（`aliasCarriesRead`ほか） | 5676-5706（約30） | 削除 | 残す |
| `isTrackedAliasReference`、`hasTrackedReadInMemberChain`/`computeTrackedReadInExpression`のalias分岐、alias集合ごとのcache | 3709-3822の一部（約40） | 削除・単純化 | 残す |
| for...ofのalias再登録 | 6105-6111 | 削除 | 残す |
| `trackedAliases`引数（約15関数に渡している） | 全体 | 削除 | 残す |
| 新規: RFGS010（deepの証明と後続の使用の検出） | — | 約+80〜120 | 不要 |

- **合計。** Nで純減約350〜450行（約6%）、Cで約250行。
- **残る複雑さ。** いちばん大きい複雑さは、ownershipとcalleeの証明（約850行）、keyed slot、render callbackの検出、選択（`inspectFunction`/`scanFunction`）にある。Nにしても`transform.ts`の9割以上は残る。
- **テストへのリスク。**
  - `selection-capture-consistency`は、captureとselectionが同じpass（dry run）を使うので、alias部分を消しても整合性は保ちやすい。
  - `runtime-differential`は、§3.3のとおりaliasのcaseを持たないので、ほぼ影響しない。
  - その代わり、Nにすると、oracle（ページ全体を追跡）との差が増える。deepのcaseを足すときは、`exception`に「README: 取り出した値は追跡しない」を大量に書くことになる。

## 6. 推奨

**v0.4.0は今の契約で出し、5件はその中で直す。** あわせて次を行う。

1. read-shapesにdeep signalのcase（A1〜A12の各1件。nestedな書き込みで再renderするか）を足し、`runtime-differential`でoracleと比べる。これで、今後のレビューで見つかってきた種類の漏れを機械で検出できるようにする。
2. READMEの「Managed tracking contract」の冒頭に、短い保証を置く。
   - 「`.value`を書いた式」と「`const`/loop変数で受けた値」は追跡する。
   - それ以外の流れ（`let`、容器、helperの戻り値）は、できる範囲で追う。
3. 狭める判断は、1.の網を入れたあとの版で、漏れの出方を見て決める。その時点の候補は案C。

理由:

- **狭めると黙って壊れる。** v0.3.0はalias推論込みで公開している（M17の「Destructuring / aliases」行）。案N/Cは、v0.3の利用者の分割代入やloop変数を、エラーも警告もなく追跡しない形に変える。警告は、同じmoduleで作ったdeep signalにしか出せない。breaking changeとして一番見つけにくい種類になる。
- **比較対象より厳しくなる。** Vueは、nested objectを取り出しても追跡する。Solidのstoreも、JSX内で読めば追跡する。案Nは「覚えやすい」が、利用者の期待（Vue/Solid、MobX/Valtioのrender全体の追跡）より狭い。案Cなら、`const`とloop変数でこの差を埋められる。
- **5件の解決にならない。** 構文上の3件は残る。alias由来の2件は、今の契約でも数行で直る。
- **コード削減は限定的。** Nで約6%。複雑さの中心（calleeの証明、選択）は残る。

不確かな点:

- **レビューで漏れが見つかり続ける根本の問題は残る。** 推論の対象はJSの任意のdata flowで、閉じた集合ではない。今の契約を続けると、同種の指摘はこれからも出る。1.の網で減らせるかどうかは、まだ分からない。
- **頻度の見積もりはすべて判断。** deep signalを局所変数へ取り出す書き方が、実際の利用者コードでどれだけあるかは測っていない。examplesと利用者コードで数えれば、案Cの`let`/容器を落とす影響を見積もれる。
- **案Cでv0.4.0を出す手もある。** 落とすのは`let`、容器、helperの戻り値、closure、代入先だけで、利用は少ないと見ている。v0.4.0がbreaking changeを許すなら、これは十分に成り立つ選択肢。ただし黙って壊れる点は同じなので、リリースノートに具体例を載せる必要がある。

## 参考

- 比較対象の挙動（2026-11-02に確認）
  - Preact Signals: `@preact/signals-react-transform` 0.8.3のREADME（`node_modules/@preact/signals-react-transform/README.md`の54〜64行）。component本体を`useSignals()`の結果と`try { ... } finally { f() }`で囲み、render全体の読み取りを実行時に追跡する。
  - Vue: [Reactivity Fundamentals, Limitations of `reactive()`](https://vuejs.org/guide/essentials/reactivity-fundamentals.html)。「Not destructure-friendly: when we destructure a reactive object's primitive type property into local variables, or when we pass that property into a function, we will lose the reactivity connection」。対象はprimitiveのpropertyに限られる。
  - Solid: [Props](https://docs.solidjs.com/concepts/components/props)。「destructuring props is not recommended as it can break reactivity」。代わりに`props.name`で直接読むか、`splitProps`を使う。storeのnested proxyをJSX内で読めば追跡される点は**記憶による**（未確認）。
  - MobX（`observer`）とValtio（`useSnapshot`）がrender全体を実行時に追跡する点は、**記憶による**。
- try/finallyをやめた経緯: [v0.3.0 M3](../v0.3.0/m3-react-tracking-audit.ja.md)（17〜19行、74行）、[M17](../v0.3.0/m17-api-scope-decision.ja.md)
- callee証明の規則: [v0.3.0 M17.7](../v0.3.0/m17.7-ownership-call-resolution.ja.md)

## 判断（2026-11-02）

メンテナの判断で、v0.4.0は今の契約で出す。保留中の5件は今の契約の中で直し、deep signalのalias caseをread-shapesに加えて、consistencyとruntime differentialで確かめる。狭めるかどうかは、その結果を見てから次の版で決める。

比較の補足: `.value`を使うAPIどうしでは、Vueの`ref`（中のobjectを`reactive`にする）が`deepSignal`に、`shallowRef`が`signal()`に当たる。Vueの`ref`では、render中に`const user = state.value.user; user.name`と取り出して読んでも、runtimeが追跡する。狭めた契約（案N）ではこの書き方が追跡されなくなるため、Vueより厳しくなる。
