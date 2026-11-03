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

## 実行による差分テスト

上の一貫性テストは、pluginの判定どうしを比べる（静的）。`tests/runtime-differential.test.ts`は、同じ読み取りの形をReactで実際に動かし、pluginの出力をruntime自身の追跡と比べる。

### 設計

- corpusは`tests/read-shapes.ts`に移し、両方のテストが同じ一覧を使う。preludeの`log`と`List`は宣言だけだったので、実行できる実装にした（`log`は何もしない、`List`は`render()`を自分のrender中に呼ぶ）。`./ext`の`ext`・`extStore`は、渡された関数を呼ぶ実装をテストが与える。変更後も一貫性テストの結果は変わらない。
- oracle: 変換しないmoduleで、対象の関数の先頭文に手書きの`useSignalTracking()`を入れたもの。runtimeは、そのrenderの間に同期的に起きたsignalの読み取りをすべて追跡する。
- candidate: 同じmoduleを`auto`で変換したもの。`transform: "managed"`と`"inject"`のそれぞれについて、読み取りがそれだけの場合と、無関係な読み取り（`<i>{o.value}</i>`、Hookでは`return o.value`）を足した場合を作る。
- 実行は`tests/react-execution.test.ts`のharness（変換、OxcによるJSXの変換、in-memoryのlink）を`tests/execution-harness.ts`に切り出して使う。namespace importとdefault exportを扱えるようにした。render回数の計測と書き込みの関数は、変換の後でmarker文（`const __subject = 0;`）の直後とmoduleの末尾に足す。変換が見るsourceは一貫性テストと同じである。
- 各ケースで、mountし、対象のsignalに書き込み（既定は`s.value = 5`、`st`・`list`・`props`を読むケースはそのsignal）、`act`でflushする。candidateはoracleが再renderするときに限って再renderし、書き込みの後の表示はoracleと同じでなければならない。誰も読まないsignal（`u`）への書き込みでは、どれも再renderしない。custom Hookの変種は、Hookを呼んで戻り値を表示するcomponentで同じことをする。
- oracleとの食い違いは、ケースごとに`run.exception`（文書化された設計。READMEか設計文書の行を引く）か`run.knownLimitation`として書く。`exception`はoracleと実際に食い違っていなければならず、食い違わなくなったら失敗する。`stale: true`は、そのcandidateが書き込みの前の表示のままになることを示す。
- 対照として、変換しない（boundaryのない）componentが再renderしないことをharnessが見分けることも確かめる。

### 結果

corpusは107件（`useComputed`の値をrender中に読むケースを1件足した）で、component 104件、custom Hook 84件を実行した。食い違ったのは17件で、oracleを直したもの2件、`exception` 15件（うち1件はoracle側の限界）、`knownLimitation` 1件（`exception`と同じケース）である。pluginの不具合は見つからなかった。

実行しないケース（3件、custom Hookの変種も同じ）:

- `use()`: render中に作ったpromiseを`use`に渡すと、毎回suspendしてcommitしない。
- async component: client rootはasync componentをrenderできない（README.md:537-541）。
- `useComputed`のgetter（`{c}`）: signalのobjectをchildとしてrenderするとReactが拒否する。`useComputed`は遅延評価なので、getterの最初の評価は新しいケース「a useComputed value read in render」が扱う。

oracle側の限界:

- parameter default（`{ label = s.value }`、`{ label = readS() }`）: defaultは本体より前に評価されるので、手書きの先頭文の`useSignalTracking()`はその読み取りを追跡しない（README.md:544-546）。pluginはdefaultをboundaryの内側へ移すので、candidateのほうが正しい。oracleは`run.oracle`で、本体の分割代入（`const { label = s.value } = props;`）に書き換えた。
- 入れ子のcomponent（`function Inner() { ... }`を`<Inner />`）: oracleのbareなcollectorは`Inner`のrender中もまだ開いているので、`Inner`の読み取りを`C`のものとして記録する（use-signals-boundary-design.md:15）。candidateでは`Inner`が自分で購読し、表示も更新される。`exception`として書いた（4つのcandidateとも`C`は再renderしない）。

文書化された設計による食い違い（`exception`）:

- Hookのcallback（`useMemo`、`useState`の初期化、`useReducer`の初期化）: README.md:379-384（Hookへ渡した関数は「runs outside the render, so its reads are not collected」）。managedは購読しない。injectは、選択されれば手書きの呼び出しと同じambientなboundaryなので、oracleと同じく購読する（無関係な読み取りがあるときだけ）。
- async関数の同期部分（async IIFE、呼ばれるasync関数、moduleの配列へのasync forEach callbackの単独の場合）: README.md:243（「its reads never become render dependencies, even the ones before its first `await`」）。
- 予防的なcaptureは選択しない（class method、static method、helperが返す関数、`bind`した関数、localのclassの`new`）: README.md:255。読み取りがそれだけのcomponentは選択されず、表示が古いまま残る（`stale`）。無関係な読み取りがあればcaptureされ、oracleと一致する。
- classのgetter（`box.v`）: README.md:243（「a getter or setter」は追跡しない）。managedでは表示が古いまま残る。
- signalの分割代入（`const { value } = s`）: README.md:242。表示が古いまま残る。
- 他のcomponentのrender prop（`<List render={() => s.value} />`）: README.md:249（「Capture is not guaranteed」、RFGS003）。oracleのbareなcollectorが`List`のrender中に開いているため、oracleは購読する。managedでは表示が古いまま残る。

既知の制限（`knownLimitation`）: moduleの配列へのasync forEach callbackは、無関係な読み取りがあるとmanagedでも購読する（README.md:257）。一貫性テストの`knownLimitation`と同じものを、実行で確かめた形である。

### 未決の点

- README.md:379-384は、Hookへ渡した関数が「runs outside the render」と書く。`useEffect`・`useCallback`では正しいが、`useMemo`・`useState`の初期化・`useReducer`の初期化は実際にはrender中に走り、bareな`useSignalTracking()`（とinject）は追跡する。追跡しないという設計は変えないが、文の正確さ、およびmanagedとinjectがここで違う動きをすること（injectは無関係な読み取りがあるときだけ購読する）を書くかどうかは判断が要る。

### Hookのcallbackの説明の修正

実行による差分テストで、READMEの「Hookに渡した関数はrenderの外で実行される」という説明が、`useMemo`のcallbackと`useState`/`useReducer`の初期化関数には当てはまらないことが分かった（render中に実行される）。managedはこれらの読み取りを追わず、injectは、componentがほかの読み取りで選ばれていれば、`useSignalTracking()`の性質で追う。

メンテナの判断で、追わない（managedの挙動）のを仕様とした。結果がHook自身の依存配列によってだけ変わるという、Reactの`useMemo`の考え方に合うため。README（英日）を、render中に実行されるが追わないこと、再描画させたい場合の書き方、injectでの違いが分かるように書き直した。injectの挙動は`useSignalTracking()`の性質によるもので、pluginの側では変えない。

## 最後のレビューの指摘への対応

レビューで再現された7件を、メンテナが承認した範囲で直した。どれも先に回帰テストを書いて失敗を確かめてから直した。分割代入・`for ({ row } of …)`・`st.value.a = 2`・`<theme.value.Icon />`・class fieldの初期化は設計の判断待ちなので触っていない。

1. optional chainの途中の呼び出し（7c45770）: `props.todos?.filter(cb).length`の`filter(...)`だけをcaptureし、`props.todos`がnullishのとき`capture(...).length`で例外になっていた。chainの途中の部分（`continuesOptionalChain`）は単独では置き換えず、chainの一番外側の式が、途中の呼び出しのどれかをcaptureするならchain全体をcaptureする（`optionalChainCalls`）。member側の「親がchainを続けるなら包まない」規則と同じ考え方を、呼び出しにも当てた。`read-shapes.ts`に5件足し（`props.todos?.filter(...).length`は基底がnullishのものとあるもの、`props.f?.().length`、`ext?.(1).length`、`props.api?.load().length`）、実行による差分テストでは基底をnullishにして実行する。
2. 分割代入のpatternのHook（301f9b2）: `const [a = useX()] = list.value;`は宣言全体をcaptureの中で評価するので、HookがRFGS001なしでclosureに入っていた。代入と同じく宣言全体に`expressionCallsHook`を当て、RFGS001を出す。
3. Hookの名前（407d247）: `/^use[A-Z]/`を、babel-plugin-react-compiler 1.0.0の`isHookName`と同じ`/^use[A-Z0-9]/`にした。`isHookCallName`はこれを使い、識別（`isHookName`）も同じ規則になる。`use3D()`はcaptureに入らず、`function use3D()`はHookとして扱われる。
4. RFGS001の一貫性（0aa80ce）: `new`、object/array spread、`in`、型変換（二項演算・template literal・単項演算）、複合代入、更新、`delete`、読み取る呼び出しへの`for...of`が、Hookを含むとき黙ってcaptureをやめていた。すべて`giveUpForHook`を通してRFGS001を出す。オペランドの読み取りはそれぞれcaptureされ、失われるのは演算自身の読み取り（spreadのコピー、`in`、プリミティブへの変換など）だけなので、それを言う文面を足した。呼び出しのうち、予防的なcaptureと引数だけの読み取りは失うものがないので、これまでどおり報告しない。
5. Hookの結果への読み取り（9cd0eba）: `wrapAfterHookBase`を`hookBaseOf`と`splitHookBase`で書き直した。`(useStore() as any).value.name`と`useStore()!.value.name`がRFGS001にならず、Hookの後の読み取りがcaptureされる。
6. RFGS009（8dbf037）: `"use server"`のmoduleでJSXを返す関数すべてに出ていた。component identity（変換が他でも使う規則）を持つ関数だけに出す。小文字のserver action、component内のcallbackには出ない。README（英日）のRSCの節も合わせた。
7. 同じ診断の重複（a148bea）: captureがJSXのcallbackを複製し、複製がもう一度検査されてRFGS003が2回出ていた。重複の判定をnode単位から、file内の位置とID・文面の組にした（複製は元の位置を持つ）。複製を検査しない方法より、どの経路で同じ場所に再び来ても効くのでこちらにした。

残したもの:

- `for (const [a = useX()] of list.value)`のように、loopの宣言patternのdefaultにあるHookは直していない。loopの中のHookはそもそもRules of Hooksに反する。

利用者から見える変化: optional chainのcaptureの形（chain全体を包む）、Hookの名前の規則（`use`の後に数字も含む）、RFGS001が出る場面が増えたこと、RFGS009が出る場面が減ったこと、同じ診断が1回だけ出ること。

## deep signalのalias caseと保留5件

managed-scope-options.ja.mdの判断（v0.4.0は今の契約で出す）に沿って、保留の5件を今の契約の中で直し、deep signalのalias caseを`read-shapes.ts`に加えた。

### deep signalのcase（e966683）

preludeに`deepSignal`（`state`）と`deepCollectionSignal`（`store`）を足し、29件のcaseを加えた。どれもnestedなobjectを局所に取り出してあとで読み、書き込みはnestedなproperty（`state.value.user.name = "Grace"`など）だけを変える。aliasを通した読み取りが追跡されないと再renderしない。在庫表のA1〜A13を覆う（A2は5件、A4は4件、A8は4件、A9は代入形を含めて4件、Map entryの`deepCollectionSignal`が1件）。A14（dry runでのaliasの判定）は全caseの選択で通る。ほかに、保留のうちalias以外の3件のcase（書き込みの基底、JSXのmember tag、class fieldの4件）を足した。

oracleとの食い違いと対応:

- **式を通したalias（63bfac1、不具合）**: `(flag ? user : d).name`、`(user ?? d).name`、`[user][0]!.name`、`[...box][0]!.name`（Setに入れたaliasのspread）の4件。member chainの判定が、memberでも呼び出しでもない基底（条件式、論理式、配列など）で止まり、`.name`をcaptureの外で読んでいた。値を受け渡す式（条件、論理、sequence、配列、object、代入）が基底なら、式として判定する。
- **分割代入（a67873c、保留1）**: `({ user } = state.value)`の`user`をaliasにした。代入のpatternが書く局所変数を、宣言のpatternと同じくflowに足す。
- **代入形のloop head（a307566、保留2）**: `for ({ meta } of state.value.items)`のpatternが書く変数をaliasにした。`for (item of …)`（既存の識別子）はもともと動いていたので、テストで固定した。
- **書き込みの基底（2040b92、保留3）**: `st.value.a = 2`。`isWriteTarget`はmember chainを上へたどって全体を書き込みとみなしていた。書き込みは代入先そのものだけにし、そのobjectはreadとして数えてcaptureする（`capture(() => st.value).a = 2`）。選択もされる。既存テスト4件（`state.value.count = 2`を素通しと固定していたものなど）の期待を新しい出力に直した。あわせて、`wrap`の出力を`generated`に入れた（訪問中でないnodeを包むと二重に包んでいた）。
- **JSXのmember tag（b237847、保留4）**: `<theme.value.Icon />`。tagは呼び出しにできないので、要素を評価する位置でtagを局所に取る（`(_Tag = capture(() => theme.value.Icon), <_Tag />)`、`var _Tag`を関数の先頭に置く）。評価順（tagが先）と遅延評価（`f && <…>`）を保ち、属性と子はその場に残る。選択の走査（`scanFunction`）もこのtagを読み取りと数える。
- **class field（347c682、保留5）**: instance fieldの初期化式は`new`のときに実行されるので、capture passではmethod本体と同じく飛ばす。static fieldとstatic blockはclassの評価時に実行され、本体で宣言したclassではrender中なので、これまでどおりcaptureする（runtimeでもoracleと一致した）。
  - その結果、「本体で宣言したclassをrender中に`new`し、読み取りはそのinstance fieldだけ」というcaseは選択されなくなった。`new Model()`は予防のcaptureで、moduleのclass（既存の「a new expression whose class reads」）と同じ扱いになる。README.md:255の例外として書いた（`expected`と`run.exception`）。以前はfieldの読み取りが書いた場所でcaptureされていたので、偶然選択されていた。localのclassを証明済みの呼び出し先にする案はあるが、class bodyの走査を選択に足す必要があり、今回は入れていない。
- 「Hookに渡したalias」（A13、`useState(user)`の結果を読む）は食い違わなかった。

### 利用者から見える変化

- 書き込みの基底のcapture: `st.value.a = 2`だけを持つcomponentが`auto`で選択され、`st`を購読する（commitは`!`付き）。
- JSXのmember tagの出力の形（`_Tag`）。
- 本体で宣言したclassのinstance fieldだけを読むcomponentは選択されない（`!`付き）。effectだけで`new`する場合の余分な選択がなくなる。
- 分割代入、代入形のloop head、式を通したaliasの読み取りがcaptureされる（READMEの記述どおりになった）。
- README（英日）の「Named functions, JSX spread, getters, and reading assignments」の行に、書き込みの基底、JSXのmember tag、class fieldを足した（行は増やしていない。read-shapesが行番号を引くため）。

## JSXのtag名とrender中の書き込みを方針に合わせて戻した

メンテナの判断で、保留のうち2件の直し方を、ライブラリの方針に合わせて変えた。runtimeは追跡の境界をはっきり保ち、境界の外のものは利用者に先に計算してもらう。まれな書き方のたびに仕組みを足すことはしない。

- **render中の書き込み（8324647、2040b92を戻した）**: `st.value.a = 2`の前の`st.value`の読み取りは、以前どおり数えない（captureせず、選択もしない）。警告も出さない。render中にsignalの状態へ書き込むのは、Reactが禁じる副作用だから（renderは純粋でなければならず、StrictModeでは2回実行される）。追跡のために出力を変える理由がない。READMEのmanagedの契約（英日、README.md:247）に書き、read-shapesのcaseはruntime differentialの例外にした（injectは選択されればoracleと同じく追跡するので、managedの2つとinject単独だけが食い違う）。既存テスト4件の期待は元に戻した。`wrap`の出力を`generated`に入れる変更も戻した。訪問中でないnodeを包むのはこの修正だけで、ほかには要らない。
- **JSXのtag名（0387eed、b237847の出力をやめた）**: `(_Tag = capture(...), <_Tag />)`と`var _Tag`の生成をやめ、tag名での`.value`の読み取りはcaptureも選択もしない。代わりに新しい診断RFGS010をtagの位置に出し、先にcomponentを変数に入れるよう求める（`const Icon = theme.value.Icon; <Icon />`）。報告はRFGS003と同じく、pluginが関数を調べるたびに行う（選択されていなくても出す。`manual`ではopt-inがあるときだけ）。選択されていない関数にも出すのは、選択されないこと自体が、追跡されないことの原因だから。`DIAGNOSTIC_IDS`、`diagnostics.ts`の表、README（英日）の診断表と契約、診断の一覧テストに足した。read-shapesのcaseは例外（stale）にした。READMEの表に1行増えたので、read-shapesが引くREADMEの行番号を1つずつずらした。

分割代入、代入形のloop head、式を通したalias、class fieldの直しはそのまま残す。

## 変換の速さの改善（1〜3）

### profile

warmな1 process、HEAD（9737f65の前）のdistで計測した（コーディネーターの計測と、こちらの`--cpu-prof`の両方）。

- 候補のないfileでも、Babelの処理を全部通っていた。
  - 生成とsource mapは作ってから捨てていた（generatorが約8.5%）。
  - `mightTransform`の`value`は、`{ value: ... }`や`e.target.value`があるとほぼすべてのfileで通っていた。
  - Babelが毎回compilation targetsを解決し、browserslistの設定fileを親directoryごとに探していた（`getTargets`が約0.9%。`lstat`等の残りはmoduleの読み込み時だけ）。
- 候補のあるfileでは、applyManagedが約32%、decideTransformが約26%（うちwouldCaptureRenderReadのdry runが約15%）、parserが約7%、generatorが約6%。ほとんどが`@babel/traverse`。

### 変更

1. **browserslistの探索をやめた（bf3d82f）**: `browserslistConfigFile: false`。このpluginはtargetsを読まない。profileで`getTargets`/`findConfigFile`の分が0になった。
2. **変えていないfileは生成しない（9737f65）**: pluginの`generatorOverride`が、変えたfile（metadataの印と同じ事実）のときだけBabel自身の`generate`を、Babelが正規化した同じoptionで呼ぶ。Babelの`generateCode`が上書きなしで行うことと同じなので、変えたfileのcodeとmapはbyte単位で同じ。`@babel/generator`を直接の依存に足さずに済む（足すとrootのlockfileが変わる）。候補のないfileのprofileからgeneratorの分（8.5%）が消えた。
3. **事前の文字列判定を絞った（84355bf）**: 通すのは次のとき。
   - `useSignalTracking`、`@signalTracking`、`@noSignalTracking`（今までどおり）。
   - module-levelの`"use server"`（RFGS009は読み取りに関係なく出るため。今までは`value`がないと漏れていた）。
   - `value`という語が、名前が`value`のpropertyの読み取りでありうるとき。`.`/`?.`の後（空白やcommentを挟んでもよい）、またはちょうど`"value"`の文字列（computed keyと定数key）。
   - 語を作れるescape（`\u`、`\x`、行継続）があるとき（今までは漏れていた）。
   - `all`での`<`（今までどおり）。
   
   落とすのは、object key、束縛、JSX属性、ほかの文字列、`#value`と、`.target.value`、`.currentTarget.value`、`.current.value`（変換がそれだけではsignalの読み取りとみなさないもの）。
   
   証明: test setup（`tests/prefilter-guard.ts`）がすべてのtest fileで変換の入口を包み、判定が落としたmoduleは判定なしで変換して、変更も診断もないことを確かめる。test全体、`examples/`の追跡されているsource全部、read-shapesの全case（mode 3つ×transform 2つ）がこれを通る。判定をわざと常にfalseにすると、直接の呼び出しとadapter経由の呼び出しの両方で失敗することも確かめた。既存のparse失敗のtest 2件は、入力に本物の`.value`を入れた（変換しないfileの構文errorはbundler自身のparserに任せる）。

出力の同一性: 変更前（HEAD）と変更後のdistで、`examples/`の全source×mode 3つ×transform 2つ×reactCompiler 2つ（360件、うち変換64件）のcode、map、警告がbyte単位で同じ。

### 計測（in-process interleave、ABBA、6 process、load順を交互、順序ごとの中央値の幾何平均）

A/A（旧と旧の写し、雑音の幅）:

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 75.58 | 75.28 | 1.000 |
| managed / react-router app (8 files) | 65.36 | 64.92 | 1.057 |
| managed / synthetic 120 components | 247.47 | 247.99 | 1.017 |
| managed / no-candidate (value keys) | 61.45 | 59.78 | 0.982 |
| inject / browser App.tsx | 59.05 | 58.83 | 1.001 |
| inject / react-router app (8 files) | 55.05 | 56.78 | 1.017 |
| inject / synthetic 120 components | 157.57 | 158.68 | 0.995 |
| inject / no-candidate (value keys) | 64.04 | 64.16 | 1.010 |

A/B（A=変更前、B=変更後）:

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 41.52 | 41.15 | 0.986 |
| managed / react-router app (8 files) | 31.95 | 31.03 | 0.951 |
| managed / synthetic 120 components | 124.24 | 126.95 | 1.032 |
| managed / no-candidate (value keys) | 28.13 | 0.15 | 0.006 |
| inject / browser App.tsx | 26.55 | 26.00 | 0.999 |
| inject / react-router app (8 files) | 28.10 | 26.79 | 0.878 |
| inject / synthetic 120 components | 80.24 | 79.07 | 1.007 |
| inject / no-candidate (value keys) | 27.99 | 0.16 | 0.005 |

- A/Aの幅は±6%程度（react-router managedが1.057）。A/Aと A/Bは別の時間に回したので、msの絶対値は比べられない（比だけを見る）。
- 候補のないfile（`{ value: n }`と`e.target.value`だけ）は判定で落ちるので、約28msが約0.15msになった。
- 変換するfile（App、120 componentの合成file）は雑音の幅の中。react-routerの8 fileはinjectで0.878、managedで0.951。8 fileには候補のないfileが含まれ、そこで判定と生成の省略が効く。

### 残した課題

4. **選択とcaptureを1回の走査にする**: 候補のあるfileで、decideTransformが約26%、そのうちwouldCaptureRenderReadのdry runが約15%。dry runはcapture passと同じvisitorをもう一度回している。選択の判定をcapture passの結果から取れば、この分の大半が減る。ただし選択とcaptureの構造の変更なので、別に判断する。
5. **再走査を減らす**: applyManagedが約32%で、ほとんどが`@babel/traverse`。`hasTrackedReadInExpression`の部分木走査、`inspectFunction`のsubtree走査、`path.scope.crawl()`などが同じnodeを何度も歩く。cacheか、走査の統合で減らせる見込み。

## 変換の速さの改善（設計メモの1〜3）

`transform-performance-design.ja.md`の推奨1〜3を、この順に入れた。記録と再生、巻き戻し、走査の統合、ほかの項目は行っていない。

1. **`decideTransform`の`inspectFunction`を遅延にした（30ec5da）**: componentでもHookでもない関数（callback、handler）では読まれないので、最初に読まれたときに計算する。`inspectFunction`はmemoへの書き込み以外に副作用がない。
2. **visitorの`explode`を1回にした（cbb4a18）**: `traverseHandlers`が、handlerのkeyの組ごとに1つの振り分けvisitorをmodule内で作って使い回し、handlerは走査のstateとして渡す。handlerは今までどおりclosureを持ち、同じ`path`を受け取るので、`skip`と`stop`の意味は変わらない。`rendersJsx`、`hasDynamicCallTarget`、`expressionCallsHook`は`t.traverseFast`にした。`traverseFast`は根も訪れるので、根自身は入れ子の関数として飛ばさない（`expressionCallsHook`の根が関数のとき、`path.traverse`はその中へ入っていた。同じにした）。realisticのprofileで`explode`は5.0%から0.1%になった（1で走査が減った後の値）。
3. **dry runの別名と、paramの判定を共有した（f6dfe7e）**: 判定1回分の`SelectionAnalysis`に、paramのnodeごとの`parameterMayReadTrackedValue`の答えと、別名の集合を入れる。別名は、paramを移動しておらず、分割代入を展開する前だけ使う（メモの条件どおり）。移動したparamは新しいnodeになるので、古い答えは読まれない。`addRuntimeImport`は`registerDeclaration`で新しい名前を1つ足すだけで、関数のBindingは変わらない。
   - メモとの違い: 実際のpassには、集合そのものではなく写しを渡す。`trackedReadCache`は集合のidentityをkeyにしており、dry runで入れた答えは作者が書いたままのASTについてのものである。実際のpassは途中でnodeを変える（読み取りを生成したarrowの中へ移すと、その部分木の判定は変わる）ので、dry runの答えをそのまま使うと、今は新しく計算している判定と違う答えになりうる。写しにすれば、別名の収集1回分は削れ、cacheは共有しない。メモが見込んだ`trackedReadCache`のhitの分は取っていない。

同一性: 各段で、前のcommitのdistと比べて、`examples/`の全source、120 componentの合成file、realisticの30 componentのfileを、mode 3つ×transform 2つ×reactCompiler 2つで変換し（384件、うち変換80件）、code、map、警告がbyte単位で同じだった。全suite（selection-capture-consistency、runtime-differential、事前判定のsetupを含む）は変更なしで通った。

### 計測（in-process interleave、ABBA、順序ごとの中央値の幾何平均）

realisticは、メモの説明（30 component、各componentに`useEffect`、`useCallback`、`setTimeout`、`map`のcallback、event handler、外部の`format`、`memo`したcomponent）から作り直した。

A/A（変更前と、その写し。6 process）:

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 47.37 | 46.56 | 1.013 |
| managed / react-router app (8 files) | 42.08 | 43.75 | 1.036 |
| managed / synthetic 120 components | 184.17 | 190.61 | 1.021 |
| managed / realistic 30 components | 259.77 | 263.54 | 1.032 |
| inject / browser App.tsx | 34.56 | 34.26 | 1.010 |
| inject / react-router app (8 files) | 32.60 | 32.07 | 0.970 |
| inject / synthetic 120 components | 107.34 | 109.14 | 0.965 |
| inject / realistic 30 components | 192.91 | 196.95 | 1.013 |

A/B（A=変更前の3b8a021、B=3つの後。6 process）:

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 40.97 | 35.37 | 0.895 |
| managed / react-router app (8 files) | 32.03 | 28.57 | 0.940 |
| managed / synthetic 120 components | 136.65 | 108.53 | 0.802 |
| managed / realistic 30 components | 234.27 | 188.88 | 0.810 |
| inject / browser App.tsx | 28.87 | 27.16 | 0.909 |
| inject / react-router app (8 files) | 29.48 | 27.37 | 0.920 |
| inject / synthetic 120 components | 96.91 | 79.64 | 0.856 |
| inject / realistic 30 components | 190.34 | 166.01 | 0.862 |

段ごと（各4 process。比だけを見る）:

| case | 1（遅延） | 2（visitor） | 3（共有） |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 0.959 | 0.993 | 0.977 |
| managed / react-router app (8 files) | 0.958 | 1.000 | 0.987 |
| managed / synthetic 120 components | 0.975 | 0.832 | 0.941 |
| managed / realistic 30 components | 0.916 | 0.922 | 0.918 |
| inject / browser App.tsx | 0.909 | 0.922 | 1.046 |
| inject / react-router app (8 files) | 0.875 | 0.955 | 1.008 |
| inject / synthetic 120 components | 0.959 | 0.828 | 0.990 |
| inject / realistic 30 components | 0.864 | 0.943 | 1.016 |

- A/Aの幅は±4%程度。
- 3つ合わせて、managedはrealisticで−19%、合成120で−20%、Appで−11%、react-routerで−6%。injectはrealisticで−14%、合成120で−14%、Appで−9%、react-routerで−8%。
- 1はcallbackの多いinput（realistic、react-router、inject）で効き、メモの見込み（realistic −9〜11%）に近い。2は合成120（関数ごとの走査が多い）で−17%。3はmanagedだけに効き（injectはdry runの別名を使わない）、realisticで−8%、合成120で−6%。injectの3は雑音の幅の中。

## 共通化作業のレビューの指摘への対応

`3d24005..HEAD`のレビューで、最近のcommitによる退行が10件見つかった。すべて直した。

**先に訂正する。** 速さの改善の記録に書いた「byte単位で同じ」は、その比較に使ったcorpus（`examples/`と合成file）についてだけの主張だった。退行を起こす書き方がcorpusになかったので、1と2を見逃した。出力が変わらないことの証明ではなかった。今回は入力を全testから集めて比べ直した（下の「広げた同一性の確認」）。

### 追跡が黙って失われていたもの

1. **事前の文字列判定（cde5f65）**: `.current.value`、`.target.value`、`.currentTarget.value`を落とす規則を外した（メンテナの判断）。receiverの前の`.`を見ていたので、`[...target.value]`、`<p {...current.value} />`、`f(...current.value)`、末尾が句点のcommentの後の`current.value`も落としていた。文字列では区別できない。行commentの終わりにCR、U+2028、U+2029を足した。語を作れるidentity escape（`"v\alue"`）も通す。
   - **今も落とすもの**: object key、shorthand、束縛、JSX属性、ちょうど`"value"`でない文字列、`#value`、`value`を含む長い名前（`values`、`valueOf`、`defaultValue`）。
2. **遅延した`inspectFunction`（a39a7e2）**: scanのmemoが遅く埋まるので、書き換えた後のASTを走査することがあった。関数を書き換える直前にその関数のscanをmemoする（`scanBeforeRewrite`）。書き換えない関数は聞かれるまで走査しないので、節約は残る。`30ec5da`を戻す必要はなかった。
   - これで宣言の順序にもよらなくなった。`160975e`でも順序に依存していた（下の「広げた同一性の確認」の2件）。
   - ほかの遅延・共有の状態も確かめた。`traverseHandlers`のstateは走査1回分のhandlerだけで、ASTの答えを持たない。`SelectionAnalysis`は同じ関数の判定と変換の間だけ生き、その間にASTは変わらない（`addRuntimeImport`は新しい名前を1つ登録するだけ）。別名の集合は写しを渡すので、dry runの`trackedReadCache`も読まない。問題はなかった。
3. **`new`を通したinstance field（f0c339c）**: 関数内で宣言したclassの`new`は、field初期化式（継承分を含む）の読み取りを読み取りとして数える（選択とcapture）。instanceはaliasになるので、deep signalのnestedなobjectを持つ`m.user.name`も追跡する。effectの中だけの`new`、`new`されないclass、fieldが持つ関数は選択しない。helperの中のclassも同じ。read-shapesの例外は消した。moduleのclassは予防のままで、READMEもそう直した。
4. **`skipInstanceField`（f39bce1）**: 初期化式だけを飛ばす。computed keyとdecoratorの引数はclassの評価時に実行されるのでcaptureする。class methodのcomputed keyは`Function`のskipで見ないまま残っている。これは今回の退行ではなく`3d24005`以前からの動作で、直していない。
5. **別名（d66a889）**: 代入先を自分で歩く。parameterも入り、TypeScriptのwrapperを通す。`({ row } = state.value)`、`[(row as any)] = list.value`、`(row as any) = ...`、parameterへのloop headが別名になる。

### 診断

6. **RFGS010の場所（a2fffed）**: `isDeferredFunction`（ほかの読み取りと同じ規則）で後回しになる関数の中、`useSignalTracking()`の下、`@noSignalTracking`の関数、injectが選択した関数では出さない。判定はpluginの`JSXOpeningElement`で行う。その時点で外側の関数はすべて判定済みなので、選択の結果を使える。
7. **RFGS010のreceiver（a2fffed）**: `isNonSignalValueReceiver`と同じ規則にした。1で判定が`.current.value`を落とさなくなったので、ほかの読み取りの有無で診断が変わることはない（テストで固定した）。
8. **RFGS009（d586b34）**: 明示の注釈はidentityによらず報告する。
9. **for-of（d586b34）**: `wrapCallChain`と同じ規則。予防は報告せず、1か所で1回。読むgeneratorのように`visitCall`が報告しない証明済みの読み取りだけ、loopの側で報告する。全corpusで、同じIDが同じ位置に2回出る入力は0件だった。
10. **RFGS002（d586b34）**: Hookのlinkには出さない。`useThing?.().length`が`useThing().length`と同じになった。

### レビューが上限のために省いた2件（どちらも退行で、直した。d586b34）

- `delete a?.b().c`はchainのlinkのcaptureを失っていた。delete全体をcaptureする。
- `useT(sig.value) + "x"`はRFGS001を新しく出していた。演算の報告は、Hookの引数以外に読み取りのあるoperandがあるときだけにした。`sig.value + useX()`は今までどおり報告する。

### 広げた同一性の確認

setupのwrapperで全testの入力を集め（重複を除いて6338件、`160975e`で変換4524件）、`160975e`のbuildと比べた。codeとmapと警告を比べている。

- `160975e`と今回の直前のHEAD（`a407f57`）: 7件。helperの退行（2の修正対象）4件と、判定が落としていたRFGS010が3件。古いcorpusでは見えなかった。
- `160975e`と今回のHEAD: 220件（81種類の入力）。読んで分類した。
  - 別名（5）、instance fieldとcomputed key（3、4）、RFGS010（6、7）、RFGS009（8）、loopのRFGS001（9）、delete、Hookの結果のRFGS001。どれも今回の修正そのもの。
  - `setup()`の中のclassで選択されなくなった2件（3）。以前はhelperの中のfieldの読み取りを数えて選択していた。
  - 順序の修正（2）で変わった2種類。`Label`を`helper`より前に宣言した場合に選択される。`Row`を先に宣言した`<Grid renderItem={Row} />`でRFGS003が出る。後者は修正の副作用で、最初は説明がつかなかった。`160975e`で確かめると、`List`を先に書けばRFGS003が出て、`Row`を先に書くと出なかった。古い走査が書き換え後のASTを見ていた同じ不具合で、今はどちらの順でも出る。テストで固定した。
- **説明のつかない差は残っていない。** ただしこれも集めたcorpusについてである。

### 利用者から見える変化

- 新しく追跡する: 関数内のclassの`new`のfield、そのinstance、computed key、decoratorの引数、parameterやwrapperへの分割代入の別名。
- 選択しなくなる: helperの中で`new`されないclassのfield。
- RFGS010が減る（handler、Hookのcallback、追跡中の関数、DOMやrefのfield）。RFGS001が減る（予防のloop、Hookの結果の演算、loopの2重報告）。RFGS002が減る（Hookのlink）。
- RFGS009が戻る（注釈があれば小文字の関数でも）。RFGS003が宣言の順によらず出る。
- 構文errorのあるfileで、`value`がobject keyなどにしかないものはpluginがparseせず、bundlerのparserに任せる（前の変更から）。
- README（英日）のclass fieldとRFGS010の文を直した。行は増やしていないので`README.md:NNN`の引用はそのまま有効である。

### 速さ（A=`a407f57`、B=今回。6 process。この回のA/Aは取っていない。前回のA/Aは±4%）

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 38.15 | 36.80 | 1.001 |
| managed / react-router app (8 files) | 27.24 | 28.07 | 1.031 |
| managed / synthetic 120 components | 110.72 | 116.44 | 1.064 |
| managed / realistic 30 components | 175.91 | 186.36 | 1.051 |
| managed / no-candidate (value keys only) | 0.09 | 0.08 | 0.856 |
| managed / no-candidate (with e.target.value) | 0.15 | 25.01 | 172.664 |
| inject / browser App.tsx | 25.94 | 27.90 | 1.048 |
| inject / react-router app (8 files) | 24.83 | 25.53 | 1.021 |
| inject / synthetic 120 components | 76.97 | 82.36 | 1.065 |
| inject / realistic 30 components | 155.43 | 167.06 | 1.071 |
| inject / no-candidate (value keys only) | 0.09 | 0.08 | 0.899 |
| inject / no-candidate (with e.target.value) | 0.14 | 24.48 | 187.370 |

- 変換するfileは0〜7%遅くなった。合成120とrealisticの+5〜7%は雑音の幅を少し超える。原因は個別に測っていないが、`scanBeforeRewrite`の分が候補に挙がる。
- `e.target.value`を含む候補のないfileは約0.15 msから約25 msに戻った。これが1の代償である（`e.target.value`のある普通のformのfileは全処理を通る）。`{ value: n }`とJSX属性だけのfileは落ちたまま（約0.08 ms）。

## 2026-11-03: レビューの指摘10件の修正、indirectなclassの決定

メンテナが承認した一覧を直した。主張は下に書いた入力で確かめた範囲に限る。browser e2eは流していない。

**先に訂正する。** b998fbbの「RFGS003は宣言の順によらず出る」というtestは、順序によらないことは正しかったが、出るという答えが間違っていた。`<Grid renderItem={Row} />`（`const Row = (item) => <li>{item.value}</li>`）の`Row`は自分のboundaryを持ち、DOMも更新される。そのtestは静かであることを固定するように変えた。

### 直したもの

1. **concise arrowの参照（796f9fc、指摘1と2）**: bodyのslotを`replaceWith`で置き換えると、古いpathがblockを持ち、その下の`Binding`の参照から見て親がcallでなくなる。`all`と注釈付きの`manual`にはdry runがないので、`isRenderCallback`が誤った答えを覚え（`() => items.map(Row)`の`Row`にboundaryが付き、配列が増えると「Rendered more hooks」で落ちる）、`isPlainCallee`がnoと答えた（`() => Label()`がcaptureされず古いまま）。`path.ensureBlock()`は古いpathを新しい`return`の下へ移すので、何かが尋ねる前に正しくなる。crawlもwalkも足さないので、関数ごとの費用は増えない。
   - 他のrewriteの同じ問題を調べるため、`isPlainCallee`と`renderCallbackCallers`に渡る参照の親が本当にその参照を持っているかを数えるcheckをbundleに差し込み、read-shapesの全caseと追加の入力を全modeで流した（3054回）。修正前は6種、修正後は1種。残る1種は、capture passが`x.map(Row3)`を包んだ直後からその関数の最後のcrawlまでの間だけ親が古いもので、出力が変わる入力は見つかっていない。
   - `auto`はdry runが答えを先に埋めるので、試した入力（19形×両順序に加えて12形×両順序）では修正前も出力が順序で変わらなかった。露出しないことの証明ではない。
2. **複合代入（a5861ef、指摘3）**: `sig.value += 1`、`??=`、`||=`を、`++`と同じく読み取りとして数える。単独の`=`と分割代入のtargetは書き込みのまま。
3. **patternのdefault（71f9c6b、指摘4）**: `AssignmentPattern`のdefaultを、そのtargetが束縛するものの源として扱う。parameter、宣言、代入、配列、loop head、defaultが別名の場合で、実際にmountして更新を確かめた。
   - **残した穴**: defaultを分割代入する`{ a: { name } = state.value.user }`はmanagedで古いまま（injectは更新する）。`name`は別名ではなくcaptureの外で読まれた値である。修正前からの動作で、直すには3つのvisitorに同じ判定を足すことになるので、機構を増やさず報告に留めた。
4. **RFGS003（4ceab91、指摘5）**: 名前で渡された関数が、選択された、`@signalTracking`、自分の`useSignalTracking()`、`@noSignalTracking`のどれかなら報告しない。宣言があとの場合があるので、選択の答えはfileの終わりに読む（captureが作るcloneにも答えるため、関数は開始位置で引く）。boundaryのない関数（小文字のhelper、JSXのない関数、`map`に渡す関数、plainに呼ぶ関数、async）とinlineのcallbackは報告する。
5. **RFGS002（03f2f78、指摘6）**: helperの畳み込みがHookを呼ぶhelperを飛ばしていたのをやめた。`title`、`const title = () => ...`、`o.t()`、後方宣言、推移的な読み取りで`Title`と同じ結果になる（managedはRFGS002で古いまま、injectは更新する）。読み取りのないhelperは静か。
   - 確認した既存の動作: `Title`→`Inner`のように、Hookが1段深いと`capture(() => Title())`の中でHookが動く。今回`title`→`inner`も同じになった。更新はするが「Hookをcaptureのclosureに入れない」という説明とは合わない。変えていない。
6. **RFGS006（6668f6f、指摘7）**: 注釈が書かれた関数自身が、返すものについて尋ねる（深さ、ブロックかconciseか、名前経由かを問わない）。
   - `/** @signalTracking */ const a = () => [1].map(() => <p />)`も報告する。`a`には同一性がなく出力も変わらないので本当に効いていない。`const a = () => <p />`が報告されるのと同じ意味である。
   - `return function W() {}`は`manual`でだけ報告する。`auto`と`all`では選択が`W`を見るので、失うものがない。
7. **RFGS004（36ec9e9、指摘8）**: 手書きのboundaryの前のdefaultを報告する。移動はしない。判定は移動の規則と同じなので、`{ x = ext() }`のように中が見えないcallも報告する。後方の`useSignalTracking()`も同じ。
8. **RFGS010（649cf39、指摘9）**: `/utils`のcallbackの中のtagは報告しない。RFGS003と同じ`isOwnedBySignalControlFlow`に尋ねるので、`Match`の孤児と`fallback`は報告のまま。
9. **pre-filter（3146c45、指摘10）**: `manual`でも`spellingEscape`を見る。`\n`、`\t`、`\d`のある普通のfileはparseしない。`"u\seSignalTracking"`のように`\s`で綴る文字列のimport名だけは今も落ちる。

### indirectなclassの決定

間接に届くclass（条件、factory、mixin、`const L = K`、objectやarrayの中）の`new`は追わない、とメンテナが決めた。ライブラリの方針は、追跡の境界がcodeから読めることと、その外のものは利用者が先に計算することであり、どこまでも追うのはこれに反する。追うようにしないことをread-shapesの`expected`に固定した。constructor本体、fieldの中のIIFE、static factory、methodのcomputed key、method decoratorの引数も同様に固定した（decoratorのcaseは実行harnessがdecoratorを下げないので静的な確認だけ）。

### testの穴

前回のmutationで生き残ったものに対してtestを足し、mutantを当て直した（結果は下）。`read-shapes.ts`の「`.value`がそれだけのfile」というコメントは誤りだった。preludeが常に`s.value`を読むので、pre-filterは試されていなかった。`prefilter.test.ts`にpreludeなしの最小moduleを足した。`token: "value"`はcompanionの`o.value`にも一致していたので`// note`にした。

mutantの当て直し: 依頼された穴に対応するもの（`#x`のfield、inlineのclass、再代入されたclass、fieldの中のobjectの関数、wrapされた代入先2種、`seenValue`、`"use server"`、Hookの結果への`++`と`delete`、pre-filterのreceiver除外）はすべて落ちるようになった。今回の修正を戻すmutant 13件もすべて落ちた。

生き残った5件はテストを足さず、消してもいない。`transform.ts`から作ったbundleに各mutantを当て、read-shapesの全case（companionあり・なし）と、各mutant向けに書いた入力を6通りの組み合わせで流した（2550回）。出力も警告も、どのmutantでも変わらなかった。

- `scanBeforeRewrite`のinject側: injectは読み取りをcallbackへ動かさないので、後からscanしても同じ読み取りが見える。今回の入力では効果がない。managed側は必要である。
- `foldInstantiatedFields`の`isDeferredReadContext`: `inspect().readsValue`は選択の必要条件にすぎず、最後はdry runが決める。dry runはdeferredな`new`を包まない。冗長と見ている。
- `injectedFunctions`: 同じ`isUntrackedJsxTagRead`の`hasSignalTrackingCall`が、注入された呼び出しを新しいscanで見つける。冗長と見ている。
- `isFirstStatementSignalTrackingCall`の分岐: 同じ理由で試した入力（別名、namespace、barrel）では差がない。
- `delete`のchainのdeferred確認: effect、handler、timer、asyncの入力で差がない。

いずれも「試した入力で差がない」という結論で、到達不能の証明ではない。

### 速さ（A=`76657c4`、B=今回のcommit、どちらもesbuildのbundle。in-process interleave、ABBA、6 process、load順を交互。この回のA/Aは取っていない。前回のA/Aは±4%）

A msとB msはそれぞれの側の中央値、B/Aはload順ごとに取った中央値の比の幾何平均で、A msとB msの比とは一致しないことがある。

| case | A ms | B ms | B/A |
| --- | ---: | ---: | ---: |
| managed / browser App.tsx | 41.72 | 41.03 | 0.984 |
| managed / react-router app (8 files) | 30.29 | 29.58 | 0.975 |
| managed / synthetic 120 components | 118.05 | 116.85 | 1.002 |
| managed / realistic 30 components | 200.78 | 199.45 | 0.998 |
| managed / no-candidate (value keys only) | 0.08 | 0.08 | 1.006 |
| managed / no-candidate (with e.target.value) | 27.99 | 28.13 | 1.016 |
| inject / browser App.tsx | 30.05 | 31.53 | 1.002 |
| inject / react-router app (8 files) | 24.47 | 25.22 | 0.986 |
| inject / synthetic 120 components | 77.90 | 80.40 | 1.012 |
| inject / realistic 30 components | 148.02 | 154.68 | 0.998 |
| inject / no-candidate (value keys only) | 0.08 | 0.08 | 1.002 |
| inject / no-candidate (with e.target.value) | 25.04 | 25.50 | 0.996 |

関数ごとの費用を足したのはRFGS004の確認で、分割代入のparameterを持つ関数すべてのparameterを歩く。crawlは足していない。どのcaseも前回のA/Aの幅の中で、差は見えなかった。

### 観察したこと（直していない）

`<Grid renderItem={Row} />`で`Grid`が`items.map(renderItem)`と呼ぶと、`Row`のHookがloopの中で動く。mountしたところ、`items`が増えると「Rendered more hooks」、減ると「Rendered fewer hooks」で落ちた（`auto`と`all`、managedとinject）。長さが同じならsignalの書き込みで更新する。`76657c4`でも同じ入力で同じように落ちるので今回の退行ではないが、当時はRFGS003が（別の理由で）出ていて、今は出ない。このcrashを指す診断は、もともとない。

### 引用の訂正

「共通化作業のレビューの指摘への対応」の節にある「`README.md:NNN`の引用はそのまま有効」は誤りだった。`tests/read-shapes.ts`の引用がずれていたので、241f65eで現在の行に直した。parameter defaultの1か所（557-563）、async関数の1か所（550-555）、Hookに渡す関数の3か所（380-385から384-389）である。この3か所の引用文はREADMEの今の文と一致していないので、test側で文言も直す。それ以前の節の行番号は、書いた時点のREADMEを指す。

### 方針の確認（2026-11-03）

メンテナが方針を確認した。Reactのbest practiceから外れる書き方や、VueやSolidでも追跡しない形は、変換で追いかけずに診断か文書化した制限にして、変換を軽く保つ。

その一例として、render中の複合代入（デバッグ用のrender回数`renders.value += 1`など）は、a5861efで読み取りとして数えるようになったため、`++`がもともとそうだったように、書き込む値をcomponentがsubscribeして再描画が止まらなくなる。特別扱いはせず、READMEとmigrationに書いた（8f10364、b75b413）。
