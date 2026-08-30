# unplugin-react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

[`react-fine-grained-signals`](https://www.npmjs.com/package/react-fine-grained-signals)（npmへまだ公開されていません）
向けの、`useSignals()` 自動挿入と任意のmanaged render scope変換を提供する汎用
bundler integrationです。

このpackageは意図的に唯一のbuild-time integrationです。Babel実装は内部に
閉じ込め、利用側はbundlerごとのentry pointだけを設定します。

## インストール

```sh
pnpm add -D unplugin-react-fine-grained-signals
```

`react-fine-grained-signals` はpeer dependencyです。このpackageはESM-onlyです。
CommonJSの`require()`ではなく、ESM設定から`import`してください。

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

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
  - `"manual"`: 先頭文にあるimport済みの `useSignals()`、または
    `@useSignals` を付けた名前付きcomponent/custom hookだけを変換します。
  - `"auto"`（既定）: さらに `.value` を読む名前付きJSX componentと
    名前付き `useX` custom hookを変換します。
  - `"all"`: さらにすべての名前付きJSX componentを変換します。ネストした
    callbackの読み取りは親componentが収集しますが、callback自体は変換しません。
- `transform`
  - `"managed"`（既定）: 厳密な `try` / `finally` 境界を追加します。
    `/runtime` からimportし、componentの関数がreturnする時点でrender
    tracking windowを同期的に閉じます。
  - `"inject"`: best-effortなopt-in向けに変換なしの `useSignals()` を
    追加します。制御フローを書き換えず、通常の `useSignals()` を先頭hook
    として挿入するため、手書きと同じbest-effort境界になります。この
    modeが露呈し得るsibling誤帰属の既知の制約については、
    [境界設計の検討docs](../../docs/design/use-signals-boundary-design.ja.md)
    を参照してください。
- `reactCompiler`
  - `"auto"`（既定）: 変換したすべての関数に `"use no memo"` を付け、render
    trackingが必要とするsignal読み取りをReact Compilerがmemoizationで
    消さないようにします。付けない場合、compile済みcomponentはJSXをcacheし、
    最初のsignal書き込み以降、無言で更新が止まります。
  - `"off"`: directiveを付けません。React Compilerをbuildで使っていない場合か、
    対象componentを[互換性の検討docs](../../docs/design/react-compiler-compatibility.ja.md)
    に照らして確認済みの場合だけ選んでください。
- `importSource`: `react-fine-grained-signals` 互換wrapperへの置き換えです。
- `reactImportSource`: wrapされた関数をcomponentと判定する際に、`memo` /
  `forwardRef` をReact由来とみなすmodule specifierを追加します。置き換えでは
  なく追加であり、`"react"` からのdirect importは常に認識されます。つまり
  設定しても既存のdirect importの認識が外れることはありません。
- `include` / `exclude`: source module IDを絞る関数です。

## Render callbackの検出

自動検出はrender callback（配列のiteration method `map`、`flatMap`、`forEach`
へ渡す関数）を変換しません。呼び出し元の1回のrenderの中で実行回数が変わるため、
Rules of Hooksに反するからです。認識するのは、定義箇所にinlineで書いた場合
（`items.map((item) => …)`）、変数に切り出してその束縛名で参照して渡す場合
（`const` の `const Row = …; items.map(Row)` でも、function宣言の
`function Row() {…}` … `items.map(Row)` でも）、およびそれぞれのoptional
chaining形（`items?.map(Row)`）です。こうしたcallback自体は変換せず、そのJSXと
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

この検出には既知の制約が4つあります。

- 再代入したaliasはたどりません。`const RowAlias = Row; items.map(RowAlias)`
  経由で渡したPascalCaseのhelperは、componentとして扱われたままになります。
- JSXのprop値として渡すrender callbackは認識しません。`<Grid renderItem={Row} />`
  は、`Grid` が1回のrenderで `renderItem(item)` を可変回数呼ぶ場合（render prop。
  hook挿入は安全ではありません）でも、`Row` を独立したcomponentとしてinstance化
  する場合（hook挿入こそが更新を成立させます）でも構文が同一で、そのファイルだけ
  では区別できません。そのため `Row` は、単独で変換条件を満たすなら自分のhookを
  持ったままになります。呼び出し箇所にcallbackをinlineで書くか
  （`<Grid renderItem={(item) => <li>{item.value}</li>} />`。上記のinline検出が
  呼び出し元componentに正しく帰属させます）、参照先の関数に `@useSignals` /
  `@noUseSignals` コメントで意図を明示してください。
- 別moduleからimportしたcallbackはたどりません。変換は1ファイルずつ処理する
  ためです。
- 2つの役割を兼ねる関数は、除外されたままになります。`Row` をmodule内のどこかで
  `map` / `flatMap` / `forEach` に渡していて、なおかつ別の場所でJSXタグとして
  単独でrenderしている（`<Row item={x} />`）場合、render callbackとしての用法が
  優先され、`Row` は自分のhookを持ちません。これはクラッシュしない側の選択です
  （hookを持たせると、callbackとしての用法でhookの順序が壊れます）。ただし単独で
  renderされるほうはsubscriptionを持たないため、以降のsignalの書き換えで
  内容が古いままになります。役割ごとに別名の2つの関数へ分けるか、単独で
  renderするほうの関数を `@useSignals` コメントで明示的にopt-inしてください。

判断に迷う場合は、そうしたhelperを明示的に保ってください。小文字で `use`
始まりでない名前にするか、実際にcomponentとしてrenderされるときにだけ手動で
opt-inします。

## Higher-order component (HOC)

higher-order component（HOC）が返すcomponentは、自分自身の名前を持たなくても
認識します。

```jsx
export const withCount = (Base) => (props) => <Base {...props} count={count.value} />;
```

ここでcomponentは内側の関数であり、その識別子はfactory自身のbinding
（`withCount`）から継承します。したがって `auto` modeはこれをsubscribeし、
`@useSignals`（`@noUseSignals` も同様）コメントは、返される関数側とfactoryの
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
（`(a) => (b) => (props) => …`）は解決せず、そこに書いた `@useSignals` コメントは
無言で消えるのではなく警告として報告されます。唯一区別できない形は、factoryの
戻り値をそのままiteration methodへ渡す場合（`items.map(makeRow(prefix))`）です。
これは構文上componentを返すHOCそのものなので、独自のboundaryを持ちます。その
ようなcallbackは参照で渡すか（`items.map(Row)`）、inlineで書いて呼び出し元の
componentに収集させてください。

componentは、自分自身のbindingを持たなくても名前を得られる場合があります。
objectやclassのproperty — `Card.Header = () => <p>{count.value}</p>` や、
`class Holder { Row = () => <p>{count.value}</p> }` のようなfield — として
保持されているcomponentは、`<Card.Header />` や `<ns.Row />` がそこへ到達する
のと同じ、そのkeyから名前を得ます（小文字のkeyは、小文字のbindingと同様に
除外されたままです）。また、名前を持たないdefault export
（`export default (props) => <p>{count.value}</p>`）は、moduleのファイル名から
名前を得ます。これは `import App from "./App"` が実際にそのcomponentへ与えて
いる識別子そのものです。ただし、class内での `this.Row = …` という代入
（たとえばconstructor内）は意図的に対象外です。そうした `this` を束縛する
rendererには、この機能が存在する以前と同様、明示的な `useSignals()` 呼び出し
か `@useSignals` コメントが必要です。

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
- `@useSignals` コメントか手書きの `useSignals()` 呼び出しで明示的にopt-inする。

## `useSignals()` のopt-inと書き換え

`@useSignals` と `@noUseSignals` は、その関数だけに適用されます。pluginが
二重の `useSignals()` 呼び出しを挿入することはありません。既存のdirect
import、namespace import、barrel import経由の呼び出しは、その関数のopt-inと
みなします。先頭文でない呼び出しと、barrel import経由の呼び出しは、いずれの
変換モードでもそのまま残ります。`importSource` からdirect importまたは
namespace importした先頭文の呼び出しは、`"inject"` ではそのまま残りますが、
`"managed"`（既定）では生成する境界に吸収されます。つまりその文は削除され、
managed storeの宣言と `try` / `finally` scopeに置き換わるため、関数本体は
そのまま残るのではなく書き換えられます。

先頭文での `useSignals()` 呼び出しが `async` 関数やgenerator関数の中にあると、
既定の `"managed"` 変換ではbuildが失敗し、
`useSignals transform only supports synchronous, non-generator functions`
というエラーになります。この組み合わせはそもそもReactとして不正です
（hookは同期のfunction componentを必要とします）。関数側を直すのが望ましく、
どうしても現状のままbuildを通す必要がある場合は `transform: "inject"` を
使うと、関数を書き換えずにこの呼び出しを受け入れます。

## Buildへの組み込み

いずれの変換モードも再適用するとno-opです。この変換は、対応するbundler
（Vite、webpack、Rspack）では `enforce: "pre"` によって他のplugin変換より
先に実行されます。Rollupにはこの概念がないため、このpluginを最初にlistして
ください。また、依存関係やJavaScript/TypeScript以外のmoduleはskipします。
`.ts` はJSXなしのTypeScriptとして、`.tsx`、`.jsx`、JavaScriptはJSXを含めて
解析します。

## License

MIT © akazawa。[LICENSE](LICENSE) を参照してください。
