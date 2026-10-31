# unplugin-react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

[`react-fine-grained-signals`](https://www.npmjs.com/package/react-fine-grained-signals)
向けの、自動render trackingとmanaged per-read captureを提供する汎用bundler
integrationです。

このpackageは意図的に唯一のbuild-time integrationです。Babel実装は内部に
閉じ込め、利用側はbundlerごとのentry pointだけを設定します。

## インストール

```sh
pnpm add react-fine-grained-signals
pnpm add -D unplugin-react-fine-grained-signals
```

両packageの同じ`0.4.x` release lineをinstallしてください。v0.3.x以前を以下のv0.4.0向け設定と組み合わせないでください。

`react-fine-grained-signals` はpeer dependencyです。Node.jsは
`^22.18.0 || >=24.11.0` が必要です。変換が依存するBabel 8が宣言している範囲です。

pluginとruntimeは同じrelease line(0.4.x同士)で使ってください。生成されるコードが
importするruntimeのentry pointはline間で変わります。v0.1からupgradeする場合は、
両方のpackageを同時に更新し、`@useSignals` / `@noUseSignals` commentを書き換えて
ください。[v0.2移行ガイド](https://github.com/sakzw/react-fine-grained-signals/blob/main/docs/migration/v0.2.ja.md#transform-plugin)を参照してください。

このpackageはESMだけを配布しており、CommonJS buildはありません。`import` を
使うESMのbuild設定が基本ですが、CommonJSの設定ファイル（`"type": "module"` の
ないprojectの `webpack.config.js` や `next.config.js`）からも `require()` で
読み込めます。上記の範囲のNode.jsはすべて、組み込みの `require(esm)` によって
ESMのentry pointを読み込むためです。plugin factoryは `default` exportです。

```js
const signals = require("unplugin-react-fine-grained-signals/webpack").default;
```

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

### React Compilerと併用する場合

React Compilerはこの変換の *後* に実行される必要があります。そうでないと、
このpluginがcomponentに `"use no memo"` を付ける前に、compilerが `.value` の
読み取りをmemoizationで消してしまい、そのcomponentは最初のrender以降、無言で
更新されなくなります。compilerを実行するpluginより前に `signals()` を
listしてください。

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" }), react({ compiler: true })],
});
```

検証した構成（Vite 8、`@vitejs/plugin-react` 6.1）では、
`react({ compiler: true })` にはplugin-reactのoptionalな
`oxc-transform-react` packageも必要です。`babel-plugin-react-compiler` と
一緒にinstallしてください。ない場合、buildはplugin-react自身の
「optionalな `oxc-transform-react` packageが必要」というerrorで止まります。

Viteでは、この順序をhookのレベルでも守っています。pluginは `enforce: "pre"`
で、さらに `transform` hookが `order: "pre"` を宣言しており、Viteは
`enforce: "pre"` のgroupの中でこの値に基づいて並べ替えます。そのため、
`react()` を先にlistした場合でも、`@vitejs/plugin-react` 6のcompiler step
（`react({ compiler: true })`。それ自体は `enforce: "pre"` でhookの `order` は
なし）より先に実行されます。以前はこの順序だとcomponentが先にcompileされて
いました。ただしこれはViteの並び順の規則であって、絶対的な保証ではありません。
transformで同じく `order: "pre"` を宣言し、より前にlistされたpluginは、
やはり先に実行されます。したがって `signals()` を先頭に置く構成が引き続き
推奨であり、hookの順序が効かない場合は必須です。Rollupは配列内の位置だけで
順序を決めますし、Babel経由の構成（`@rolldown/plugin-babel` と
`reactCompilerPreset()`）はこのpluginとの組み合わせで検証していません。

React Compilerとの組み合わせには、次の2つの既知の制約があります。どちらも
v0.1.1から存在するものです。

- **inlineのrender helperがcompilerにmemoizeされることがある。** このplugin
  が呼び出し元のrenderの一部として扱う関数には、独自のboundaryも
  `"use no memo"` も付きません。例は、通常の関数として呼び出すPascalCaseの
  helper（`Title()`）や、`items.map(Row)` のようなrender callbackです。React
  Compilerはそのhelper単体をcompileすることがあります。helperのJSXに、
  compilerから見える依存がない場合（module scopeのsignalの読み取りは依存に
  なりません）、compilerはそのJSXをcacheし、呼び出し元のcomponentが再render
  してもhelperの出力は古いままになります。helperの本体に `"use no memo"` を
  書くか、componentとして（`<Title />`）renderしてください。
- **作者が書いた `"use memo"` はそのまま残る。** すでにmemoizationの
  directiveを持つ関数には、pluginは `"use no memo"` を追加しません。
  `babel-plugin-react-compiler` 1.0で確認した動作は次のとおりです。
  - managed変換では、作者指定の `"use memo"` を維持し、統合testで複数回の
    signal更新を追跡できることを確認しています。明示的にmemoizationを選んだ
    関数には、transformは `"use no memo"` を追加しません。
  - `transform: "inject"` では、compilerがその関数をcompileし、signalの
    読み取りをmemoizationで消してしまうことがあるため、componentが更新され
    なくなることがあります。

  React Compilerとの併用ではmanaged transformを推奨します。inject modeは
  best-effortな追跡であり、compilerがsignal readをmemoizationで除去すると
  更新されない場合があります。

## その他のbundler

対応するentry pointを同様の要領で使用します。

| Bundler | Entry point |
| --- | --- |
| Rollup | `unplugin-react-fine-grained-signals/rollup` |
| Webpack | `unplugin-react-fine-grained-signals/webpack` |
| Rspack | `unplugin-react-fine-grained-signals/rspack` |
| esbuild | `unplugin-react-fine-grained-signals/esbuild` |

```ts
import signals from "unplugin-react-fine-grained-signals/webpack";

export default {
  plugins: [signals({ mode: "auto" })],
};
```

## オプション

- `mode`
  - `"manual"`: 先頭文にあるimport済みの `useSignalTracking()`、または
    `@signalTracking` を付けた名前付きcomponent/custom hookだけを変換します。
    `importSource` からdirect importしたHook呼び出しはどちらのmodeでもambientのまま
    残ります。managedはper-read captureが扱えないdeep-proxy readも追跡できるよう、
    明示Hookを維持します。注釈によるopt-inは選択した変換方式を使います。barrel経由の
    呼び出しも関数を選択できますが、re-exportを検証できないためambientのまま残ります。
  - `"auto"`（既定）: さらに `.value` を読む名前付きJSX componentと
    名前付き `useX` custom hookを変換します。
  - `"all"`: さらに変換可能な名前付きJSX componentを選びます。認識対象の
    同期的なarray render callback内のreadはownerが収集できますが、callback自体は
    変換しません。JSX render propや`children` callbackのreadはcaptureを保証しません。
- `transform`
  - `"managed"`（既定・推奨）: top-levelに `useSignalCapture()` を追加し、静的に
    証明できる同期的signal readを短いcapture scopeで囲みます。生成コードはuser Hookを
    `try` / `finally` 内へ移しません。
  - `"inject"`（サポートされた高度・互換性向けmode）: best-effortなopt-in向けに
    変換なしの `useSignalTracking()` を追加します。制御フローを書き換えず、通常の
    `useSignalTracking()` を先頭hookとして挿入するため、手書きと同じbest-effort
    境界になります。この
    modeが露呈し得るsibling誤帰属の既知の制約については、
    [境界設計の検討docs](../../development/design/use-signals-boundary-design.ja.md)
    を参照してください。
- `reactCompiler`
  - `"opt-out"`（既定）: 変換したすべての関数に `"use no memo"` を付け、render
    trackingが必要とするsignal読み取りをReact Compilerがmemoizationで
    消さないようにします。付けない場合、compile済みcomponentはJSXをcacheし、
    最初のsignal書き込み以降、無言で更新が止まります。
  - `"off"`: directiveを付けません。React Compilerをbuildで使っていない場合か、
    対象componentを[互換性の検討docs](../../development/design/react-compiler-compatibility.ja.md)
    に照らして確認済みの場合だけ選んでください。
- `importSource`: `react-fine-grained-signals` 互換wrapperへの置き換えです。
  wrapperは、生成されたコードがimportするruntimeのrootの `useSignalTracking` と、
  `/internal` entryの `useSignalCapture` をre-exportしている必要があります。`/internal` は生成コード専用で、semverの対象外です。
- `reactImportSource`: wrapされた関数をcomponentと判定する際に、`memo` /
  `forwardRef` をReact由来とみなすmodule specifierを追加します。置き換えでは
  なく追加であり、`"react"` からのdirect importは常に認識されます。つまり
  設定しても既存のdirect importの認識が外れることはありません。
- `include` / `exclude`: source module IDを絞ります。`RegExp`、述語関数
  `(id) => boolean`、またはそれらの配列を受け取ります。配列はどれか1つが一致すれば
  一致とみなすため、空の `include` 配列は何にも一致しません。判定にはbundlerが渡した
  そのままのID（queryを含み、path区切りもbundlerのまま）を使います。`exclude` が
  `include` より優先され、`node_modules` と `\0` で始まるvirtual moduleは常に対象外です。
  文字列やglobは受け付けません。文字列を渡すとplugin作成時に `TypeError` になるので、
  `"src/components/**"` ではなく `/\/src\/components\//` のように書いてください。
  型は `ReactFineGrainedSignalsFilterPattern` としてexportされています。
- `diagnostics.errorOn`: build errorに昇格させる診断ID（例: `["RFGS001", "RFGS003"]`）の配列です。
  それ以外の診断は従来どおりwarningのままです。transform出力は、どちらでも同じです。未知のIDは
  plugin作成時に例外になります。詳細は[診断](#診断)を参照してください。

## 診断

各warningには安定したIDが付きます。IDはwarning本文の先頭（`[react-fine-grained-signals] RFGS003: ...`）と、
bundlerへ渡すwarningの `diagnosticId` に入ります。共通の `code: "RFGS"` は変わりません。既存のwarningは
このIDの接頭辞を除けば本文を保ち、Hook系のwarningも他と同じくcode frameを含むようになりました。

| ID | カテゴリ |
| --- | --- |
| `RFGS001` | Hookが、signal readを含む式の中にあるか、readだけを行う呼び出しと同じ呼び出しを共有しています。 |
| `RFGS002` | 呼び出された関数がHookを呼び、render内でsignalを読んでいます。 |
| `RFGS003` | JSX render propや `children` callbackがsignalを読み、所有者を証明できません。 |
| `RFGS004` | 関数の引数初期化子に、まだ `.value` の読み取りが残っています。 |
| `RFGS005` | `useSignalTracking()` が、barrel/re-export moduleを経由してしか解決できません。 |
| `RFGS006` | `@signalTracking` の付いた関数に、boundaryを付けるcomponent/hook identityがありません。 |
| `RFGS007` | 無名の `export default` 関数で、module名からidentityを導けません。 |
| `RFGS008` | componentが通常の関数として呼ばれ、かつ `<Component />` としても描画されています。 |
| `RFGS009` | 先頭に `"use server"` directiveがあるmoduleのcomponentで、変換されません。 |

選んだIDだけをbuildのerrorにする例:

```ts
signals({
  diagnostics: { errorOn: ["RFGS001", "RFGS003"] },
});
```

昇格した診断も、元のwarningと同じsource locationとcode frameを保持します。Rollup、Vite、webpack、rspackでは
1つのmoduleで最初に昇格した診断でbuildが止まり、esbuildはすべてを報告します。

## managed tracking契約

`transform: "managed"`では、生成関数のtop-levelで`useSignalCapture()`を呼び、静的に特定された同期readをper-read capture scopeで囲みます。これはv0.2.1の関数全体を囲む`try` / `finally`より狭い契約です。任意のcallback呼び出しやmodule境界を越えるhelperの実行を推測しません。

| pattern | managedの動作 |
| --- | --- |
| 選択済み関数内の`state.value.user.name` | 1つの同期read式としてcaptureします。 |
| `const { user: { profile } } = state.value; profile.name` | static identifier key・identifier binding・nested object patternだけで構成された、空でない`const` object patternを元の順序で各readが1回になる形へ展開します。source、中間property、後続の`profile.name`をcaptureします。その他のpattern(default、rest、computed key、配列、annotation、`let`、destructuring代入、destructuringのloop head)は記述どおりの評価を1つのcapture内で行い、bindingをaliasとして追跡します。 |
| `const { value } = signal` | destructured signal accessorは追跡されません。`signal.value`と直接読んでください。 |
| 同期helper call | helper (そこから呼ぶhelper、inline callback・IIFE・局所getterの中で呼ぶhelperを含む) がtracked値を読む場合、またはこの行の規則でcaptureされるcallを行う場合、呼び出し位置でcaptureします。それ以外のcallも、calleeを証明できない限りcaptureします。calleeへの到達方法は問いません (`(flag ? a : b).total()`、`(0, a.total)()`、`getStore().map()`、`[0].map(() => a)[0].map()`はすべてcapture)。証明できるcalleeは次のとおりです: Hook・component形の名前、再代入されない局所・module関数とその場で呼ぶ関数式 (本体で判定)、標準global (`Math.max`、`JSON.stringify`、`String`、`Object.keys`) と`new Intl.NumberFormat()`のような標準classの新しいinstanceのmethod、libraryまたはReactからのimport、関数が所有するdataに対する組み込みと同名のmethod (`map`、`filter`、`toString`、`trim`など)。組み込みが呼び返す関数 (`items.map(fn)`、`label.replace(re, fn)`) も証明が必要で、inline関数・局所関数・標準globalに限ります。import、props、objectのmethodを渡した場合はcallごとcaptureします。`new C()`とtagged template (`` tag`x` ``) も同じ規則で、標準のconstructorやtag (`new Date()`、`String.raw`) だけを証明済みとし、`new Promise(executor)`はexecutorの証明も必要です。Promise executorと`async`関数 (その場で呼ぶ、名前で呼ぶ、callへ渡す) は、最初の`await`までがcall中に実行されるため本体で判定します。`await`より後のreadはrender後に実行されるため、render dependencyにはなりません。moduleが名前を再代入した関数・object、memberを差し替えたobject (`o.total = ...`、`Object.assign(o, ...)`、分割代入による書き込み、`const`の別名経由を含む) は証明済みとしません。所有するdataかどうかは値の出所で判定します: primitiveとそのliteral、componentのpropsと`useState`/`useReducer`のstate (型情報がないため証明ではなく規約として信頼します)、それらのmemberと分割代入した部分、そのdataに対して組み込みの配列methodがcallbackへ渡す要素 (`items.map((item) => item.name.trim())`)、このmoduleがそのdataだけを渡して呼ぶmodule helperの引数、組み込みmethodの結果 (`items.filter(Boolean).map(String)`)、およびこれらで初期化され再代入されない局所変数です。それ以外の配列の要素 (`[extStore][0]`、`box.pop()`) や、所有する配列へ`push`・`splice`・要素代入で入れた値は所有しません。そのほかの関数の引数 (IIFE、Hook、他の関数が呼ぶcallback、exportしたhelperや再帰するhelper) と再代入される引数、`this`、import、module-levelの値、custom Hookの結果、`reduce`の結果も所有しません。tracked aliasでない値に対して組み込みや演算子が暗黙に実行するuser code (`String(x)`や`` `${x}` ``の中の`toString`、getterやsetter、`toJSON`、`[...gen()]`などのiterator、`Symbol.species`) は追跡しません。moduleが自分で書き換えた標準global (`Math.total = fn`) も同様です。`auto`で関数を選ぶ際、import helperの中身は解析しません。readするgeneratorに対する`for (const v of gen())`はcapture内で反復します。 |
| 同期式の内部で行われるread | tracked値を読むinline callbackを持つcall (`items.filter((item) => item.done.value)`、`reduce`、IIFE)、tracked値を受け取るcall (`JSON.stringify(state.value.profile)`、局所helper)、`"key" in state.value.profile`、tracked値のobject/array spreadは式全体をcaptureし、callee内やproxy trapが後から行うreadも含めます。`for (const item of state.value.items)` はsource、iteratorの取得、loopが行う各`next()`/`return()`呼び出しをその時点でcaptureするため、早期終了、反復中の変更、遅延iterable、iterator closingは記述どおりに動作します。`item`はaliasとして追跡します。`for (const key in state.value.errors)` はnativeの`for...in`を実行して各stepをcaptureするため、key順、継承key、順番が来る前に削除されたkey、`break`、engineが呼ぶProxy trapとそのタイミングは、変換前のloopと一致します。 |
| 名前付き関数、JSX spread、getter、読み取りを伴う代入 | callに渡した名前付きの局所またはmodule関数(`items.filter(isVisible)`)はinline callbackと同じくcallごとcaptureします。`<p {...state.value.props} />`はcapture内でpropsをcopyします。signalを読む局所object literalのgetter、後から代入する`let` alias、`state.value.count ??= 1`や`+=`のような読み取りを伴う代入もcaptureします。Hookを呼びつつsignalを読む関数をplain call(`{Title()}`)するとcaptureできないため、警告を出します。 |
| read式の中のHook呼び出し | Hookをcapture closureへ移動しません。Hookとtracked引数が同じcallにある場合 (`format(useContext(Ctx), count.value)`)、callは直接呼び出しのまま各引数のreadを個別にcaptureします。callee内部のreadは追跡されないため、source位置付きの警告を出します。Hookの戻り値に対するread (`useStore().value.name`) はHookをその位置で呼び、後続のreadだけをcaptureします。その他のHookを含むread式は警告付きでcapture対象外になります。Hookは別の文で呼び出してください。 |
| runtime key / alias | 関数が別の条件で選択されていればruntime-key readをcaptureできますが、dynamic readだけでは`auto`選択されません。対応する単純な`const` destructuringで作るstatic aliasは追跡しますが、dynamic destructuringは追跡しません。 |
| JSX render prop / `children` callback | receiverがいつ、何回呼ぶかを証明できず、captureは保証されません。静的に見える場合は位置付きwarningを出します。 |

先頭文に直接importした明示的な`useSignalTracking()`は、`transform: "managed"`でもambient runtime boundaryとして残ります。pluginはこれを`useSignalCapture()`へ置き換えません。per-read transformでwrapできる`.value`式がない`task.done`のようなdeep-proxy readに必要です。async関数とgenerator関数は引き続き対象外です。

`mode: "auto"`、`"manual"`、`"all"`は関数を選択するもので、capture semanticsは変えません。`auto`は静的に認識したreadまたは明示opt-in、`manual`は明示callまたは`@signalTracking`、`all`は対象JSX componentを選びます。`transform: "inject"`は選択関数へbest-effortなambient `useSignalTracking()` boundaryを挿入します。

## Render callbackの検出

自動検出はrender callback（配列のiteration method `map`、`flatMap`、`forEach`
へ渡す関数）を変換しません。呼び出し元の1回のrenderの中で実行回数が変わるため、
Rules of Hooksに反するからです。認識するのは、定義箇所にinlineで書いた場合
（`items.map((item) => …)`）、変数に切り出してその束縛名で参照して渡す場合
（`const` の `const Row = …; items.map(Row)` でも、function宣言の
`function Row() {…}` … `items.map(Row)` でも）、およびそれぞれのoptional
chaining形（`items?.map(Row)`）です。`Array.from(arrayLike, mapFn)` の `mapFn`
（`Array.from({ length: 5 }, Star)`）も同じ扱いで、objectに保持したcomponentを
分割代入してから渡す場合（`const { Row } = parts; items.map(Row)` や
`{ Row: Item }`）も同様です。こうしたcallback自体は変換せず、そのJSXと
`.value` 読み取りは呼び出し元のcomponentが収集します。callbackが同じmodule内の
別の場所で定義されている場合も同様で、呼び出し元componentの本体自体がsignalを
読んでいなくても、そのcomponentが変換対象になります。

対象objectの実行時の型はbuild時にはわからないため、判定材料はmethod名だけです。
そのため認識する集合は意図的に最小限にしています。`map` と `flatMap` は要素ごとに
elementを組み立て、`forEach` は蓄積用の配列へelementを積む呼び出しで、callbackを
component風の名前で切り出す典型がこの3つです。述語・畳み込み系（`filter`、
`reduce`、`find`、`some`、`every`）は意図的に除外しています。これらのcallbackは
そもそも変換対象にならない小文字のhelperであり、含めても得るものがない一方、
同名の無関係なmethodに誤って一致する余地だけが広がるからです。しかもその向きの
誤りのほうが高くつきます。実在のcomponentからsubscriptionを無言で奪うためです。
したがって、それ以外の呼び出しへ名前で渡す参照は通常のcomponent登録として扱い、
変換対象のままにします。従来どおりの `memo(Row)` / `forwardRef(Row)` に加えて、
`observer(Row)` や `connect(…)(Row)` のようなサードパーティのwrapperも同じです。
これらが返すcomponentは、Reactが独自のfiberとして、独自のhook contextで
instance化します。同じ登録はinlineで書いても機能します。関数自身が
PascalCaseの名前を持っていればよく、`observer(function Row() { … })` は
`observer(Row)` とまったく同様に認識されます。同じ形でもanonymousな関数や
arrow関数（`observer((props) => …)`）は、boundaryを結び付けるための名前を
持たないため、変換されないままです。

この検出には次の既知の制約があります。

- 再代入したaliasはたどりません。`const RowAlias = Row; items.map(RowAlias)`
  経由で渡したPascalCaseのhelperは、componentとして扱われたままになります。
- JSXのprop値として渡すrender callbackの実行時期は解決できません。`<Grid renderItem={Row} />`
  は、`Grid` が1回のrenderで `renderItem(item)` を可変回数呼ぶ場合（render prop。
  hook挿入は安全ではありません）でも、`Row` を独立したcomponentとしてinstance化
  する場合（hook挿入こそが更新を成立させます）でも構文が同一で、そのファイルだけ
  では区別できません。そのため `Row` は、単独で変換条件を満たすなら自分のhookを
  持ったままになります。参照先の関数に `@signalTracking` /
  `@noSignalTracking` コメントで意図を明示してください。

  callbackをinlineで書いても
  （`<Grid renderItem={(item) => <li>{item.value}</li>} />`）、実行時期を証明できないため
  自動trackingはしません。`onX` 以外のfunction-valued JSX propに静的に読める
  signal readがある場合は位置付きwarningを出します。`Grid` がcallbackを
  *自分の* render中に呼ぶときは、呼び出し元の関数がreturnした後なので、その呼び出し元の
  boundaryはすでに閉じているため、`Grid` 自身がboundaryを持つ場合にしか読み取りは
  追跡されず、そうでなければrenderされた項目は古いままになります。`Grid` が
  自分のcomponentなら、`@signalTracking` でopt-inしてください（または `Grid`
  自身でsignalを読んでください）。

  `auto` modeでは、`onX` 以外のfunction-valued JSX propに静的解決できるinlineまたは
  同一module callbackを渡し、そのbodyに `.value` readがある場合、source location付き
  warningを出します。この診断は受け取り側componentがcallbackを呼ぶタイミングを推測せず、
  readをreactiveにするものでもありません。境界を見つける手掛かりとして使い、tracked
  componentへreadを移すか、結果を描画するcomponentで明示的なsignal-value Hookを使って
  ください。静的に解決できるJSX children callbackにも同じwarningを出します。
  cross-module callbackと動的aliasは未分類です。
- 静的な`.value` readはdot access、文字列literal key、または
  `const valueKey = "value"`のような不変なlocal string keyで認識します。実行時key
  （`signal[key]`）は、componentが別のreadや設定ですでに変換対象の場合にcaptureし、
  実際のsignal accessorへ解決したときだけruntimeがdependencyを記録します。実行時key
  のreadだけでは`auto`は変換を選びません。signal自体のdestructuring
  （`const { value } = signal`）は追跡しません。
- named/default importしたplain helperの直接呼び出しは、呼び出し元にmanaged boundaryが
  あり、同期実行される間だけcaptureします。ただしhelper内のreadをtransformが調べて
  `auto`変換を選ぶことはできません。そのreadだけが手掛かりなら`mode: "all"`、
  `@signalTracking`、または明示的なsignal-value Hookを使ってください。import先helperが
  返すcallbackや、別moduleが後から呼ぶcallbackは追跡しません。
- objectのkey経由で渡すcallback（`items.map(parts.Row)`、または先に
  `const { Row } = parts` とする場合）はboundaryの対象から外れますが、`auto`
  modeではその `.value` 読み取りが呼び出し元の分として扱われません。呼び出し元
  自身がsignalを読んでいないと、呼び出し元は変換されず更新されません。呼び出し元で
  signalを読むか、`mode: "all"` を使うか、呼び出し元に `@signalTracking` を
  付けてください。
- 2つの役割を兼ねる関数は、除外されたままになります。`Row` をmodule内のどこかで
  `map` / `flatMap` / `forEach` に渡していて、なおかつ別の場所でJSXタグとして
  単独でrenderしている（`<Row item={x} />`）場合、render callbackとしての用法が
  優先され、`Row` は自分のhookを持ちません。これはクラッシュしない側の選択です
  （hookを持たせると、callbackとしての用法でhookの順序が壊れます）。ただし単独で
  renderされるほうはsubscriptionを持たないため、以降のsignalの書き換えで
  内容が古いままになります。役割ごとに別名の2つの関数へ分けるか、単独で
  renderするほうの関数を `@signalTracking` コメントで明示的にopt-inしてください。

判断に迷う場合は、そうしたhelperを明示的に保ってください。小文字で `use`
始まりでない名前にするか、実際にcomponentとしてrenderされるときにだけ手動で
opt-inします。

## 関数として呼び出されるcomponent

module内で通常の関数として呼び出されるPascalCaseの関数 — `Title()`、
`Title?.()`、`Title!()`、objectに保持されたものなら `ns.Home()`、
`ns?.group?.Home()`、または兄弟memberからの `this.Home()` — は、Reactが
独立したcomponentとしてmountすることはなく、その本体は呼び出し元のrenderの
中でそのまま実行されます。そのため、`all` を含むどのmodeでも独自のboundaryを
持たず、そのJSXと `.value` 読み取りは、呼び出しを行うcomponentまたはcustom
hookが収集します。

```jsx
function Title() { return <h1>{count.value}</h1>; }
// Outerが変換されて `count` をsubscribeし、Titleはそのまま残ります。
function Outer({ show }) { return <div>{show && Title()}</div>; }
```

`Title` の中にboundaryを置くと、`show` がtrueの間だけ実行されるhookが
`Outer` に加わります。これはReactが拒否する条件付きのhook呼び出しです
（"Rendered more hooks than during the previous render"）。event handler、
`useEffect` / `useLayoutEffect` / `useInsertionEffect` / `useCallback` /
`useMemo` のcallback、またはasync関数からの呼び出しはrenderの外で実行される
ため、その読み取りは収集しません。custom hook（`useX`）はもともと関数として
呼び出すものなので、従来どおり独自のboundaryを持ちます。

既知の制約は次のとおりです。

- 判定はmodule全体で行います。module内のどこか1か所でも通常の呼び出しが
  あれば、その関数は独自のboundaryを失います。*さらに* `<Title />` としても
  renderしている場合、そのinstanceは自分のsubscriptionを持たず、親が再render
  したときにしか更新されません。この混在に対してpluginは警告を出します。
  どちらか一方の形に統一してください。
- 認識するのは、その関数自身のbinding、または定義されている正確なobjectの
  key pathを通した呼び出しだけで、同じmodule内に限ります。そのpathのどの
  linkがoptionalでもかまいません（`ns?.group.Home()`）。同じobject literalの
  memberの中では、`this` がそのpathとして扱われます。method、accessor、
  `function` のproperty値、およびそれらの中に入れ子になったarrowでの
  `this.Home()` が該当します。入れ子の `function` やclassは独自の `this` を
  持つため、たどりません。alias（`const T = Title; T()`）、`Title.call(…)`、
  別moduleからの呼び出しは認識しません。
- objectに保持された関数には、computed keyを通しても到達できます
  （`renderers[node.type](node)`、`renderers[key]?.(arg)`、
  `items.map(renderers[key])`、兄弟memberからの `this[key](arg)`）。そうしたaccessが到達しうるslot（同じ深さで、
  同じ静的なprefixの下にあるもの）には、独自のboundaryを付けません。そこに
  boundaryがあると、呼び出し元の中で可変回数実行されるためです。keyは実行時に
  しか決まらないので、そのslotの読み取りは呼び出し元に収集 *されません*。
  そのため、自分ではsignalを読まない呼び出し元は変換されず、slotが読むsignalの
  変更では更新されません。呼び出し元でsignalを読むか、呼び出し元に
  `@signalTracking` を付けてください。同じslotをmodule内で
  `<renderers.User />` としてrenderしている場合も同様です。
- 読み取りを収集するのは、呼び出し元がcomponentまたは `useX` hookである場合
  だけです。小文字のhelperを経由した呼び出し
  （`function renderTitle() { return Title(); }`）はたどらないため、その
  読み取りは誰もsubscribeしません。componentから直接呼び出すか、
  `<Title />` としてrenderしてください。
- keyで保持された関数（`ns.Home()`）を収集するのは、このmodule内で、root
  に束縛されたobject literalの中に定義されている場合か、ちょうど1つのmember
  代入（`Card.Header = …`）で定義されている場合だけです。兄弟memberからの
  `this.Home()` は、そのmemberが属するobject literalから収集します。
- 呼び出されていることを変換が把握できないobjectのmemberは、独自のboundaryを
  持ったままになります。parameter経由
  （`function render(set, key) { return set[key](); }`）、alias経由
  （`const R = renderers[key]; R(arg)`）、computedな分割代入経由
  （`const { [key]: R } = renderers`）、配列内のobjectから
  （`columns.map((c) => c.Cell(row))`）、別moduleから、といった到達経路が
  該当します。そうしたmemberをinlineで呼ぶと呼び出し元の中のhook呼び出しになり、
  呼び出し回数が変わった時点でクラッシュします。memberに `@noSignalTracking` を
  付けてください。memberは独自のboundaryを持たなくなり、読み取りは呼び出し元の
  render中に実行されるため、変換された呼び出し元がそれを追跡します。その場合、
  そのmemberを要素としてrenderすると（`<icons.Check />`）、その要素は独自の
  subscriptionを持ちません。

## Higher-order component (HOC)

higher-order component（HOC）が返すcomponentは、自分自身の名前を持たなくても
認識します。

```jsx
export const withCount = (Base) => (props) => <Base {...props} count={count.value} />;
```

ここでcomponentは内側の関数であり、その識別子はfactory自身のbinding
（`withCount`）から継承します。したがって `auto` modeはこれをsubscribeし、
`@signalTracking`（`@noSignalTracking` も同様）コメントは、返される関数側とfactoryの
宣言側のどちらに書いても適用されます。通常のclosureを巻き込まないための条件は
3つです。囲む関数から直接returnされていること（明示的な `return`、または
arrowの簡潔なbody）、返される関数自身がJSXをrenderしていること、そして囲む
関数の名前がhookの名前（`useX`）でないこと — あるいはcomponentの名前
（PascalCase）である場合は、その囲む関数自身が後述のhigher-order component
factoryの条件を満たしていることです。その条件を満たさないcomponentが返す
関数、またはhookが返す関数は、そのownerのrender内で動くrender propであって、
独立したcomponentではありません。

PascalCaseの名前を持つfactoryは、componentらしきものを自分の引数として
受け取り — destructureされていない、PascalCaseの名前を持つ単なる識別子の
引数 — 、かつ自分自身はJSXをrenderしない場合に該当します。

```jsx
export const WithCount = (Base) => (props) => <Base {...props} count={count.value} />;
```

`WithCount` 自体は変換されません。返されるcomponentは、上記のcamelCase形と
まったく同様に `WithCount` の名前を継承します。`useX` という名前のfactoryが
返すclosureには、これに相当する例外は意図的にありません。Reactはすでに進行中の
renderの中からhookを呼び出すため、そのhookが返すものはまさにそのrender中に
呼び出される可能性があり、それを否定する材料がここには何もないからです。
このことはhook自体には影響しません。hookそのものは、signalを読む・JSXを
renderするといった条件を満たす限り、他のhookとまったく同様に変換対象のまま
です。名前を継承しないのは、返されるclosureだけです。

名前の継承はちょうど1段だけたどるため、factoryを返すfactory
（`(a) => (b) => (props) => …`）は解決せず、そこに書いた `@signalTracking` コメントは
無言で消えるのではなく警告として報告されます。唯一区別できない形は、factoryの
戻り値をそのままiteration methodへ渡す場合（`items.map(makeRow(prefix))`）です。
これは構文上componentを返すHOCそのものなので、独自のboundaryを持ちます。その
ようなcallbackは参照で渡すか（`items.map(Row)`）、inlineで書いて呼び出し元の
componentに収集させてください。

componentは、自分自身のbindingを持たなくても名前を得られる場合があります。
objectのproperty — `Card.Header = () => <p>{count.value}</p>` など — として
保持されているcomponent、またはobject literalのmethodとして書かれた
component（`export const ns = { Home() { return <p>{count.value}</p>; } }`）は、
`<Card.Header />` や `<ns.Row />` がそこへ到達するのと同じ、そのkeyから名前を
得ます（小文字のkeyは、小文字のbindingと同様に除外されたままです。getter、
setter、async method、generator methodも除外され、instance経由でしか到達
できないclassのmethodも対象外です）。また、名前を持たないdefault export
（`export default (props) => <p>{count.value}</p>`）は、moduleのファイル名から
名前を得ます。これは `import App from "./App"` が実際にそのcomponentへ与えて
いる識別子そのものです。ただし、classが保持する関数は意図的に対象外です。class field
（`class Holder { Row = () => … }`。instanceでも `static` でも）と、class内での
`this.Row = …` という代入（たとえばconstructor内）は変換されず、そこに付けた
`@signalTracking` コメントは警告を出したうえで無視されます。これらは
`this.Row` や `Holder.Row` 経由で到達するため、変換はそれがcomponentなのか、
`render()` が関数として直接呼ぶもの（`this.Header()`）やitemごとに渡すもの
（`items.map(this.Row)`）なのかを追跡できません。後者にhookのboundaryを入れると
class componentのrender中でhookが動き、Reactに拒否されます。要素として
（`<this.Row />`）だけrenderされる関数なら、その中で `useSignalTracking()` を
自分で呼べます。そうでなければ、signalはfunction componentで読んでください。

## `memo` / `forwardRef` の認識

`memo` / `forwardRef` の自動認識は、`"react"` または `reactImportSource` から
のdirect importだけに一致します。ローカルのbarrelやre-export module経由の
import（`import { memo } from "./some-local-module"`）は、その moduleが最終的に
`"react"` をre-exportしていても解決しません。変換は1ファイルずつ処理し、
re-exportの連鎖をたどらないためです。認識できなかった場合もエラーにはならず、
そのcomponentは無言でスキップされるため、signalを書き換えても再renderされなく
なります。回避策は次の3つです。

- 単一の安定したmodule pathでimportしているなら、`reactImportSource` にその
  specifierを設定する（`"@app/react"` のようなbare specifierはどのファイルでも
  一致します。相対pathは同じ綴りのファイルにしか一致しません）。
- 該当箇所で `memo` / `forwardRef` を `"react"` から直接importする。
- `@signalTracking` コメントか手書きの `useSignalTracking()` 呼び出しで明示的にopt-inする。

## `useSignalTracking()` のopt-inと書き換え

`@signalTracking` と `@noSignalTracking` は、その関数だけに適用されます。
`@signalTracking` は選択された変換方式へのopt-inです。`"managed"`（既定）では
top-level capture Hookを追加し、静的に証明できる同期readを個別にcaptureします。
`"inject"` ではbareなambient `useSignalTracking()` を挿入します。

手書きの `useSignalTracking()` 呼び出しもopt-inで、pluginは二重にHookを追加しません。
関数の先頭文でない呼び出しはそのまま残ります。`importSource` からdirectまたは
namespace importした先頭文の呼び出しは、どちらのmodeでもambient Hookとして残ります。
特にmanagedでは、per-read captureが扱えない `task.done` のようなdeep-proxy readも
追跡できるよう、明示Hookを維持します。barrel import経由の呼び出しも関数を選択できますが、
re-exportを検証できないためwarningを出し、どちらのmodeでも通常のambient Hookとして
残します。

先頭文での `useSignalTracking()` 呼び出しが `async` 関数やgenerator関数の中にあると、
既定の `"managed"` 変換ではbuildが失敗し、
`useSignalTracking transform only supports synchronous, non-generator functions`
というエラーになります。この組み合わせはそもそもReactとして不正です
（hookは同期のfunction componentを必要とします）。関数側を直すのが望ましく、
どうしても現状のままbuildを通す必要がある場合は `transform: "inject"` を
使うと、関数を書き換えずにこの呼び出しを受け入れます。

引数のdefault値は関数本体より前に評価されるため、そこでのsignal読み取り
（`function Label({ v = count.value })`）はboundaryが開く前に行われ、追跡
されません。変換対象の関数にそうした引数がある場合、その引数と、評価順を
保つためにそれ以降のすべての引数を生成した引数に置き換え、boundaryの中の
最初の文として同じ `undefined` のときだけのdefault規則で束縛し直します。
引数の個数は変わらないため、`forwardRef` の `(props, ref)` という形は保たれ
ます。移動するdefault値が参照する名前を本体が宣言している場合や、移動する
引数を本体が再宣言している場合は移動を行わず、その読み取りは追跡されない
ままです。その場合はsignalを本体で読んでください。

この移動では、default値の規則と評価順は変わりません。TypeScriptでは、生成
した引数が元の型とoptionalかどうかを引き継ぐため、出力は有効なTypeScriptの
ままです。ただし、関数の `length` は変わることがあります。default値を持つ
引数は `length` に数えられませんが、それを置き換えた生成引数は数えられる
ためです。たとえば `function useLabel(prefix?: string, value = count.value)`
の `length` は、sourceでは1、変換後は2です。変換された関数の `length` には
依存しないでください。

## Buildへの組み込み

いずれの変換モードも再適用するとno-opです。pluginは、対応するbundler
（Vite、webpack、Rspack）では `enforce: "pre"` で登録され、Viteではさらに
transform hookが `order: "pre"` を宣言します
（[React Compilerと併用する場合](#react-compilerと併用する場合)を参照）。
Rollupにはどちらの概念もないため、このpluginを最初にlistしてください。
pluginやloaderの順序を自分で決められる場合は、React Compilerを実行するものや
JSXを変換して消すものより前にこのpluginを置いてください。依存関係と
JavaScript/TypeScript以外のmoduleはskipし、`.cjs` / `.cts` のmoduleには
一切手を加えません。pluginは拡張子を大文字・小文字を区別せずに判定するため、
`App.TSX` を `App.tsx` とまったく同様に変換します。ただし、その後bundlerが
そのファイルを同じようにcompileするかはbundler次第で、保証はありません。
Vite 8は `.JSX` / `.TSX` をJSX / TSXとしてcompileせず、このpluginの有無に
かかわらず解析に失敗します。`.ts` はJSXなしの
TypeScriptとして、`.tsx`、`.jsx`、JavaScriptはJSXを含めて解析します。

## Fast Refresh

`managed` output now inserts `useSignalCapture()` at each transformed function's top level and wraps statically proven synchronous reads in short capture scopes. User Hooks remain at the function's top level, and generated code does not wrap user code in `try/finally`. A captured expression that throws still restores its temporary scope; render attempts that never commit do not install subscriptions.

過去に記録したVite 8 / Oxc Fast RefreshのHook signature問題は、以前の生成`try/finally`構造が原因でした。現行出力は実browserのVite 8/Oxc HMRでJSXのみの編集とHook追加・削除・並べ替えを通過し、managed OxcとBabelのHook形状変更6ケースはすべて成功しました。6 variantのmatrixは18 passedで完了し、残る6件の既知失敗は通常Reactの`try/finally` controlとPreactの同じOxc構造だけでした。HMR subgateは完了です。exactness契約は静的に特定できる同期readが対象です。未対応のcallback ownership、destructuring variant、dynamic selectionは移行時に扱う制約であり、対応patternでstale renderingが起きた場合は不具合です。

`transform: "inject"` は従来どおりbareな `useSignalTracking()` を挿入し、best-effortなambient boundaryを提供します。`managed` は暗黙のsignal-read検出を保ちながら、文書化した静的・同期範囲の各readを個別に捕捉します。静的に証明できないcallback所有権やdynamic patternは、範囲を明記し、検出可能なケースをwarningにします。

## React Server Components

この変換はbundlerのenvironmentやlayerからserver/clientを判定しません。
module-levelの`"use server"` directiveがあるファイルでは変換を行わず、JSXを
返す候補関数があれば位置付きwarningを出します。module-levelの`"use client"`は
client moduleとして通常どおり処理します。どちらのdirectiveもないServer Componentは
一file transformだけでは判別できないため、`.value`を読む同期componentにclient専用の
render tracking hookが挿入される可能性があります（async関数は変換しません）。
RSC構成では、`exclude`（たとえばserver directory単位）、個別の
`@noSignalTracking`、または`mode: "manual"`も利用してください。

## License

MIT © akazawa。[LICENSE](LICENSE) を参照してください。
