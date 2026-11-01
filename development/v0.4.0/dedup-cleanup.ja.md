# v0.4.0 重複ロジックの共通化（runtime・core）

v0.4.0の公開前に、同じ処理が複数の場所に書かれ、写しごとに仕様がずれていた箇所をまとめた記録。pluginの分は[plugin-dedup.ja.md](./plugin-dedup.ja.md)。

- 基準: `cb94d38`
- 監査: `src/core`、`src/runtime`・`src/jsx`・`src/react`・`src/utils.tsx`、pluginの3領域を読み取りだけで調べ、見つかった項目を順に直した。高速化のために意図して同じ処理を2つ書いている箇所（`HelperBrandSignal`と`HelperBrandComputed`のgetter）と、見た目は似ていても意味が違うもの（`For`/`Index`と`captureIteration`）は対象外とした。

## Full版とLite版のSignal prop判定の共有（実行時のbreaking change）

### 変更前

Full版（`src/runtime/jsx.ts`）とLite版（`src/runtime/lite-jsx.ts`）が、Signal値のhost propを別々に検査していた。

| 入力 | Full | Lite |
| --- | --- | --- |
| カスタム要素の、bindingしないprop（`<x-el config={sig}>`） | Signalをそのまま渡す | throw |
| カスタム要素の`value={sig}`/`checked={sig}` | throw（「`bindValue`を使う」） | throw |
| `bindValue={undefined}` | なしと同じ。DOMへは渡さない | throw |
| Fragmentとcomponentのprops | 検査しない | Fragmentは検査する |
| エラー文のtag名 | あり | なし |

`development/v0.3.0/m19-opus-review-resolution.ja.md`では、Full版は「Liteと同種の明確な診断」を出す意図だった。

`REACTIVE_PROP_NAMES`には`value`と`checked`が残っていたが、その前の検査がSignalの`value`/`checked`を必ずthrowしていたため、使われていなかった。

### 変更後

`src/runtime/jsx-shared.ts`に、両runtimeの共通部分をまとめた。

- `isDirectSignalPropName`: Full版がSignalを直接bindingするprop名（`title`、`id`、`className`、`hidden`、`disabled`、`style`、`data-*`、`aria-*`）。
- `passesSignalThrough(name, tag)`: bindingしないSignalを、そのままReactへ渡すかどうか。`children`と、カスタム要素の上記以外のprop。
- `hasDefinedProp`、`hasBindingPropKey`、`isStyleObject`、`findSignalStyleEntry`、`needsChildNormalization`、`normalizeChildrenProp`。
- `createJsxPropsTransform`（host・Fragment・その他の振り分け）、`createJsxFactory`、`createClassicElement`（classicの`createElement`）。`createJsxDEV`は`react/jsx-dev-runtime`を本番entryへ持ち込まないよう、`src/runtime/jsx-dev.ts`に分けた。

規則は「Full版がbindingするSignalはLite版ではthrowし、Full版がそのまま渡すSignalはLite版もそのまま渡す」。

- カスタム要素では、`value`/`checked`も含め、bindingしないpropのSignalをそのまま渡す（Full版は制限が緩くなる。Lite版はFull版に合わせて緩くなる）。
- Lite版は`bindValue={undefined}`を「なし」として扱い、DOMへ渡さない。
- Lite版はFragmentとcomponentのpropsを検査しない。
- Lite版のエラー文に`on <tag>`を足した。

各entry（`jsx/jsx-runtime`、`jsx/jsx-dev-runtime`、Lite版の2つ、classicの`createElement`）は、共有のfactoryに自分のhost prop変換を渡すだけになった。`jsxDEV`は呼び出しごとにwrapperを作っていたが、作らなくなった。

### テスト

- `tests/lite-jsx-runtime.test.tsx`: カスタム要素のpass-throughとbinding対象propの拒否、`bindValue={undefined}`の除去、Fragmentとcomponentを検査しないこと。
- `tests/react-review-regressions.test.tsx`: カスタム要素の`value`/`checked`をそのまま渡し、`<input value={sig}>`は従来どおりthrowすること。

### その他

- `scripts/check-size.mjs`: Full版のbindingが入っていないことの目印から`className`を外し、`until-found`（`setDomProp`だけにある文字列）に替えた。prop名の一覧は両runtimeが共有するため。
- `docs/guides/jsx-bindings.md`（英日）: カスタム要素の規則、Lite版がFull版と同じ規則に従うこと、`jsxImportSource`の名前（`react-fine-grained-signals/jsx`）を書いた。日本語版に残っていた「`value`/`checked`をsignalと素の値で切り替えられる」という記述（migration errorになると書いた直前の段落と矛盾していた）を、英語版と同じ内容に直した。

### サイズ（gzip）

| entry | 変更前 | 変更後 |
| --- | --- | --- |
| jsx-runtime | 11.27 kB | 11.27 kB |
| full-jsx-child | 11.18 kB | 11.15 kB |
| lite-jsx-child | 5.21 kB | 5.37 kB |

Lite版は、Full版と同じprop名の一覧と判定を持つようになった分だけ増えた。

## form bindingの検証とクリック処理の共有（挙動は変わらない）

### 変更前

- `bindChecked`（`subscribeBinding`の中にinlineで約70行）が、radio/checkbox groupの`bindInputValueGroup`のクリック後の処理（次のtaskでの取り消しと再描画、`flushCorrection`/`scheduleCorrection`）を写していた。写しは`applyBoundSignal`を使わず、読み取りと適用を手で書いていた。クリック中の書き込みを止めるguardもなかった（booleanは必ず反転するため、今は表に出ない）。
- `case "checked"`には、`bindChecked`以外の名前のための分岐があったが、`"checked"`のkindは`bindChecked`にしか付かないため使われていなかった。
- input typeの正規化`String(props.type ?? "text").toLowerCase()`が4箇所にあった。`resolveBindingKind`は同じpropに2回呼ばれていた。
- textとして扱うinput typeの一覧が3つあった（render時の検査で毎回作る`Set`、`BoundInputProps`の型のunion、`resolveBindingKind`の暗黙の分岐）。
- 値の形のエラー（`Invalid select bindValue.`、`Radio bindValue requires a string.`、`Checkbox group bindValue requires an array of strings.`）が、render時の検査とその後の読み取りに別々に書かれていた。selectの`multiple`は、render時は`props.multiple === true`、DOMでは`select.multiple`で判定していた。

### 変更後

- `createClickSettler()`（取り消しと再描画の予約・実行、クリック開始時の処理）と`syncClickedDefault()`を、`bindCheckedValue`と`bindInputValueGroup`が共有する。`bindCheckedValue`はクリック中の書き込みを止め、group bindingと同じく`defaultChecked`だけを更新する。
- `getInputType()`を1回だけ呼ぶ。textとして扱うinput typeは`TEXT_BINDABLE_INPUT_TYPES`の1つにまとめ、型のunionもそこから作る。
- 値の形の検査は`assertSelectValue`、`assertCheckboxGroupValue`、`assertInputValueGroupValue`にまとめ、render時の検査とその後の読み取りが同じ関数を呼ぶ。render時の`multiple`は`Boolean(props.multiple)`にした（ReactがDOMへ書くときと同じ変換）。
- 小さな共通化: 配列の浅い比較（`areArraysShallowEqual`）、文字列の配列の判定（`isStringArray`）、style objectの判定（`isStyleObject`、5箇所）、`bindTextValue`でIME変換中の補正を保留する処理（2箇所）。

## `useDeepSignalValue`の引数の検査と読み取りを`useSignalValue`にそろえた（実行時のbreaking change、不具合の修正）

### 変更前

- `useSignalValue`はsignalでない値をrender中に`TypeError`にしていた。`useDeepSignalValue`は検査せず、素のobjectを渡すと1回だけ描画して、その後は更新されなかった。
- `useSignalValue`の`getSnapshot`は、RFSGのeffectやcomputedの実行中に読まれても依存が付かないよう`untracked()`で包んでいた。`useDeepSignalValue`は、storeを作るときと、購読前の`getSnapshot`での再評価を`untrackedRender()`だけで包んでいた。そのため、`useSignalEffect`などの中から`flushSync`で描画すると、selectorの読み取りが実行中のeffectに付き、deep stateへの書き込みでそのeffectが再実行されていた。

### 変更後

- `assertHookSource(hook, expected, source)`を両方のhookが使う。`useDeepSignalValue`は`"useDeepSignalValue expects a deep signal created by react-fine-grained-signals"`をrender中にthrowし、selectorは実行しない。
- `useDeepSignalValue`のeffect外での評価（storeの作成時と購読前の`getSnapshot`）は`untracked()`で包む。effectの中での評価は、これまでどおり依存を追う。

### テスト

`tests/react-deep-signal-value-source.test.tsx`: 素のobjectと`null`がrender中に`TypeError`になり、selectorが呼ばれないこと。effectの中から`flushSync`で描画しても、deep stateへの書き込みでそのeffectが再実行されないこと。3件とも変更前のhooksでは失敗することを確認した。

docs: `docs/guides/hooks.md`（英日）の`useDeepSignalValue`に、引数の条件を書いた。

## deep signalのエラー文のAPI名（メッセージ文のみのbreaking change）

### 変更前

`deepCollectionSignal`のstateで起きたエラーも、`assertRootValue`の1つを除いて、すべて`deepSignal() ...`と書いていた。collection module（`deep-collections.ts`）のエラーも同じだった。同じ文面（accessor property、prototype mutation、own properties）が、engineとcollection moduleに別々に書かれていた。

`deepSignal()`のrootの検査は`instanceof Map`などで行っていたため、別realmのMapには「`deepCollectionSignal()`を使う」という案内が出ず、汎用の「plain objectとarrayだけ」のエラーになっていた。

### 変更後

- `deepError(support, text)`（`deep-signal-engine.ts`）が、modeに応じて`deepSignal()`か`deepCollectionSignal()`を付ける。collection-modeのstateの中にあるplain objectも`deepCollectionSignal()`になる。collection moduleは`deepError("collection", text)`を使う。
- 繰り返していた文面は定数にした（`PROTOTYPE_MUTATION`、`ACCESSOR_PROPERTIES`、`OWN_PROPERTIES`）。
- 「`deepSignal()`と`deepCollectionSignal()`は同じobjectを共有できない」と、plain mode専用のrootのエラーは変えていない。
- plain modeのrootの検査は`Object.prototype.toString`のtagで行う。collection moduleはplain modeでは読み込まれないため、brandの確認は使えない。別realmのMapにも同じ案内が出る。

### テスト

`tests/deep-signal-messages.test.ts`: plain modeとcollection mode（plain objectとMap）でAPI名が正しいこと、別realmのMapにも案内が出ること。

`scripts/check-size.mjs`: collection moduleの目印を、prefixを除いた`reactive collections do not support own properties`にした。文面を組み立てるようになり、prefix付きの文字列はbundleに残らないため。

### サイズ（gzip）

| entry | 変更前 | 変更後 |
| --- | --- | --- |
| deep | 9.83 kB | 9.98 kB |
| deep-collections | 13.15 kB | 13.33 kB |
| index-full | 15.76 kB | 15.92 kB |

rawは変わらないか減った。同じprefixが続く文字列はgzipでよく縮むが、組み立てた文字列は縮みにくいため、gzipでは増えた。

## 配列の検索とcollectionの検索で同一性の規則をそろえた（不具合の修正）

### 変更前

deep proxyを含むplain object（carrier、例: `{ inner: state.value.inner }`）は、保存するときに正規化した複製になる。同じcarrierをもう一度渡すと同じ複製を使う（`normalizedProxyCarriers`）。

- collectionの`has`/`get`/`delete`は、carrierを複製に読み替えていた。`set.add(c); set.has(c)`は`true`。
- 配列の`includes`/`indexOf`/`lastIndexOf`は、proxyをrawに戻すだけで、carrierを読み替えなかった。`list.push(c); list.indexOf(c)`は`-1`。
- collection側は、複製がどのmodeで作られたかを確認していなかった（書き込み側の`prepareDeepValue`は確認する）。

### 変更後

engineの`lookupIdentity(value, support)`（proxyならraw、このmodeで保存したcarrierならその複製、それ以外はそのまま）を、配列の検索とcollectionの検索の両方が使う。collectionは、そのcollectionに保存したentry（`storedCarrierKey`）を先に確認する。書き込みと違い、carrierのgraphは検査し直さない（検索がgraphの大きさに比例し、存在しないだけの値でthrowするのを避けるため。これまでのcollection側と同じ）。`CollectionContext`は`normalizedProxyCarriers`の代わりに`lookupIdentity`を渡す。

### テスト

`tests/deep-signal-consistency.test.ts`（前節の`deep-signal-messages.test.ts`を改名した）: collection modeとplain modeで、配列に保存したcarrierを`includes`/`indexOf`/`lastIndexOf`で見つけられること。変更前のengineでは失敗することを確認した。

## metadataの掃除（sweep）を1つにまとめた（不具合の修正）

### 変更前

読まれたが存在しないkeyのversion signalを捨てる処理が、engine（`sweepPrunedKeys`/`schedulePropertySweep`）とcollection module（`sweepCollectionKeys`/`scheduleCollectionSweep`）に1つずつあった。128件ずつ処理する仕組み、状態のfield、`hasLinkedSubscribers`と`retire...Version`は同じだったが、次の点がずれていた。

- batchの中で呼ばれたとき、engineは何もせずに戻り、collectionはmicrotaskで予約し直していた。
- 途中で次のtaskへ持ち越すとき、engineは`prunableSweepSettled`を`true`に書き換えていた。そのため、最初の同期のchunk（書き込みの直後、settledでない）で保留した候補（読まれたがcommitされていないrenderのkeyなど）は、最後に見直されなかった。候補が128件を超えると、次にそのobjectへ書き込むまで残った。collectionはこの見直しを意図して行っていた（コメントあり）。
- `prunableRevision`の初期値の扱い（`?? 0`の有無）。

### 変更後

engineの`runSweep(metadata, plan, settled)`と`scheduleSweep(metadata, plan, yieldToTask)`が1つの実装を持ち、`CollectionContext`でcollection moduleへ渡す。種類ごとの違いは`SweepPlan`（候補の数、iterator、1件の処理、空になったときの後始末）だけにした。状態のfieldは`SweepState`にまとめた。

- batchの中ではmicrotaskで予約し直す（collectionの挙動）。
- settledでないchunkで保留した候補は、最後に新しいsettled passで見直す（collectionの挙動）。
- engineのplanは、keyのtargetを`proxyToRaw.get(metadata.proxy)`で引く。呼び出し側からtargetを渡さなくなった。

### テスト

`tests/deep-signal-property-sweep.test.ts`: 300件の存在しないkeyを、commitされたreaderが外れたあと、commitされないrenderがもう一度読んだ状態で書き込むと、最初のchunkの候補も最終的に捨てられること。変更前のengineでは失敗することを確認した。既存の`tests/deep-signal-collection-sweep.test.ts`はそのまま通る。

### サイズ（gzip）

| entry | 変更前 | 変更後 |
| --- | --- | --- |
| deep | 9.98 kB | 10.13 kB |
| deep-collections | 13.33 kB | 13.26 kB |
| index-full | 15.92 kB | 15.83 kB |

plain modeだけのbundle（deep）は、collectionと共有する汎用の実装（microtaskでの予約など）を持つようになった分だけ増えた。

## collectionの種類の判定を1つにした（不具合の修正、実行時のbreaking change）

### 変更前

collectionかどうかの判定が4通りあった。engineの`instanceof`の連鎖（保存時の検査、複製、比較など）、collection moduleの`proxyFor`の`instanceof`、collection moduleの`getNativeCollectionKind`（prototypeをたどり、最後にbrandを確かめる）、`isStandardCollectionPrototype`。

- `getNativeCollectionKind`は、plain objectなら最初に`undefined`を返していた。prototypeが`null`のobjectもplain objectとみなすため、`Object.setPrototypeOf(new Map(), null)`はplain objectと判定され、両modeでplain objectとしてproxyされていた（中身のentryは見えない）。`CollectionSupport.kindOf`のdocには「prototypeを置き換えたcollectionも含む」とあった。
- plain modeの保存時の検査は`instanceof`だけを見ていたため、別realmのMapの中にあるdeep proxyを見つけられなかった（「opaqueな値の中にproxyは保存できない」の検査を通り抜けた）。

### 変更後

- 判定を`collectionKindOf`としてengineへ移した。collection moduleは`CollectionContext`経由でこれを`kindOf`に使う。空のnull-prototype objectだけはbrandを確かめる（ほかのplain objectとarrayは、これまでどおりすぐ`undefined`）。
- 保存時の検査は`collectionKindOf`で分岐し、entryは`Map.prototype.forEach.call`/`Set.prototype.forEach.call`で読む。別realmのcollectionも検査できる。
- prototypeが`null`のcollectionは、両modeで`cannot store a collection with a null prototype`をthrowする。読み取り側はこれをplain objectとみなすため、保存させない。
- engineの残りの`instanceof`（複製、比較、`isWrappedByValue`）と`proxyFor`は変えていない。collection modeでは、保存時に同じrealmの標準のcollection以外を拒否しているため、`instanceof`と結果が変わらない。

### テスト

`tests/deep-signal-consistency.test.ts`: null-prototypeのMapを両modeで拒否すること（root、property、書き込み）、空のnull-prototype dictionaryは使えること、plain modeで別realmのMapの中のdeep proxyを拒否すること。変更前は2件が失敗することを確認した。

### サイズ（gzip）

| entry | 変更前 | 変更後 |
| --- | --- | --- |
| deep | 10.13 kB | 10.30 kB |
| deep-collections | 13.26 kB | 13.33 kB |

plain modeのbundleが種類の判定（brandの確認）を持つようになった分だけ増えた。予算は10.50 kB。

## 購読effectの共有と、coreの小さな重複（ほぼ挙動は変わらない）

### 購読effect

render依存でない購読（signalを読み、最初の実行のあとの変化ごとにlistenerを呼ぶdetached effect）が3箇所にあった。listenerがthrowしたときの扱いが違っていた。

- `subscribeLocalReadable`（hookとJSX binding）: `notifyListener`で包み、「render-subscription listener threw」として報告し、ほかのlistenerへの通知を続ける。
- `subscribeReadables`（`useSignalTracking`のrender store）とgraph nodeの`subscribeRender`: listenerを直接呼んでいた。throwはeffectの失敗として「an effect() callback threw」と報告されていた。render storeの`#notify`も、listenerごとに包んでいなかった。

`subscribeToReads(detachedEffect, read, onChange)`（`render-tracking.ts`）を3箇所が使い、`onChange`は`notifyListener`で包む。render storeの`#notify`もlistenerごとに`notifyListener`で包む。`subscribeRender`のrevisionの確認は`read`の中に移した。

テスト: `tests/core.test.ts`に、graph nodeのrender listenerがthrowしても「render-subscription listener」として報告し、次のlistenerへ通知することを追加した。変更前のcoreでは失敗することを確認した。

### 小さな重複

- `deepCollectionSignal`の、size・keyの順序・entryの順序のversionを上げる処理（5箇所）を`notifyStructure`にした。Map/Setのobject keyのversionの置き場所の選択（2箇所）を`objectKeyedVersions`にした。
- `trackWeakCollectionKey`/`notifyWeakCollectionKey`の、weak keyでない場合の分岐は届かなかった（WeakMap/WeakSetの呼び出し側は、その前にほかのkeyを除いている）。分岐を消し、`weakCollectionVersion`を直接呼ぶ。
- ownerの種類の確認（`deep-signal.ts`と`render-tracking.ts`のinline）を、`isGraphExecutionOwner`/`isRenderExecutionOwner`にした。
- brandの付与（`base.ts`の`registerSignal`と、coreのhelper signal）を`stampSignalBrand`（`signal-brand.ts`）にまとめ、descriptorの理由のコメントもそこへ移した。

## signalとcomputedの`.value` getterの振り分けを共有した（速度は同等、computedの読み取りは速くなった）

### 変更前

`HelperBrandSignal`と`HelperBrandComputed`の`get value()`は、読んでいるのが誰か（ownerなし、このcopyのeffect/computed、Reactのrender attempt、`untracked()`、別copy）で振り分ける処理を、それぞれ持っていた。読み取り関数（`readSource`/`readComputed`）と、computedがthrowしてもrender依存を登録する点（`finally`）のほかは同じだが、確認の順序と別copyの確認位置が違っていた（結果は同じ）。最初の監査では「速度のために意図して2つ書いている」と判断して対象外にしたが、根拠になる計測はなかった（`development/phases/phase9/source-hot-path-recovery.md`の実験は、helperへ切り出しても速さが変わらなかったという記録で、共通化すると遅くなるという記録ではない）。

### 計測した案

同じプロセスにbase（変更前の`dist/`）と候補を別moduleとして読み込み、ABBAの順で交互に測った。ケースの関数もbuildごとに別moduleにした（同じ関数から両方を読むと、V8のinline cacheが混ざり、A/Aで最大45%の偏りが出たため）。読み込み順をprocessごとに入れ替え、両順のmedianの比の幾何平均をとった。1回の計測は100万回の読み取り。A/A（同じbuildどうし）の差は±2.5%以内。

| ケース（候補/base） | 案1: getterの本体を1つの関数に | 案2: 案1でsignalだけ`try`の外 | 案3: 案2で自copyの確認を先頭に | 案4: 頻繁な2分岐はgetter、残りを共有（採用、12 process） |
| --- | --- | --- | --- | --- |
| signal、ownerなし | 1.13 | 1.00 | 1.04 | 0.99 |
| signal、effectの中 | 0.96 | 0.92 | 1.17 | 0.96 |
| signal、`untracked` | 0.90 | 0.93 | 0.94 | 0.95 |
| computed、ownerなし | 0.73 | 0.71 | 0.68 | 0.66 |
| computed、effectの中 | 1.18 | 1.22 | 1.20 | 0.93 |
| 書き込みと読み取り | 0.93 | 0.94 | 0.90 | 0.99 |

案1〜3は、getterの本体が大きくなってinline化されにくくなり、どこかの頻繁なケースが15〜20%遅くなった。

### 変更後（案4）

- 各getterは、頻繁な2つの分岐（ownerなし、このcopyのeffect/computed）だけを持つ。computedは、ownerなしの確認を先頭に移した（これまでは最後で、`try/finally`を常に通っていた）。computedのownerなしの読み取りが約34%速くなったのはこのため。
- 残りの分岐（render attempt、`untracked()`、別copy、その他）は`readOwned(readable, node, owner, computed)`が持ち、両方のgetterが使う。render依存の登録は`collectRenderRead`にした。
- 挙動は変わらない。

計測に使ったscriptは一時的なもので、repoには入れていない。上の手順（buildごとに別moduleで読み込む、ケースの関数もbuildごとに分ける、ABBA、processごとに読み込み順を入れ替える）で再現できる。
