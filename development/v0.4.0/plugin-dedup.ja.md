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

## 2回目のレビューの指摘への対応

### 1. 引数のdefault値: 選択と移動の食い違い

- 変更前: 引数の移動とRFGS004は`parameterReadsTrackedValue`で判定し、静的な`.value`の読み取りしか見なかった。一方、componentの選択とbodyのcaptureは、同じmoduleのhelperの呼び出しも数える。このため`const read = () => count.value; export function C({ label = read() })`は選択されて`useSignalCapture()`と`"use no memo"`を受け取るが、`label = read()`はHookより前に残り、RFGS004も出なかった。Cは再renderされず、警告もない。
- 変更後: `parameterMayReadTrackedValue`（`bodyReadsTrackedValue`をそのまま使う）で判定する。これはcaptureがbodyに使う規則そのもので、直接の`.value`、読み取るhelperやinline callback、moduleから中身が見えない呼び出しを含む。移動とRFGS004はもともと「移動できるなら移動し、移動できない（`hasRelocationConflict`など）ときだけRFGS004」という設計なので、判定を広げるだけで両方がそろう。移動を選んだ理由: 移動は意味を変えない書き換えとしてすでに実装・テスト済みで、移動後のdefaultはcapture passがbodyと同じ規則でcaptureする。警告だけにすると、選択された正常なcomponentに毎回警告が出る。
- 利用者から見える変化: helperや外部の関数を呼ぶdefault（`{ label = read() }`、`{ id = ext() }`）を持つ変換対象の関数は、引数が`_param`に置き換わり、bodyの先頭で束縛し直される（injectでも同じ）。RFGS004の文言を「A signal read (a .value read, or a call that may make one) remains ...」に変えた（README en/jaの診断表も）。
- テスト: `tests/shared-predicates.test.ts`のRFGS004のdescribeに、helper経由（managed/inject）、inline callback、移動できない場合のRFGS004、読み取りのない呼び出しは移動しないことを足した（修正前は4件が失敗）。

### 2. esbuildのloader表

- 変更前: 対象の拡張子は`SCRIPT_MODULE_EXTENSION`（`/\.m?[jt]sx?$/i`）、loaderは`src/unplugin.ts`の手書きの`ESBUILD_LOADERS`で、別々だった。`.mjsx`/`.mtsx`は対象になり、parserは`jsx`/`typescript`を有効にするが、loaderは`"js"`になってesbuildが失敗した。
- 変更後: `.mjsx`/`.mtsx`を対象から外した。Node、TypeScript（`.mts`と`.tsx`はあるが`.mtsx`はない）、esbuild（既定のloaderがない）のどれもこの拡張子に意味を与えないため、loaderを足して対象を広げる理由がない。`src/internal/module-id.ts`に拡張子とloaderの表を1つだけ置き、`transformInclude`と`resolveEsbuildLoader`の両方がそこを引く。transformのparser選択（`JSX_EXTENSION`/`TYPESCRIPT_EXTENSION`）は、APIを直接呼ぶ場合のためそのままにした。
- 利用者から見える変化（破壊的）: `.mjsx`/`.mtsx`のファイルを変換しなくなる。READMEに対象の拡張子の一覧を書いた。
- テスト: `tests/unplugin.test.ts`に、`.mjsx`/`.mtsx`を対象にしないことと、対象の拡張子すべてに`"js"`以外のloaderがあることを足した（修正前は失敗）。

### 3. async callback: 選択とcaptureの食い違い（破壊的）

- 変更前: 選択（`isDeferredReadContext`、`scanFunction`のfold）はasync関数の中の読み取りを数えない。captureは`inlineCallbackReadsTrackedValue`、`allowAsync`付きの`functionTargetMayReadTrackedValue`、async IIFEを本体で判定する`unresolvedCallMayRead`で、最初の`await`までをrender中として扱っていた。`targetFunctionMayReadTrackedValue`（render callbackや名前で呼ぶhelper）と`targetAliasGraphMayRead`もasyncを除いていなかった。このため、ほかの読み取りで選択されたcomponentでは、`items.forEach(async (i) => { log(count.value); })`の呼び出し全体がcaptureされ、countを購読していた。
- 変更後: 判断どおり、async関数はcaptureでもrenderの外とする。`isDeferredFunction`（async、JSXのevent handler、Hookのcallback）を1つだけ置き、`isDeferredReadContext`、選択のfold、captureの上記の関数すべてがこれを使う。generatorは反復の場所で決まるため、この述語には入れず、従来どおり各呼び出し側で扱う。
- 利用者から見える変化（破壊的）: async関数（その場で呼ぶ、名前で呼ぶ、callへ渡す、render callbackにする）の中の読み取りは、最初の`await`より前でもrender dependencyにならず、それを理由にcallをcaptureしない。README（en/ja）の「同期helper call」の行が「最初の`await`までは本体で判定」と書き、後の段落が「async関数からの呼び出しはrenderの外」と書いていた矛盾を、後者に合わせて直した。
- テスト:
  - `tests/shared-predicates.test.ts`に「reads in async functions」を足した。inline/名前付きのasync callback、async IIFE、その場で呼ぶasync関数（宣言とconst arrow）、asyncのrender callback、Promise executorの中のasync IIFEについて、それだけでは選択されず、ほかの読み取りで選択されてもcaptureしないことを確かめる。同期callbackは従来どおりcaptureする（修正前は7件が失敗）。
  - `tests/react-execution.test.ts`の「M17.7.1: synchronous execution boundaries」: 最初の`await`より前の読み取りをcaptureすることを固定していた6件（名前付きasync関数、const async arrow、async IIFE、async forEach callback、`some`へ渡すasync callback、名前付きasync callback）を、書き込みが再renderを起こさない（表示が`0:1`のまま）ことを確かめる形に変えた。読み取り自体は実行される（`seen`が1）。Promise executorの4件はそのまま「captureする」。
  - 同じsuiteの「does not subscribe to reads after the first await」は、最初の`await`より前の`s`の変更で再renderすることも確かめていた。前後どちらの読み取りでも再renderしないことを確かめる形に変え、名前も変えた。
  - 「M17.7: callee resolution and value provenance」の、async IIFEの中の外部method呼び出しをcaptureするケース（`map`/`total`の2件）を外した。上記と同じ理由で、もう成り立たない。

### 4. 文字列のimport名

- 変更前: `isReactNamedImport`は`t.isIdentifier(imported, { name })`だけを見ていたため、`import { "Fragment" as F } from "react"`や`import { "memo" as m }`を認識しなかった。control-flow componentのimportは文字列名も扱っていた。
- 変更後: `getImportedName`（名前付きは識別子・文字列のどちらでも名前、defaultは`"default"`、namespaceは`undefined`）を置き、`isReactNamedImport`、`isNamedUseManagedSignalsImport`、`isNamedSignalTrackingImport`、`findRuntimeImports`、`resolveSignalControlFlowImport`、`externalCallMayReadTrackedValue`がすべてこれで読む。
- 利用者から見える変化: 文字列名でimportしたReactの`Fragment`は`Switch`と`Match`の間でfragmentとして通り（RFGS003を出さない）、`memo`/`forwardRef`はwrapperとして扱われる。
- テスト: `tests/shared-predicates.test.ts`の「string import names」（修正前は2件が失敗）。

### 5. import specifierの手書きの判定

- 変更前: `externalCallMayReadTrackedValue`、`unresolvedCallMayRead`（2か所）、`templateTagMayRead`が、それぞれ手書きでspecifierの種類を見ていた。前者はnamespaceを含まず、宣言の`import type`は除くがspecifierの`import { type X }`は除かなかった。後の3か所はnamespaceを含み、type-onlyをまったく除かなかった。
- 変更後: すべて`resolveImportedBinding`を通す（後の3か所は`importedNameMayRead`経由）。`importIsForeign`はspecifierではなくsource文字列を受け取る。規則: 名前付き・default・namespaceの値のimportは、import元で判定する（namespaceのmemberはimport元のexportなので、`ns.load()`は`load()`と同じく判定する）。type-only（宣言の`import type`もspecifierの`import { type X }`も）は消えるため、実行時にその名前はimport元を指さない。importとしては扱わず、正体の分からない名前としてcaptureする。
- 利用者から見える変化: type-onlyでimportした名前を値として呼ぶ・tagに使うコード（型検査を通らないコード）で、import元がReactやlibraryでもcaptureするようになった。正しいコードの出力は変わらない。
- テスト: `tests/shared-predicates.test.ts`の「which bindings count as imports」。type-onlyの宣言・specifier・namespace・tagをcaptureすること（修正前は4件が失敗）、Reactからのnamespace・default・名前付き・tagをcaptureしないこと、外部moduleからの名前付き・default・namespaceのmemberをcaptureすることを確かめる。

### 6. optionの検証エラーとloaderの警告

- optionの検証エラー（filter、選択肢、module specifier、`diagnostics.errorOn`の2つ）とsource mapのloaderの警告を、手書きの`[${pluginName}] ...`から`pluginMessage()`に変えた。文言は変わらない。既存のテストはそのまま通る。

### 7. `cleanModuleId`

- `stripModuleIdQuery`を呼ぶだけだったため削除し、直接呼ぶ。queryを外す理由の説明は`stripModuleIdQuery`（`src/internal/module-id.ts`）へ移した。

## 選択とcaptureの一貫性テスト

### 不変条件

`tests/selection-capture-consistency.test.ts`は、`s`の読み取り1つをさまざまな文脈に置き、次の2つを確かめる。

1. 読み取りがそれだけのcomponentが選択される（`useSignalCapture()`が入る）のは、同じcomponentに無関係なrender中の読み取り（`<i>{o.value}</i>`）を足したときに対象の読み取りがcaptureされる場合だけで、その逆も成り立つ。custom Hook（`export function useX() { ...; return 0; }`、無関係な読み取りは`return o.value`）でも同じ。
2. managedとinjectは同じ関数を選択する。

判定は出力をparseし、marker文（`const __subject = 0;`）を持つ関数の先頭のboundaryと、その関数のstoreが作る`capture`/`iterate`/`forIn`の引数で行う。入れ子のcomponentやHookのboundaryを取り違えないためである。

### 失敗していたケースと原因

最初は5件が失敗していた。

- 呼ばれないlocal関数（`function later() { return s.value; }`）、変数に入れたevent handler（`const onClick = () => log(s.value); <button onClick={onClick} />`）、generator（`function* g() { yield s.value; } const it = g();`）: 選択されるが、何もcaptureしない。
- moduleの配列へのasync forEach callback（`items.forEach(async () => { log(s.value); })`）: 選択されないが、ほかの読み取りがあるとcaptureされる。
- `s.peek()`: 選択されないが、ほかの読み取りがあるとcaptureされる。

原因は、選択（`inspectFunction`）とcapture（`captureTrackedReadExpressions`）が別々の規則で読み取りを判定していたことにある。選択は入れ子の関数の本体を（遅延するものを除き）すべて歩いて読み取りを数え、captureは呼び出し側でしかcaptureしない。このため、呼ばれない関数の読み取りは選択だけが数えていた。逆に、captureは解決できないcalleeを予防的にcaptureする（`items`はmoduleの値なので`forEach`という名前は何も証明しない。`s.peek()`も同じ）が、選択はそれを数えない。

### 修正: 選択をcapture passから導く

- `wouldCaptureRenderRead`を置いた。managedのcapture passを、ASTを変えずwarningも出さないdry runで走らせる（`captureTrackedReadExpressions`の`dryRun`引数）。capture・`iterate`・`forIn`・分割代入のcapture・JSX spreadのcaptureを出す直前（`emit`）と、captureできない読み取りの診断（RFGS001、RFGS002）の直前（`warn`）で記録するだけで、変換はしない。parameter defaultの移動（RFGS004を含む）は`parameterMayReadTrackedValue`で同じく判定する。injectも同じ答えを使う。
- 選択は「capture passが、`inspectFunction`の数える読み取りを含む式を少なくとも1つcaptureする（または報告する）」こととした。capture passだけから導く（何かをcaptureすれば選択する）ことはできない。予防的なcaptureは、READMEの「Managed tracking contract」が選択に使わないと定めている（「An imported helper body is not inspected to select a function in `auto` mode」、「the dynamic read alone does not select a function」）。実際、`import { fmt } from "./fmt"; function C() { return <p>{fmt(1)}</p>; }`は`fmt(1)`がcaptureされるため、それだけで選択すると、外部の関数を呼ぶcomponentがすべて変換されてしまう。そこで、captureされる式（その部分木）に`inspectFunction`を当てて、選択の数える読み取りがあるかを見る（`inspectFunction`の`subtree`引数）。aliasのcapture（`obj.v`、`x.name`）では、aliasの定義と代入を同じく判定する。captureされるcallへ渡すlocalなobject・配列（`const opts = { cb: () => s.value }; ext(opts)`）では、その初期化式を判定する。
- 関数全体の`inspection.readsValue`は、必要条件として先に見る（部分木の答えは関数全体の答えに含まれるので、結果は変わらない）。dry runを走らせるのは、読み取りがあり、かつ答えが必要な場合（自動選択の候補、RFGS007、RFGS008の判定）だけである。
- 部分木の問い合わせでは、`readsReachable`のmemoを書かない。部分木の探索は関数全体を除外して始めるため、除外した関数を通してしか読み取りに届かない関数（相互に参照するrender callbackの循環）を「読まない」と記録してしまう。既存のテスト「stops folding at a cycle between mutually referenced render callbacks」で見つかった。

### `peek`と`untracked`

- `.peek()`: 引数なしの`.peek()`で、受け手がこのlibraryのfactory（`signal`、`computed`、`deepSignal`、`deepCollectionSignal`、`useSignal`、`useComputed`、`useWritableComputed`、`useDeepSignal`、`useDeepCollectionSignal`）で作った、再代入されないlocal・moduleの名前なら、`unresolvedCallMayRead`は証明済みのcallとする。`importSource`はfileごとに`fileImportSources`へ記録し、`isLibraryExport`で名前付きimportとnamespace importの両方を判定する。
- `untracked(...)`: テストは通っていたが、理由は両方が誤っていたことにある。選択はcallbackの`s.value`を数えて選択し、captureは`_signals.capture(() => untracked(() => s.value))`を出していた（実行時には`untracked`の中で購読しないので、空のcaptureである）。`isDeferredFunction`に`isUntrackedCallback`（libraryの`untracked`の第1引数）を足し、選択もcaptureもその中を読まない。
- 同じ理由で、`setTimeout`、`setInterval`、`queueMicrotask`、`requestAnimationFrame`、`requestIdleCallback`（shadowされていないglobal）の第1引数と、native Promise（`new Promise`、`Promise.resolve`などのfactory、それらへの`then`/`catch`/`finally`）の`then`/`catch`/`finally`の引数を`isScheduledCallback`として`isDeferredFunction`に足した。名前で渡す場合（`setTimeout(tick)`）も、選択の`foldFunctionArguments`とcaptureの`namedArgumentMayRead`の両方で除く。これらの呼び出し自体も読み取りをしないので、予防的なcaptureもしない（`isSchedulingCall`）。

### 大きくしたcorpusで見つかった食い違い

ケースを36件から106件に増やした（custom Hookの変種を含めて191件）。class method、object method、helperが返す関数、外部importへのcallback、`.call`/`.apply`/`.bind`、optional call、tagged template、`new`、分割代入、JSXの属性・`key`・spread、`for...of`/`for...in`、入れ子のcomponentとHook、`memo`/`forwardRef`、default export、arrow component、async component、`use()`、early returnの後、`switch`、label付きblock、comma式、classのgetter、配列に入れて添字で呼ぶclosure、Promise executor、`queueMicrotask`、`requestAnimationFrame`、`builtinCallbackArguments`（`replace`）、`elementCallbackMethods`（`filter`、`reduce`）、state Hook（`useState`の値、`useReducer`の初期化）などである。見つかった食い違いと対応:

- `now.call(null)`、`now.apply(null, [])`: captureされるが、選択は`.call`/`.apply`をたどらなかった。選択のhelper foldで`.call`/`.apply`の受け手を呼ばれる関数とした。
- `` tag`a` ``（localのtagが読む）: tagged templateのfoldを足した。
- `new Promise(exec)`（名前付きexecutor）: `NewExpression`にも`foldFunctionArguments`を当てた。
- `for (const v of gen())`（localのgeneratorが読む）: captureは`iterate`するが、選択はgeneratorをたどらなかった。`for...of`の反復元のgeneratorをfoldした（部分木の判定では、`iterate`の引数をその`for...of`と一緒に見る）。
- parameter defaultの関数を呼ぶ（`function D({ format = () => count.value }) { ... format() ... }`）: 既存のテスト「leaves parameters alone when no default reads a signal」で見つかった。captureはparameterの呼び出しをすべてcaptureする。選択のfoldで、parameterのdefaultの関数を呼ばれる関数とした。
- 添字で呼ぶ配列のclosure（`fs[0]()`）、実行時keyで選ぶobjectのhandler（`handlers[k]()`）、条件で選ぶ関数（`const pick = f ? () => s.value : () => 0`）、再代入される関数（`let pick = ...; pick = ...`）: 以前は「入れ子の関数を全部数える」選択と予防的なcaptureがたまたま噛み合って購読していた。新しい規則では選ばれなくなるため、選択のhelper foldで、1つに決まらないcalleeが持ちうるlocal関数（`possibleLocalTargets`）をたどるようにした。これらのcallはどれも予防的にcaptureされるので、captureと一致する。
- 外部importへ渡すlocalなobject（`const opts = { cb: () => s.value }; ext(opts)`）: 同じく以前は購読していた。captureの部分木から参照するlocalな値の初期化式を判定に含めた（上記）。

文書化された設計による食い違いは、テストに`expected`として理由付きで書いた。いずれも予防的なcaptureで、選択に使わないとREADMEが定めているもの（class method・static method、helperが返す関数の呼び出し、`bind`した関数、localのclassの`new`、外部importの呼び出しだけ）である。

### 既知の制限（未修正）

- module dataへのasync forEach callback: 選択は設計どおり読み取りを数えない。しかしcomponentがほかの読み取りで選ばれると、`items.forEach(...)`は予防的にcaptureされ、forEachがasync callbackの同期部分をそのcaptureの中で走らせるので、`s`を購読する。証明によるcapture（`state.value.items.forEach(async () => { log(o.value); })`）でも同じことが起きる。直すには生成コードがcallbackをuntrackedで走らせる必要があるが、capture storeにその手段がなく、runtimeはこの作業の範囲外である。予防的なcaptureをやめると、受け手が読み取る場合に購読が漏れる（古い表示になる）ので、それもしない。テストでは`knownLimitation`として固定し、READMEに既知の制限として書いた。

### 利用者から見える変化（破壊的）

- 選択されなくなる: 呼ばれないlocal関数・object method、変数に入れてJSXへ渡すevent handler、iterateされないgenerator、他者が呼ぶために返す関数（component・Hookが`() => <li>{count.value}</li>`を返す）、Hookを呼ぶcallback（`[count].map((item) => item.value + useContext(Ctx))`）、`untracked(...)`、timer・native Promiseのcallbackの中だけで読むcomponent・Hook。managedでは、これらは以前も何もcaptureしていなかった（timer・Promise・`untracked`のcaptureは何も購読しない）ので、出力から無駄な`useSignalCapture()`と`"use no memo"`が消えるだけである。injectでは、ambientな`useSignalTracking()`が入らなくなるため、たまたまそのrender中に走っていた読み取り（返した関数をHookの呼び出し側がrender中に呼ぶ、など）を追跡しなくなる。
- 選択されるようになる: `.call`/`.apply`、localのtag、名前付きPromise executor、`for...of`でiterateするlocalのgenerator、parameter defaultの関数の呼び出しでだけ読むcomponent・Hook（以前は読み取りを取りこぼしていた）。
- captureしなくなる: libraryのsignalの`.peek()`、`untracked(...)`、timerとnative Promiseへの`then`/`catch`/`finally`の呼び出し（引数に読み取りがない場合）。

### 既存テストの変更

- `tests/transform.test.ts`「keeps a function returned by a component or a hook off its own boundary」: 返した関数にboundaryを付けないことは変わらない。持ち主も、返した関数の読み取りをどのcaptureも含まないため選択しない。`useSignalCapture`が2つ入ることを確かめていたのを、入らないことを確かめる形に変えた。
- `tests/react-execution.test.ts`「does not move Hook calls into a capture closure」: Hookを呼ぶcallbackは（その呼び出しも）captureしないため、`[count].map((item) => item.value + useContext(Ctx))`だけを読むcomponentは選択しない。この形だけ`selected: false`を期待する。Hookをcaptureの中へ動かさないことの確認は変わらない。
- READMEの「Managed tracking contract」の後に、選択の規則とこの既知の制限を書いた（en/ja）。
