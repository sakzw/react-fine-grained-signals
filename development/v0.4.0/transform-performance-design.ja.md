# transformの性能改善の設計（調査）

`unplugin-react-fine-grained-signals`のBabel transform（`src/internal/transform.ts`）が1ファイルあたりに使う時間を減らすための設計調査。実装はしていない。行番号はすべてHEAD（`160975e`）の`transform.ts`のもの。

出発点は、120 componentのファイル（`benchmarks/transform.mjs`の`large`）を変換したときのCPU profileである。plugin時間のうち`applyManaged`が約32%、`decideTransform`が約26%（うち`wouldCaptureRenderRead`のdry runが約15%、`readsValue`が約15%で重なる）、`@babel/parser`が約7%、generatorが約6%。大半は`@babel/traverse`の中（関数ごとの`path.traverse`、scopeのcrawl、`invalidateThisReferences`）にあった。

この文書は次の2つを扱う。

- (4) 選択（dry run）と実際のcapture passで、同じ解析を2回行っている。これを1回にできるか。
- (5) 関数ごとの再traverseを減らせるか。そのほかのBabelレベルのコストを避けられるか。

## 計測の方法と注意

- HEADの`src/internal/*.ts`を`git show`でscratchpadへ写し、Node 24の`--experimental-transform-types`で直接読み込んだ（distは使っていない）。関数をラップして呼び出し回数と包含時間を測り、`NodePath.prototype.traverse`と`Scope.prototype.crawl`を数えた。
- 入力は2つ。`bench120`は`benchmarks/transform.mjs`の`reactiveSource(120)`と同じもの（各componentは`.value`の読み取りを1つだけ持つ小さな関数）。`realistic`は、自作の30 component（各componentに`useEffect`、`useCallback`、`setTimeout`、`map`のcallback、event handler、外部import `format`、`memo`したcomponentを持つ。1 componentあたり関数16個、計480個）。
- 計測中に別のagentがbenchmarkを走らせていたので、絶対値は±30%程度ぶれる。比はラップのオーバーヘッドを含む。以下の「%」は目安として読む。同じプロセス内で交互に走らせて比べた数字（「交互計測」）が一番信頼できる。

### 1ファイルあたりの主な数字（managed、`mode: "auto"`）

| 項目 | bench120 | realistic |
|---|---|---|
| ファイル全体（ラップなし、最小値） | 約128 ms | 約350 ms |
| `Function` visitorが`decideTransform`を呼ぶ回数 | 120 | 480 |
| 変換された関数 | 120 | 30 |
| `path.traverse`の呼び出し（すべて新しいvisitor objectで呼ばれる） | 1620 | 2460 |
| そのvisitorの`explode`にかかる時間 | **約25 ms（約20%）** | **約50 ms（約14%）** |
| `scanFunction`の呼び出し | 240 | 600 |
| `inspectKnownRenderPropReads`のtraverse | 120 | 480 |
| `collectTrackedReadAliases` | 240（dry 120＋実際 120） | 60（30＋30） |
| `captureTrackedReadExpressions` | 240（dry 120＋実際 120） | 60（30＋30） |
| `parameterMayReadTrackedValue` | 267（分割代入のparamを持つ89関数×3） | 90 |
| `applyManaged`の`path.scope.crawl()` | 120回、ラップ込みで約18 ms | 30回、約22 ms |
| Babel自身のprogramのcrawl（1回） | 約12 ms | 約32 ms |

injectの`explode`はbench120で約16 ms、realisticで約33 ms（traverse 1065回、1530回）。

一番大きな発見は、**各`path.traverse`に毎回新しいvisitor objectを渡しているため、Babelが毎回visitorを`explode`し直している**ことである。`@babel/traverse` 8.0.7の`explode$1`は`visitor._exploded`でしかcacheしない。`explode`はaliasの展開（`Function`→関数の全種類）、`verify$1`（keyごとに`TYPES.includes`）、`ensureCallbackArrays`を毎回行う。単体で測ると、3 keyのvisitorで約10 µs、`scanFunction`の10 keyで約19 µs、`captureTrackedReadExpressions`の21 keyで約49 µsかかる。profileで「traverseの中」に見えていた時間のかなりの部分がこれである。

## (4) 解析を1回にする

### 今の流れ（managed、選択される関数）

| 順 | 場所 | 内容 | ASTの変更 |
|---|---|---|---|
| 1 | `decideTransform` 3385 | `inspectFunction`（関数全体の`scanFunction`） | なし |
| 2 | 同 3390 | `inspectKnownRenderPropReads`（入れ子も含めて全体をtraverse） | なし |
| 3 | `readsValue` 3389 → `wouldCaptureRenderRead` 6651 | `parameterMayReadTrackedValue`（paramごと）→ `collectTrackedReadAliases` → `captureTrackedReadExpressions(dryRun)`。最初に見つかったところで`path.stop()`（6539〜6555）。`emit`（5878）のたびに部分木への`inspectFunction`（`scanFunction`を`subtree`付きで）を呼ぶ | なし |
| 4 | `applyManaged` 6681 | `relocateTrackedParameters`（ここでも`parameterMayReadTrackedValue`、3664）→ 残ったparamの再確認（6695、3回目）→ `body.replaceWith`（簡潔なarrowの本体を`return`にする）→ `collectTrackedReadAliases`（2回目）→ `expandTrackedObjectDestructuring`（展開したら`crawl`して別名を取り直す）→ `captureTrackedReadExpressions`（2回目、実際の変換）→ `body.replaceWith` → `crawl` → `invalidateThisReferences` | あり |

dry runは「作者が書いたままのAST」を見る。実際のpassは、parameterの移動、簡潔なarrowの`return`化、分割代入の展開の**後**のASTを見る。この差が、どの案でも一番の制約になる。

### 案の比較

| 案 | 内容 | 削れる量（bench120） | 正しさのリスク | コード量 |
|---|---|---|---|---|
| A. 記録して再生 | dry runでcaptureする位置を記録し、実際のpassではそれを編集として適用する | dry runではなく実際のpassの解析部分（約10〜15%） | **高い**。dry runは移動・展開の前のASTを見ているので、記録した位置と実際に変換する位置が一致しない（`const { a } = state.value`は、dry runでは`capturedDestructuring`の1件、実際には展開した`_trackedSource.a`などの複数件）。再生側でこの差を再現すると、captureの規則が2か所に書かれることになり、79f9bdaで消した「選択とcaptureの規則が別々」に戻る | 大 |
| B. 実際のpassを記録モードで走らせ、選択されなければ巻き戻す | `applyManaged`を先に走らせ、`emit`/`warn`で`coversRenderRead`を記録する。選択されなければ元に戻す | dry run全体（約15%）。ただしmanagedだけ | **中〜高**。(1) injectは選択に同じ答えを使う（一貫性テストの不変条件2）ので、injectではdry runが残る。(2) 巻き戻しには関数nodeの深いcopy（または`replaceWith`の逆順適用）と再crawlが要る。(3) `generateUidIdentifier`がprogramのuidを消費するので、巻き戻した関数の後の`_signals2`などの名前が変わる。(4) `reportWarning`をbufferし、選択時だけ出す必要がある。(5) `addRuntimeImport`（`decideTransform`の最後）を遅らせる必要がある。(6) RFGS007・RFGS008の判定（`decideTransform`の3448〜3473）は変換しない関数でも`readsValue()`を呼ぶので、そこではdry runが残る。(7) READMEの「予防的なcaptureだけでは選択しない」規則は、記録した`coversRenderRead`で保てる | 大 |
| C. 2つのpassで解析結果を共有する | dry runで作った別名の集合（`collectTrackedReadAliases`の結果）を、parameterを移動せず分割代入も展開しなかったときに実際のpassでそのまま使う。`hasTrackedReadInExpression`の`trackedReadCache`（3799）は別名の集合のidentityをkeyにしているので、同じ集合を渡せばdry runで計算した答えが実際のpassでもcacheに当たる。`parameterMayReadTrackedValue`の答えはparamのnodeをkeyに1回の判定の中で共有する | `collectTrackedReadAliases`の1回分（約4%）、`parameterMayReadTrackedValue`の2回分（約4%）、実際のpassの`hasTrackedReadInExpression`の一部 | **低い**（条件を守れば）。下の「Cの条件」を参照 | 小〜中 |
| D. dry run自体を安くする | dry runは最初に見つかったところで止まるので、選択される関数では固定費（visitorの`explode`、`guarded` visitorの組み立て、別名の収集、部分木の`scanFunction`）が大半を占める。(5)のvisitorの事前`explode`と、Cの共有で固定費を削る | dry runの半分以上（約8〜10%）。injectにも効く | **低い**。規則は変えない | (5)と共通 |

**推奨: CとD。AとBは今は行わない。** 理由:

- dry runは選択される関数では最初の読み取りで止まるので、正味の解析量は小さい。profileの約15%の多くは、visitorの`explode`、別名の2回の収集、paramの3回の判定といった**固定費**である。DとCでそれを削れば、Bで消せる量との差は数%しか残らない。
- Bはmanagedにしか効かず、injectとRFGS007/RFGS008の判定にはdry runが残る。uidの採番、警告のbuffer、importの遅延という副作用の扱いが増え、出力の名前が変わるとsnapshot系のテストが大量に変わる。得られる数%に対してリスクが大きい。
- Aは、79f9bdaで直した「選択とcaptureが別々の規則で読み取りを判定する」状態を再び作る。

### Cの条件

- 別名の集合を使い回してよいのは、`relocateTrackedParameters`が何も移動せず（`relocated.length === 0`）、かつ`expandTrackedObjectDestructuring`が何も展開しなかったときだけである。移動したparamは本体の`let`宣言になり、そのdefaultが新しい別名を作りうる（`({ v = count.value })` → `let { v = ... } = _param`）。展開すると`crawl`でBindingが作り直され、古い集合のBindingは無効になる。
- 簡潔なarrowの本体を`return`文にする`body.replaceWith`（6702）では、文や式のnodeは同じobjectのままで、crawlもしないので、Bindingはそのまま有効である。
- dry runは別名の集合を変更しない（`for...of`の分割代入で`trackedAliases.add`する処理（6284〜6288）は、`emit`がfalseを返した後には届かない）。実際のpassは集合に追加するが、dry runの後なので問題ない。`trackedReadCache`は集合の`size`が変わるとその集合のcacheを捨てるので、追加後の古い答えは使われない。
- 受け渡しは、`decideTransform`の`TransformDecision`（3317）に`aliases?: Set<object>`を足すのが一番小さい。`readsValue()`が呼ばれなかった（dry runが走っていない）関数では`undefined`になり、今どおり集めればよい。
- `parameterMayReadTrackedValue`のcacheは、paramのnodeをkeyにした`WeakMap`でよい。移動したparamは新しい`Identifier`に置き換わり（3722）、`Identifier`は先頭の早期returnで`false`になるので、古い答えを読むことはない。

## (5) 再traverseを減らす

### 関数ごとのtraverseの一覧

「呼ばれる条件」の列の「全関数」は、`Function` visitorが訪れるすべての関数（生成したcapture callbackを除く）を指す。realisticでは480個のうち450個がcallbackやhandlerで、変換されない。

| 場所（行） | 何をtraverseするか | 入れ子の関数 | 呼ばれる条件・回数 | visitorのkey数 |
|---|---|---|---|---|
| `scanFunction` 2665 | 関数全体 | 境界とrender prop以外は中へ入る | **全関数**（`decideTransform` 3385）。fold先は`synchronousScan`でnodeごとにmemo | 10 |
| `scanFunction` 2674 | 部分木（`subtree`） | 同上 | dry runの`emit`/`warn`ごと、別名・localな値の初期化式ごと | 10 |
| `scanFunction` 2582 | paramのpattern | — | parameterを呼ぶcallごと | 1 |
| `inspectKnownRenderPropReads` 3138 | 関数全体 | **すべて中へ入る** | **全関数**（manual以外）。入れ子のcallbackは祖先の数だけ何度も歩かれる | 3 |
| `rendersJsx` 495 | 関数全体 | skip | factory判定、RFGS007、注釈の警告など、条件付き | 3 |
| `parameterMayReadTrackedValue` → `bodyReadsTrackedValue` 5576、`computeTrackedReadInExpression` 3839 | paramのpattern | skip | 識別子でないparamごとに**3回**（6664、3664、6695） | 5、4 |
| `collectTrackedReadAliases` 5372 | 関数全体 | skip | dry runと実際で**2回**（展開したらさらに1回） | 6 |
| 同 5304、5315 | 宣言の初期化式ごと | skip | 宣言・代入ごと | 2〜4 |
| `captureTrackedReadExpressions` 6533、6555 | 本体 | skip | dry runと実際で**2回** | 21 |
| 同 5830、5865 | captureする式ごと | — | `referencesReadingAlias`、`handsOverReadingValue` | 1 |
| 同 6070 | Hook呼び出しの引数 | — | Hookを分けたときだけ | 21 |
| `expressionCallsHook` 5498 | 式ごと | skip | captureの候補ごと、`functionCallsHook`経由でhelperごと。**cacheなし** | 3 |
| `hasTrackedReadInExpression` 3839 | 式ごと | skip | 別名の集合とnodeでcache | 4 |
| `targetAliasGraphMayRead` 5071 | helperの本体 | skip | 別名の集合とnodeでcache | 2 |
| `hasDynamicCallTarget` 5194 | helper全体 | skip | `targetFunctionMayReadTrackedValue`から | 3 |
| `expandTrackedObjectDestructuring` 6573 | 本体 | skip | 変換する関数ごとに1回 | 2 |
| `hasRelocationConflict` 3571、3596 | 移動するparam | — | paramを移動するときだけ | — |
| `Scope#crawl` 6705、6721、3753 | 関数全体 | すべて | 変換する関数ごとに1回（展開したらさらに1回） | Babel内部 |
| `invalidateThisReferences` 1240 | 関数全体 | すべて | 変換する関数ごとに1回 | 2 |
| `getObjectThisReferences` 1268 | object literalのmember | 非arrowはskip | object literalごとにcache | 3 |

bench120では、変換する関数1つあたり約13.5回のtraverseと1回のcrawlになる（1620÷120）。

### 1つのvisitorにまとめられるか

| 組み合わせ | まとめられるか | 妨げるもの |
|---|---|---|
| `scanFunction`（全体）＋`inspectKnownRenderPropReads` | 条件付きで可 | `scanFunction`は境界とrender propを`path.skip()`するが、もう一方は全部歩く。1つのtraversalでは`skip`が両方に効くので、skipの代わりに「skipした深さ」をstateで持つ必要がある。下の「推奨4」で`inspectKnownRenderPropReads`を入れ子に入らないようにすれば、両者の範囲が近くなる |
| `collectTrackedReadAliases`＋`expandTrackedObjectDestructuring`の候補集め | 可 | どちらも入れ子をskipし、relocation後・capture前に走る。aliasの走査で`VariableDeclarator`を集めて返せば1回減る（変換する関数ごとに1回、効果は小さい） |
| dry runの別名収集＋実際の別名収集 | 条件付きで可 | (4)のC。parameterの移動と展開がなければ共有できる |
| dry runのcapture＋実際のcapture | 不可（Bが必要） | dry runは作者のASTを、実際は移動・展開後のASTを見る |
| `scanFunction`＋`collectTrackedReadAliases` | 不可に近い | 前者は全関数で即時、後者は`readsValue()`が必要なときだけ遅延で走る。まとめると、読み取りのない関数でも別名を集めることになる。入れ子の扱いも違う |
| 最後の`crawl`＋`invalidateThisReferences` | traversal自体は不可 | crawlはBabel内部のvisitorで、外からhandlerを足せない。代わりに`invalidateThisReferences`のtraverseをなくす（推奨5） |
| `Function` visitorの外側の走査＋`scanFunction` | 不可 | 外側の走査は変換で本体が置き換わりrequeueされる。関数ごとの判定は入れ子の関数の内容を先に知る必要がある |

まとめられるのは2〜3回分（約13.5回→約10回）にとどまる。**回数を減らすより、1回あたりの固定費（visitorの`explode`とNodePathの生成）を減らす方が効果が大きい**。

### Babelレベルのそのほかのコスト

| コスト | 避けられるか | 内容 |
|---|---|---|
| visitorの`explode`（約20%、約14%） | **避けられる** | visitorをmodule定数にし、閉じ込めている変数は`path.traverse(visitor, state)`のstateで渡す。一度`explode`すれば`_exploded`で以後は再利用される。`captureTrackedReadExpressions`のように多くのlocal変数を閉じ込めるものは、1回の呼び出し分のstate object（`CaptureSession`）を作り、module定数のvisitorはそのmethodを呼ぶだけにする。dry runの`guarded`（6539）も、stateの`dryRun.found`を見るmodule定数のvisitorにする |
| NodePathを作らなくてよい述語 | **避けられる** | `expressionCallsHook`（5489）、`rendersJsx`（493）、`hasDynamicCallTarget`（5192）、`invalidateThisReferences`の中の判定はnodeだけで答えが出る。`t.traverseFast`（`@babel/types` 8は`traverseFast.skip`/`traverseFast.stop`の戻り値に対応）に替えれば、NodePathとcontextを作らない。違いは「`traverseFast`は根も訪れる」こと。`rendersJsx`は根の関数自身をskipしないよう、根との比較が要る |
| `expressionCallsHook`の繰り返し | 一部避けられる | captureの候補ごとに部分木を歩く。純粋に構文的なのでnodeでcacheできる。ただし`splitHookBase`（6080）はHook呼び出しを識別子に置き換えて**同じnodeの中身を変える**ので、置き換えた祖先のcacheを消す必要がある。効果は約3%で、優先度は低い |
| `applyManaged`/`applyInject`の最後の`path.scope.crawl()` | 今は避けない | 変換で生成した宣言（`_signals`、`_param`、`_trackedSource`）を登録し、cloneした読み取りの参照を数え直す。後で訪れる入れ子の関数の判定（`getOwnBindingReferences`、`isPlainCalledComponent`、ownership）は、関数のlocalな名前の`referencePaths`と`constantViolations`を読む。個別に`registerDeclaration`するだけでは参照が古いままになる。約5% |
| 展開後の`crawl`（6705） | 今のままでよい | 展開があったときだけ。すでに1関数1回にまとめてある |
| `invalidateThisReferences`（約4〜8%） | **避けられる** | 下の推奨5 |
| captureのwrapでの`t.cloneNode(path.node, true)`（5892ほか） | 避けられるが利益が小さい | 計測では`replaceWith`を含めて1〜2%以下。`replaceWith`で外したnodeは再利用できる（`path.replaceWith(t.callExpression(..., [path.node]))`はBabelのよくある書き方）が、移動したnodeの子のNodePathの`parentPath`が、外側のtraversalで訪れ直すまで古い位置を指す。cloneをやめると、入れ子の関数のnodeをkeyにしたcache（`synchronousScans`、`readsReachable`）が変換後も当たるようになるという利点もあるが、位置に依存する述語（`isDeferredFunction`）のcacheが正しいかを個別に確かめる必要がある。後回しにする |
| cloneで作った関数のscope | 問題なし | 生成した関数のscopeは`applyManaged`のcrawlの中で作られ、`crawling`中の早期returnで済む。realisticで540回あるが、合計約1 ms |
| Babel自身のprogramのcrawl、parser、generator | 避けられない | `transformSync`の中。`mightTransform`による事前の除外は別作業 |

## 判定のコストを減らす2つの変更（traverse以外）

### 推奨1: `decideTransform`の`inspectFunction`を遅延にする

`decideTransform`は、訪れたすべての関数で最初に`inspectFunction`（関数全体の`scanFunction`。入れ子の関数の中も歩き、helperのfoldで解決もする）を呼ぶ（3385）。しかし`inspection`を読むのは次の場合だけである。

- `readsValue()`の中（遅延）。
- `shouldAutomaticallyTransform`（3258）。ただし、identityがcomponentでもHookでもなければ`inspection`を読む前に`false`を返す。
- skipの判定の後の`inspection.hasSignalTrackingCall`/`hasUseManagedSignalsCall`（3478）。ここに届くのは、明示・注釈・自動のどれかで変換が決まった関数だけである。

callback、event handler、`useEffect`のcallbackなど、identityを持たない関数（realisticでは480個中450個）では、`inspection`は一度も読まれない。`inspectFunction`を`inspected ??= ...`の遅延にすれば、それらの`scanFunction`が丸ごと消える。

- 意味の変化: なし。`inspectFunction`は純粋で、副作用はmemo（`readsReachable`、`synchronousScans`）への書き込みだけである。memoの内容は問い合わせ方によらない事実なので、問い合わせを減らしても答えは変わらない。
- 交互計測（HEADと、`inspection`をgetterで遅延にしたcopyを同じプロセスで12回ずつ交互に実行）: 出力は4通り（bench120/realistic × managed/inject）とも完全に一致した。realisticはmanagedで494.6 ms→451.8 ms（約9%）、injectで315.6 ms→281.7 ms（約11%）。bench120は全関数がcomponentかHookなので変わらない（差は測定のぶれの範囲）。
- 工数: 小（数行）。getterではなく、`inspect()`関数を`shouldAutomaticallyTransform`に渡す形に書き直すのがよい。

### 推奨4: `inspectKnownRenderPropReads`を入れ子の関数に入らないようにする（manual以外）

`inspectKnownRenderPropReads`（3119）は関数全体を入れ子も含めて歩き、`decideTransform`は（manual以外の）すべての関数でこれを呼ぶ。入れ子のcallbackの中のJSXは、自分の関数と祖先のすべての関数から何度も歩かれる（深さに比例）。警告は`reportedWarnings`で重複を除いているので、出力は1回だが、走査は重複している。

manual以外では、どの関数も`Function` visitorで自分自身として訪れられるので、`Function(nested) { nested.skip(); }`を足せば、各JSXはそれを直接含む関数から1回だけ調べられる。

- manualでは注釈のある関数でしか呼ばれないので、入れ子へ入る今の動作を残す必要がある。
- 注意: 外側の関数が変換された後に訪れる入れ子の関数は、captureのcloneの中のcopyである（`items.value.map((t) => <li render={() => ...}/>)`はmap全体がcaptureに入る）。cloneでも位置関係（`isOwnedBySignalControlFlow`、`getJsxCallbackTarget`）は同じだが、`readsSignal`の`excluded`は「外側の関数」から「その入れ子の関数」に変わる。警告の有無が変わらないことを`tests/diagnostics.test.ts`のRFGS005/RFGS006/RFGS010で確かめる必要がある。
- 効果: realisticで`inspectKnownRenderPropReads`は約9%（ラップ込み）。入れ子に入らなければその大半が消える。bench120では効果なし。

## 推奨する順序

| 順 | 変更 | 工数 | 期待効果 | リスク | 守るテスト |
|---|---|---|---|---|---|
| 1 | `decideTransform`の`inspectFunction`を遅延にする（推奨1） | 小 | realistic −9〜11%、bench120 ±0 | ほぼなし（出力一致を確認済み） | 全suite。特に`tests/diagnostics.test.ts`（RFGS007・RFGS008）、`tests/transform.test.ts`の「anonymous default exports」「component-named functions called as plain functions」「PascalCase higher-order component factories」、`tests/selection-capture-consistency.test.ts` |
| 2 | visitorをmodule定数にして`explode`を1回にする。nodeだけで答えが出る述語は`t.traverseFast`にする（(5)の表） | 中（traverseの約25か所。まず`scanFunction`、`inspectKnownRenderPropReads`、`captureTrackedReadExpressions`、`collectTrackedReadAliases`、`expressionCallsHook`、`bodyReadsTrackedValue`、`computeTrackedReadInExpression`） | bench120 −15〜20%、realistic −10〜14%（`explode`の実測時間がそのまま上限） | 低い。機械的な書き換え。`skip`/`stop`の意味と、`traverseFast`が根を訪れる違いに注意 | 全suite。`tests/runtime-differential.test.ts`（`tests/read-shapes.ts`）と`tests/selection-capture-consistency.test.ts`が選択とcaptureの両方を広く押さえる |
| 3 | dry runと実際のpassで別名の集合を共有し、`parameterMayReadTrackedValue`の3回を1回にする（(4)のC） | 小〜中 | bench120 −5〜8%（別名収集1回分＋paramの判定2回分＋`trackedReadCache`のhit） | 低い（「Cの条件」を守れば） | `tests/selection-capture-consistency.test.ts`、`tests/runtime-differential.test.ts`、`tests/transform.test.ts`の「signal reads in parameter defaults」「parameter optionality after a relocated default」「managed coercion, for-in, Hook arguments and loop-head scope output」 |
| 4 | `inspectKnownRenderPropReads`を入れ子に入らないようにする（推奨4） | 小 | realistic −5〜9%、bench120 ±0 | 中（cloneの中での警告） | `tests/diagnostics.test.ts`（RFGS003、RFGS005、RFGS006、RFGS010）、`tests/transform.test.ts`の「render callbacks reached through Array.from or a destructured keyed slot」 |
| 5 | `invalidateThisReferences`のtraverseをなくす | 小 | −3〜5%（変換した関数ごとに全体を1回歩く分） | 低〜中 | `tests/transform.test.ts`の「keyed slots reached through a sibling's this or an optional static path」「object-method shorthand components」「components held in keyed slots」 |
| — | B（実際のpassを記録モードで走らせて巻き戻す） | 大 | 1〜3の後で残り数% | 中〜高 | — |
| — | A（記録して再生）、crawlの削除、cloneの削除 | 大 | 小 | 高 | — |

1〜5を合わせた見込みは、bench120で約25〜35%、realisticで約30〜40%（効果は一部重なるので単純な和より小さい）。1と2は独立で、どちらを先にしてもよい。3は2の後の方が、残ったdry runの固定費が測りやすい。各段の後に、`--maxWorkers=2`で全suiteを走らせ、benchmarkは同じプロセスで交互に実行して比べる（process単位のA/Aは±30%ぶれる）。

### 推奨5の内容

`thisReferenceCache`（1236）は、object literalの`this`参照を変換のたびに捨てるために、変換した関数全体を歩いている（1240）。cacheに入るのは`getThisSlotUses`（1202）がkeyed slotの安全性を調べたobjectだけで、普通のファイルでは0個である。

- 変更: cacheに入れたobject literalのNodePathを1ファイル分の`Set`で持つ。`applyManaged`/`applyInject`の**変更前**に、そのSetの各objectについて「変換する関数の中にある」か「cacheした`this`参照のどれかが変換する関数の中にある」かを祖先をたどって調べ、該当するものを変更の後に捨てる。cacheが空なら何もしない。
- 今の規則（関数が`this`を1つでも含めば、周りのobjectをすべて捨てる）より正確で、捨てるべきものは必ず捨てる。全部捨てる（世代番号）方式は採らない。コメント（1223〜1235）が書くとおり、objectのmemberを次々に変換するmoduleで、member数の2乗の再計算になるからである。
- 祖先の判定は変更前に行う。変更後は、移動したnodeのNodePathの`parentPath`が古い位置を指していることがある。

## 今回やらないこと

- `mightTransform`とBabelの呼び出し方（別作業で進行中）。
- 選択の規則そのものの変更。どの変更も「同じ入力に同じ出力」を条件にする。選択を速くするために、dry runを通さない近道（「本体に直接の`.value`があれば選択」など）を足すと、選択とcaptureの規則が再び2か所になるので行わない。
