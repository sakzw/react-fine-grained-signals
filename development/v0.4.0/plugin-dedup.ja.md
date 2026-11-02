# pluginの重複ロジックの統一

v0.4.0の公開前に、`unplugin-react-fine-grained-signals`の中で同じ判定を複数箇所に手書きしていた部分を、1つのhelperにまとめた記録。写しの間で少しずつ差が生まれ、同じ入力に対して関数ごとに答えが違っていた。意味が本当に違うものは統一していない（最後の節）。

回帰テストは主に`packages/unplugin-react-fine-grained-signals/tests/shared-predicates.test.ts`（新規）に置いた。各項目では、先に失敗するテストを書いてから統一した。

## 1. TypeScriptのwrapperを越える判定

### 変更前

`isTransparentWrapper`（`!`、`as`、`satisfies`、`<T>x`、`x<T>`）とは別に、3か所が対象のwrapperを手で列挙していた。

- `isReadModifyingTrackedTarget`と`isWriteTarget`は`satisfies`を含まない。`(s.value satisfies number) = 3`で代入先そのものをcaptureし、`(_signals.capture(() => s.value) satisfies number) = 3`という構文エラーのコードを出していた。
- `inlineCallbackReadsTrackedValue`は`<T>x`を含まない。
- `(s.value as number)++`はupdate全体をcaptureするが、Babelのgeneratorが括弧を落とし、`capture(() => s.value as number++)`という再parseできないコードを出していた。
- `(s.value as number) += 1`は、targetがmember式でないため何もcaptureしていなかった（`s.value += 1`は全体をcaptureする）。

### 変更後

3か所とも`isTransparentWrapper`を使う。wrapperは実行時に消えるので、wrapした書き込み先は書き込み、wrapしたupdateと複合代入はwrapなしと同じく演算全体をcaptureする。captureに移すupdate/代入では、wrapperの周りに明示的な括弧（`ParenthesizedExpression`）を付ける。

「wrapしたupdate/代入の対象は書き込みとして扱い、captureしない」案は採らなかった。`s.value++`は旧値を読むので演算全体をcaptureしており、wrapperの有無で結果を変える理由がない。

`.ts`で作者が書いた`(<number>s.value) = 2`は、変換していない文でもBabelのgeneratorが括弧を落として`<number> s.value = 2`と出力する。Babel側の出力の制約で、この変更の範囲外とした。

### 利用者から見える変化

`satisfies`をwrapした代入先で構文エラーが出なくなった。`as`/`satisfies`をwrapしたupdateの出力が再parseできるようになった。wrapした複合代入（`(s.value as number) += 1`）がcaptureされるようになった。

## 2. control-flow componentによる所有の判定

### 変更前

- `isOwnedBySignalControlFlow`は、Matchの直接の親JSX要素がSwitchであることを要求していた。runtimeの`collectMatches`（`src/utils.tsx`）は`Children.forEach`で配列や`false`を平らにし、Fragmentの中にも入る。そのため`<Switch><><Match when={s}>{(v) => ...}</Match></></Switch>`でRFGS003が誤って出ていた。
- `children={...}`属性の形はSwitchの確認を飛ばしていた。Switchの外にあるMatchでも警告が出なかった。
- `resolveSignalControlFlowImport`はimportの解決とkeyの読み取りを独自に書いていた。`const S = U["Show"]`、`import { "Show" as When }`、`const { ["Show"]: If } = U`を認識しなかった。

### 変更後

- `isMatchCollectedBySwitch`がMatchから親をたどる。`<>`とReactの`<Fragment>`/`<React.Fragment>`、配列、条件演算子の結果側、論理演算子の右辺、括弧、TypeScriptのwrapperは通過する。それ以外の要素、属性、関数の境界で止まる。子要素の形と`children`属性の形は、どちらもこの関数で判定する。
- `resolveSignalControlFlowImport`は`resolveImportedBinding`、`getReadPropertyName`、`getPropertyKeyName`を使う。

### 利用者から見える変化

RFGS003の変化。Fragment、配列、条件式を挟んだSwitch内のMatchは警告しない。Switchの外にある`children={...}`形のMatchは警告する。文字列keyで参照したcontrol-flow componentを認識する。既存テスト（`tests/transform.test.ts`）の`const { ["Show"]: ComputedShow } = controls`は、警告2件から1件に期待値を変えた。

## 3・4. Hook呼び出しの判定

### 変更前

「Hookを呼んでいるか」の判定が3つあり、答えが違った。

- `callNameIsHook`（capture側）: `use`と`use[A-Z]`のすべて。
- `functionCallsHook`: `use`を含まない。本体がそのままHook呼び出しになっている簡潔なarrow（`() => useLabel(s.value)`）を見落とす。
- 選択側の`isDeferredCallbackArgument`: Reactの5つのHook（`useEffect`、`useLayoutEffect`、`useInsertionEffect`、`useCallback`、`useMemo`）の第1引数だけを除外。

その結果、次の不具合があった。

- `use(Ctx)`を呼ぶhelperが`_signals.capture(() => title())`に畳み込まれた。「Hookをcaptureの中に入れない」という不変条件に反する。
- 読み取りが`useSignalEffect(() => ...s.value)`の中にしかないcomponentがautoで選ばれた。captureが1つもないまま`useSignalCapture()`と`"use no memo"`が入り、React Compilerを無駄に無効にしていた。

### 変更後

- `isHookCallName`（`isHookName`に`use`を加えたもの）を呼び出し名の唯一の規則にした。関数自身のidentityには従来どおり`isHookName`を使う（`use`はcustom Hookの名前ではない）。
- `functionCallsHook`は関数本体に対する`expressionCallsHook`にした。本体そのものも調べる。外部呼び出しの判定（`externalCallMayReadTrackedValue`）も`isHookCallName`を使う。
- 選択側は`isHookCallbackArgument`を使う。Hook呼び出し（`callNameIsHook`）の引数に直接渡した関数は、引数の位置にかかわらずrenderの外とみなす。capture側がすでに使っていた規則と同じである。

この規則は`transform: "inject"`にも適用する。injectのambient boundaryは、custom Hookがrender中に同期的に呼ぶcallbackの読み取りも収集できる。そのため、読み取りがそこにしかないcomponentはinjectで選ばれなくなる。判断の根拠は次のとおり。boundary設計（`development/design/use-signals-boundary-design.md`）は、effect、event handler、非同期callbackの読み取りをrenderの依存にすることを目的外としている。既存の規則も、render中に同期実行される`useMemo`を除外していた。transformからは、custom Hookがcallbackをいつ呼ぶか見えない。別モデル（Clef）にも意見を求め、両mode共通の規則を支持する結果（0.91）だった。

### 利用者から見える変化

- auto/allモード（managed・inject共通）で、Hookに渡した関数の中だけで`.value`を読むcomponentとcustom Hookは選ばれなくなった（出力が変わる）。
- `use()`を呼ぶhelper、または本体がHook呼び出しであるarrow helperは、captureに包まれなくなった。
- README（en/ja）の「renderの外で実行される呼び出し」の説明を、5つのHookの列挙から「任意のHook呼び出しに渡した関数」に改め、autoの選択にも同じ規則を使うと書いた。

## 5. RFGS004

### 変更前

RFGS004は`containsSyntacticValueRead`で判定し、property名が`value`であることしか見ていなかった。引数の移動（`relocateTrackedParameters`）は`isTrackedValueRead`を使い、`current`/`target`/`currentTarget`を受け手とする読み取りを除外する。そのため`({ ref, v = ref.current.value })`は移動されず（正しい）、そのうえでRFGS004を誤って出していた。

### 変更後

RFGS004も移動と同じ`parameterReadsTrackedValue`で判定する。移動できずに引数リストへ残った読み取りにだけ警告する。`containsSyntacticValueRead`は削除した。

### 利用者から見える変化

ref・DOMの`.current.value`などを読む引数のdefaultで、RFGS004が出なくなった。

## 6. RFGS003のcallback抽出とevent prop判定

### 変更前

- `inspectKnownRenderPropReads`は、2つのbranchの両方で`isArrowFunctionExpression()`を直接調べていた。一方、componentの自身の検査からcallbackを外す`isRenderPropCallback`はwrapperを越える。そのため`render={(() => s.value) as Fn}`は、追跡も警告もされなかった。
- async/generatorの規則は属性のbranchにしかなく、しかも読み取りの有無にかかわらず警告していた。React 19のform action（`action={async (data) => { await save(data); }}`）でも、毎回「signalを読む」というRFGS003が出ていた。
- `/^on[A-Z]/`を3か所に書いていた。

### 変更後

- `getJsxCallbackTarget`（wrapperを越えてinline関数または同じmodule内の関数を得る）と`isEventHandlerPropName`を作り、両branchで使う。
- async/generatorのcallbackも同期のものと同じ読み取り検査にかけ、子要素と属性の両方で、読み取りがあれば警告する。別モデル（Clef）の意見も同じ案を支持した（0.87）。

### 利用者から見える変化

RFGS003の変化。wrapperで包んだrender prop・children callbackも警告の対象になった。signalを読まないasync/generatorのcallback（form actionなど）では警告しなくなった。signalを読むasyncのchildren callbackは警告するようになった。

## 7. 到達しないコードの削除

`decideTransform`は、先頭文の明示的な`useSignalTracking()`に対して、injectでもmanagedでも`directive-only`を返す。codegenに`explicit: true`は届かない。`getAbsorbedSignalTrackingImport`、`absorbedImports`/`removeAbsorbedImports`、`applyManaged`のexplicit分岐を削除した。これらのコメントは、作者の呼び出しを`useSignalCapture()`に置き換える古い仕様を説明しており、現在の仕様（ambient boundaryとして残す）と矛盾していた。出力は変わらない。

明示的な呼び出しがasync関数にある場合、managedはbuild errorにし、injectはそのまま通す。この違いはREADMEに書かれた意図的な仕様なので、統一していない。

## 8. optionの検証（破壊的）

### 変更前

検証していたのは`reactCompiler`、`include`/`exclude`、`diagnostics.errorOn`のIDだけだった。`mode: "Auto"`はどの分岐とも一致せず、custom Hookだけを変換した。`transform: "manged"`は何も変換しなかった。`importSource: ""`は`""`と`"/internal"`からのimportを生成した。

### 変更後

`src/unplugin.ts`の`resolveOptions`が、すべてのoptionを1か所で検証し、defaultを補う。defaultは`DEFAULT_OPTIONS`にだけ書く。

- `mode`、`transform`、`reactCompiler`: 値の一覧（`MODES`、`TRANSFORMS`、`REACT_COMPILER_MODES`）を`src/internal/transform.ts`に置き、型もそこから導く。大文字小文字だけが違う場合は`did you mean "auto"?`を付ける。`reactCompiler: "auto"`の改名の案内は従来どおり。
- `importSource`、`reactImportSource`: 空でない文字列。
- `diagnostics.errorOn`: 配列であること（従来は文字列を渡すと1文字ずつ検査していた）と、既知のIDであること。

失敗するとoption名を示す`TypeError`をplugin作成時に投げる（webpack/rspackは`apply()`時）。README（en/ja）の「Options」の冒頭に、この検証を書いた。

### 利用者から見える変化（破壊的）

不正な`mode`、`transform`、`importSource`、`reactImportSource`、配列でない`diagnostics.errorOn`は、黙って受け付けられる代わりに`TypeError`になる。

## 9. その他の重複

- message prefix（破壊的）: 診断は`[react-fine-grained-signals] RFGSxxx:`、optionのerrorは`[unplugin-react-fine-grained-signals]`、parse失敗は括弧なしの`unplugin-react-fine-grained-signals could not ...`と、3通りあった。すべて`src/internal/diagnostics.ts`の`pluginMessage()`を通し、messageを出すpackageの名前である`[unplugin-react-fine-grained-signals]`で始める。Babel pluginの`name`も`PLUGIN_NAME`を使う。READMEの例とテストの期待値を更新した。
- `${importSource}/internal`（5か所）と`/utils`は、`managedRuntimeSourceOf`/`controlFlowSourceOf`にまとめた。
- query/hashの除去（3か所）は`src/internal/module-id.ts`の`stripModuleIdQuery`にまとめた。拡張子のregexは用途が違う。adapterが対象にするもの（`.cjs`/`.cts`を除く）、`typescript` pluginを使うもの、`jsx` pluginを使うものの3つで、統一はせず同じfileに並べた。
- `builtinCallbackArguments`は、`elementCallbackMethods`に`replace`/`replaceAll`を加えて導く。
- `stateHookNames`はidentifierしか受け付けず、`React.useState(...)`を落としていた。`isStateHookCallee`が、Reactのdefault/namespace importを根とする1段のmember（`React.useState`）も同じく扱う。任意のobjectの`store.useState()`は従来どおり信用しない。利用者から見える変化として、`React.useState`のstateに対する`rows.map(...)`をcaptureしなくなった。
- `errorOn`のJSDocにあった`RFGS001`-`RFGS009`の固定範囲を、公開しているID一覧への参照にした。

## テスト

- `tests/shared-predicates.test.ts`（新規）: 項目1〜6と9の再現例（出力の再parseを含む）。
- `tests/unplugin.test.ts`: 項目8の不正値ごとの`TypeError`とmessage、全正規値の受け付け。
- `tests/transform.test.ts`、`tests/diagnostics.test.ts`: 項目2の期待値1件と、項目9のprefixの期待値を更新した。

## 統一しなかったもの

- `isHookName`（identity）と`isHookCallName`（呼び出し）。`use`は呼び出しとしてはHookだが、custom Hookの名前ではない。
- 拡張子のregex3つ（上記）。
- injectとmanagedでの、明示的な呼び出しがasync関数にある場合の扱い（項目7）。

## 追補: 監査で見つかった食い違いの修正

### 1. 外部helper呼び出しのcaptureでのimport元の判定

- 変更前: `externalCallMayReadTrackedValue`だけが、import元を`importSource`と`reactImportSource`の2つと手書きで比べていた。共通の`importIsForeign`はmanaged runtime（`${importSource}/internal`）と、常に`"react"`を受け付ける`isReactSource`も見る。このため`reactImportSource: "@app/react"`を設定すると、`"react"`から直接importした`cloneElement`が外部helperとみなされ、`{cloneElement(el)}`が`{_signals.capture(() => cloneElement(el))}`になっていた。READMEの「`"react"`からのdirect importは常に認識される」と矛盾する。
- 変更後: `importIsForeign`を、`ReadContext`全体ではなく3つのsourceだけを受け取る形にし、ここからも呼ぶ。transform内のほかのimport元の比較（`findRuntimeImports`、`isNamedUseManagedSignalsImport`、`controlFlowSourceOf`との比較など）は「特定のentryからのimportか」を見る肯定の一致で、「libraryとReact以外か」の判定ではないため、そのままにした。
- 利用者から見える変化: `reactImportSource`を設定したとき、`"react"`から直接importした関数（`cloneElement`など）の呼び出しをcaptureしなくなる。

### 2. control-flow componentの名前

- 変更前: `For`/`Index`/`Match`/`Show`/`Switch`を型とSetに2回書き、どのpropのcallbackを所有するかは`if`の分岐に埋め込んでいた。
- 変更後: `SIGNAL_CONTROL_FLOW_COMPONENTS`（`as const`）に1回だけ書き、型とSetはそこから導く。所有するcallback propは、その型をkeyにした表（`For`は`children`と`by`、`Index`/`Show`/`Match`は`children`、`Switch`はなし）にした。`Match`は従来どおり、囲む`Switch`に集められる場合だけ所有とする。
- テスト: `tests/react-execution.test.ts`で、この一覧がruntimeの`src/utils.tsx`の関数exportと一致することを確かめる。さらに`Show`/`Index`の`children`、`Switch`/`Match`、`For`の`children`と`by`について、callbackの中だけでsignalを読むcomponentをmountし、書き込みがDOMに届くことを確かめる。RFGS003を出さないcallbackが、実際にcontrol-flow component自身のtracked renderで読まれていることの裏付けになる。
- 利用者から見える変化: なし。

### 3. 文書とテストの一致

- `importSource`のJSDocとREADME（en/ja）: 互換wrapperは、rootと`/internal`に加えて`${importSource}/utils`のcontrol-flow componentもre-exportする必要があることを書いた。transformはこのentryからのimportだけをcontrol-flow componentと認識する。
- README（en/ja）のRFGS003: 診断表と「JSX render prop / `children` callback」の行に、control-flow componentの例外（`Show`/`For`/`Index`の`children`、`For`の`by`、`Switch`が集める`Match`の`children`）を書いた。`src/internal/diagnostics.ts`の説明にも同じことを書いた。
- `tests/diagnostics.test.ts`: 両READMEに出てくる`RFGS\d{3}`の集合と診断表の行が、`DIAGNOSTIC_IDS`と一致することを確かめる。
- adapterのentry一覧: `tests/build-smoke.mjs`、ルートの`tests/consumer-smoke.mjs`、`tsdown.config.ts`の3か所に同じ一覧があった。いずれも`package.json`の`exports`から導く（consumer smokeはinstallしたtarballのmanifestから）。期待するexport名と漏れてはいけない内部名は、`tests/public-api.mjs`（新規）に1回だけ書き、2つのsmokeがimportする。consumer smokeは、従来rootだけで見ていた内部名の漏れを全entryで見る。

## レビューの指摘への対応

- **包んだ`++`/代入の括弧（構文エラー）:** `parenthesizeWrappedTarget`は、captureする式の一番外側の`++`/代入にしか括弧を足していなかった。`f((count.value as number)++)`のように式の中にあると、`capture(() => f(count.value as number++))`となり、parseできなかった。clone全体を`t.traverseFast`でたどり、どの深さでも括弧を足す。`tests/shared-predicates.test.ts`に、呼び出しの引数とtemplate literalの中のケースを足した（修正前は失敗）。
- **`Switch`の中の`Match`の判定:** `isMatchCollectedBySwitch`は、論理演算子の右側と、子の式だけをたどっていた。runtimeの`collectMatches`は、`||`と`??`の左側（結果になるため）と、`<Switch children={...}>`で渡した`Match`も拾う。両方をたどるようにした。`&&`の左側は結果にならないため、これまでどおりたどらない。testを足した（修正前は3件が失敗）。
- **build設定がtestのファイルをimportしていた:** `tsdown.config.ts`が`tests/public-api.mjs`をimportしていたため、`tests/`を含まない環境ではbuildできなかった。`scripts/public-api.mjs`へ移した。build smoke（`tests/build-smoke.mjs`）とrepoのconsumer smokeもそこから読む。`scripts/`は公開packageの`files`に含まれない。
