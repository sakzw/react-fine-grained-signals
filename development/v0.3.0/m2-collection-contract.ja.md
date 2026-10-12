# M2 — Collection reactivity contract (design gate)

## 方針

M2は、`deepSignal`に明示opt-inを加えてMap/Set/WeakMap/WeakSetをreactiveにする。既定の `deepSignal(value)` はv0.2.1互換を維持し、nested Map/Set read-only viewとthrowするmutatorを残す。

```ts
const state = deepSignal(initialValue, { collections: "reactive" });
```

このoptionではcollection rootも受け入れ、plain object/arrayにnestedされたcollectionもreactiveにする。API名と型は実装前の公開レビュー対象とするが、M2実装はこの契約に従う。

### A/B判断記録

- 既定のMap/Set throwを変更する案はより一様なAPIだが、既存の明示read-only/replacement契約を反転させる。
- opt-in案はmodeごとのproxy cacheを必要とし、同じraw graphをlegacy/reactive両modeから参照した時にproxy identityが異なる。modeをproxy identityの一部として明示すれば、legacy behaviorを維持しながらユーザー指定の機能を追加できる。
- ClefのA/B結果は問い合わせにより推奨が分かれ、どちらもconfidenceが低かった。独立コードレビューはopt-inを推奨した。最終判断では文書化済みruntime契約を尊重し、Aを採用する。後続prototypeでcache/alias設計が正しく維持できないと判明した場合だけ、既定変更を再検討する。

## 公開APIと互換動作

- 既存呼び出し `deepSignal(plainObjectOrArray)` は今のroot判定、nested opaque collection、readonly view、immutable replacementの動作を維持する。
- `deepSignal(value, { collections: "reactive" })` は、plain object/array/Map/Set/WeakMap/WeakSetのrootを受け入れる。
- collection対応は同一realmの標準Map/Set/WeakMap/WeakSetを対象とする。subclass・cross-realm collectionはM2では明示的に拒否する。
- reactive modeのMap/Set mutatorは `.value` 経由で成功し、通知を出す。WeakMap/WeakSetの対応methodも同様。mutation methodのnative-compatible return valueを保つ（Map/WeakMap.setとSet/WeakSet.addは同じreactive proxyを返す）。
- `state.peek()`と元のraw referenceはuntracked raw valueを返す。rawを直接変更してもdependency notificationは起きない。
- reactive mode内のMap/WeakMap `get` とMap/Setの全iterator・`forEach`は、plain object/arrayのkey/member/valueを同じmodeのdeep proxyとして返す。raw collectionにはraw key/member/valueを保存し、入力proxyは保存前にunproxyする。`get` / `has` / `delete` / `add` は引数proxyをraw identityへ正規化する。
- WeakMap/WeakSetの既存entriesはenumerateできない。initial traversalによる完全検査を約束せず、method経由のkey normalization、value unwrap、get時のlazy wrapを行う。native runtimeが許可するnon-registered symbol keyも追跡し、weak collectionを列挙するAPI、`size`、`clear`は提供しない。

## Proxy identityとalias

- legacy modeとreactive modeには別々のraw→proxy cacheを使う。legacy proxyのidentityとreadonly view cacheは維持する。
- 各mode内では同じraw nodeへのaliasとcycleに対してstable proxy identityを返す。Collection keyとしてproxyを返しても、同じraw keyを渡した`get` / `has` / `delete`が一致する。`toRaw`相当は両modeのproxy/viewから元のrawへ戻る。
- 同一raw objectを両modeで共有した場合、mode間のproxy identityが異なることを明記する。reactive proxy経由のmutationはraw collectionに反映されるが、legacy viewはcollection entry単位では追跡しない。
- reactive Map key / Set memberはraw identityで保存する。raw keyとこのruntimeが作ったproxy keyは同一memberとして扱い、読み・has・deleteの結果を一致させる。mutation時にraw collectionへproxyを残さない。
- 初期Mapにraw keyとこのruntimeが作ったproxy keyの両方が既にある場合など、正規化で同一keyが重複するgraphは暗黙にentryを捨てず、説明可能なTypeErrorで拒否する。別パッケージcopyが作ったproxyは現行のraw protocolで認識できないため、cross-copy proxy keyの正規化はM2では保証しない。既存cross-copy signal interopの契約とは別の未解決項目として記録する。

## Dependency matrix

値に実変更がないwrite、既存keyの同値 `Map.set`、重複 `Set.add`、未登録key/memberへのdelete、空のclearは通知しない。batch内の各mutatorは個別に通知せず、runtime batchでflushする。

| Collection | Read dependency | Trigger |
|---|---|---|
| Map | `get(k)`はkeyごとのvalue。`has(k)`はkeyごとのexistence。`size`はsize。`keys()`はkey iteration。`values()` / `entries()` / default iterator / `forEach()`はentry iteration | new key: value/existence/size/key iteration/entry iteration。existing keyの値変更: value/entry iterationのみ。existing keyの同値set:なし。delete:該当key/size/両iteration。非empty clear:消えたkeyごとのvalue/existenceとsize/両iteration |
| Set | `has(v)`はmemberごと。`size`はsize。全iterationはmember iteration | new add / existing delete:該当member/size/iteration。重複add、不在delete:なし。非empty clear:該当member/size/iteration |

Iteration dependencyは`keys()` / `values()` / `entries()` / `Symbol.iterator` / `forEach()`を呼んだ時点で取得し、native iteratorの遅延消費・live iterationの挙動は保つ。iteratorが返すobject key/member/valueは消費時に同mode proxyへwrapする。
| WeakMap | `get(k)`はkeyごとのvalue。`has(k)`はkeyごとのexistence。object keyとnative runtimeが許すnon-registered symbol key | new set: value/existence。existing value change: valueのみ。同値set:なし。成功delete:該当keyのvalue/existence |
| WeakSet | `has(v)`はobject memberごと。native runtimeが許すnon-registered symbolも対象 | new add / successful delete:該当member。重複add、不在delete:なし |

`Map.size`は値だけを変えるsetで再実行しない。`Map.keys()`も値更新で再実行しない。entry iteratorはvalueを返すため既存keyのvalue更新で再実行する。Weak collectionはkey単位以外の依存を持たない。

## Runtime / cleanup要件

- internal collection methodsの実装読みはuntrackedにし、ユーザーが実際に読んだkey/value/iterationだけを収集する。
- writesは`adapter.batch`を通す。`untracked()`ではread dependencyを足さず、write通知は通常どおりflushする。
- effect、React render subscriber、foreign readable bridgeの購読がなくなったremoved key metadataを、mutation後のflush時に既存のliveness-aware version sourceで剪定する。外側の`batch()`内で削除されたkeyは、outer batchのflush後のmicrotaskでsweepする。Map/Setに現存するkey/memberのmetadataは、購読者がいなくても将来の変更通知に必要なため保持できる。object key metadataはWeakMapで保持し、別Mapでkeyを強参照しない。primitive key metadataは次のcollection mutation/sweepまで残ることがある。購読解除直後・mutationなしの同期的解放は保証せず、M2ではruntime lifecycle hookを追加しない。
- speculative readでcollection dependencyをdurable subscriptionとしてpromotionしない。existing render/graph ownerとcross-copy contractを維持する。
- descriptor/prototype mutation、non-extensible targets、class instancesは現行同様にsafe boundaryを定義し、partial reactivityを誤って主張しない。

## M2の開始条件と受け入れ条件

1. Map/Set/WeakMap/WeakSet各handlerをcollection method単位で設計し、同期的なnative return/iterator behaviorを決める。Map/Setの非mutating ES2025 Set operations、raw/proxy keyの正規化、iterator結果のlazy wrappingも含める。
2. mode別proxy cacheとraw/proxy normalization prototypeを先に作る。同じraw graphを両modeから共有した場合のidentityと通知をテストで固定する。
3. collection root、nested collections、entry object、same-value writes、key/value iteration、size、clear、weak key ops、alias/cycle、raw/proxy duplicate、batch/untracked、speculative reads、cleanup、TypeScriptを境界テストで覆う。
4. collection raw references、weak entry prepopulation、cross-copy deep proxyの限界を実測・検証し、できない保証はAPI docsで明示する。
5. M2完了時にpublic API docs、migration note、既知のlimits、性能前後の比較計画を更新する。

## 実装結果

- `DeepSignalOptions`と `{ collections: "reactive" }` を公開し、default modeのopaque collection動作を維持した。
- mode別proxy cache、Map/Set/WeakMap/WeakSet instrumentation、raw/proxy identity normalization、lazy wrapping、batch通知、dependency pruningを実装した。
- raw/proxy重複key/memberは正規化後にTypeErrorで拒否する。同一realm標準collectionのみを受け入れ、subclass/cross-realmは拒否する。Weak collectionのsymbol keyはnative runtimeが許す場合に対応する。
- `deep-signal-collections.test.ts`、`deep-signal.test.ts`、`deep-signal-review-regressions.test.ts` が66 tests passed。`tsc --noEmit`も成功。
- 公開利用例と制限はcore primitives guide、およびv0.3 migration guideに記載した。性能比較はM7で同一条件のbaselineと比較する。

設計gateはM2のAPI/dependency契約を記録し、この節はその契約に対する実装・focused qualificationの結果を記録する。
