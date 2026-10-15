# M17 — Final API & Scope Decision

開始main HEAD: `2394e4ccf1e7de9ef3d37aef82fb08ac2df24425`
比較基準: tag `v0.2.1` / commit `58f01b9314a1b09b88b162c57912ff736201e790`
判断対象: package version `0.3.0`。このマイルストーンでは公開、version変更、tag作成を行わない。

## 結論

v0.3.0の現在の公開APIと対象機能は、React 19向けのfine-grained signal rendering libraryとして一貫した範囲にまとまっている。今回の監査で、公開前に必要なRuntime再設計、新しい公開API、breaking change、または再現性のあるrelease blockerは見つからなかった。**v0.3.0の機能スコープをここで固定し、新機能を加えずにrelease candidateとして扱える。** 実際のpublishやrelease操作は別途行う。

M17は既存qualificationの再実行ではなく、v0.2.1との差分、現行実装・型・英日ユーザーガイド、M13〜M16.1の証拠を突き合わせたscope判断である。開始時のmainはcleanでbaselineと一致していた。

## v0.2.1からの機能差分

| 領域 | v0.3.0の現行仕様 | 判断 |
|---|---|---|
| Core primitives | `signal`、lazy `computed`、writable `computed({ get, set })`、`effect`、`batch`、`untracked`を提供。writable/readonlyを型とruntime capabilityで区別 | 一貫しており維持 |
| deepSignal / Collections | plain object、array、same-realmのMap/Set/WeakMap/WeakSetを既定でproxy化。per-key/per-operation dependency、native weak-key意味論、遅延proxy化を提供。旧opt-in collection API/viewを削除 | よく使うcollectionを単一APIに統合。raw/`.peek()`経由の変更は通知しない |
| Writable computed | coreと`useComputed`にreadonly/writable overloadを提供。setterはbatch/untrackedで動き、getterが現在値の正本 | フォームbindingを含め契約明確 |
| Explicit form binding | `bindValue` / `bindChecked`を導入。text、textarea、single/multiple select、radio/checkbox group、reset、SSR/hydration、IMEとReact event順序を扱う。Reactの`value`/`checked`は通常のcontrolled APIのまま | 暗黙signal propからの移行はbreakingだが、意図を分け所有権が明確 |
| React managed tracking | 関数全体を包む旧managed `try/finally`を廃止し、top-level `useSignalCapture()` + 静的に証明できる同期readごとのcaptureへ変更。injectとbare trackingはbest-effort ambient scope | Hooks/Compiler/Fast Refreshの制約を踏まえた選択 |
| Destructuring / aliases | direct static pathとalias追跡に加え、限定されたstatic const object/nested object destructuringを一度だけ・元の順序で展開。後続のproxy property readも追跡 | subsetを明示しており、変換の意味論を優先 |
| JSX DOM binding | RFSG JSX runtimeでsignal childとallowlist host prop、style、明示form bindingをDOM leafへ直接同期。値変化で親React renderを要求しない | opt-inの独立した最適化レイヤー |
| Reactive utilities | `Show` / `Switch` / `Match` / `For` / `Index`を提供 | 維持。`For`/`Index`追加最適化の計測根拠はなく、現状以上の最適化は不要 |
| Interop | 0.3.x package copy間でreadable subscriptionとsignal/JSX/deep readsを連携。cross-copy batchは各copy内だけで、単一atomic transactionではない。v0.1.xとのsignal reactivity混在は非対応として拒否 | cross-copyとgeneration boundaryを明記 |
| React Compiler / Fast Refresh | managed transformをCompilerより前に実行。managed Oxc/BabelのHMR Hook-shape scenario、Compiler、StrictMode、Suspense/Concurrent/abandoned renderを検証 | 検証済みの現在契約を維持 |
| SSR / hydration | server markupとclient bindingの初期値一致を前提に、hydration後のtracked renderとDOM binding更新を提供 | consumerおよびbrowser qualification済み |

差分全体は開始時点で177 files（development資料・fixtureを含む）に及ぶ。上表は公開契約に関わる主要変更の要約であり、全内部変更一覧ではない。

## Public APIと使いやすさ

| 観点 | 評価と判断 |
|---|---|
| `signal` / `computed` / `deepSignal` | `.value` / `.peek()`を共通read modelとし、write capabilityを分けている。`deepSignal`はobject/array/collection向けという責任範囲が明確。追加aliasは不要 |
| Writable / readonly | getter-only `computed`は`ReadonlySignal<T>`、writable computedは`FormBindableSignal<T>`。readonly computedをform bindingから静的・実行時に拒否できる。汎用propsを`Signal<T>`へ広げるとform capabilityを失う制約は英日docsに例を含めて説明済み。markerはtype-onlyでruntime shapeを汚さない |
| Hooks | `useSignal`/`useDeepSignal`でcomponent-local state、`useComputed`/`useSignalEffect`でsignal graph、`useSignalValue`/`useDeepSignalValue`で明示leaf selectorを提供。call-siteごとのHook規則とdependency list制約も明示 |
| Collections | Map/Setのkey/value/iteration/sizeを別依存として扱い、Weak collectionsはnative key操作だけを扱う。mutationはreactive proxy経由が必要。raw mutationやcross-realm built-in、class instanceは対応範囲外。細かな意味論は必要だが追加Collection APIは不要 |
| Form binding | DOM ownershipが`bind*`で明示され、Signal→DOMとnative event→Signalの双方向をサポート。React標準controlled inputとの混同やsetter拒否後の表示不一致を避ける。`FormBindableSignal<T>`が必要な汎用component例も提示済み |
| Plugin mode | `mode`（対象functionの選択: `auto`/`manual`/`all`）と`transform`（read capture: `managed`/`inject`）を直交させる。`all`が未知callbackのcapture scopeを広げるわけではない。既定managedが推奨 |
| Tracking opt-in | managedが静的にwrapできないdeep proxy propertyや曖昧な同期helperには、明示的`useSignalTracking()`/annotation、値Hook、component化を使う。bare/injectはambient best-effortであり、lexical `useManagedSignals`とmanaged出力は同等ではない。違いとdiagnosticは現行ガイドに反映済み |
| JSX runtime | `jsxImportSource`またはfile pragmaで選択。自動runtimeが表せないspread後の`key`ではrootの`createElement` fallbackを提供。signal child/propsの許可領域はnative hostのallowlistで、React component propsへのsignal透過やSVG prop全般へのdirect bindingではない。制約は用途に対して意図的 |
| TypeScript | explicit bindingのsignal値、input種別、select `multiple`、conflict propsは型で区別し、dynamic booleanなどはruntime validationに補完させる。診断しにくい既知の型障害や新たな型穴はこの監査では未検出 |

特にM16.1ではpack済みruntime/plugin consumerからフォームを操作し、DOM値だけでなくsource Signal値とSignalからのDOM反映を両方assertした。M16.1の結果は[M16記録](m16-consumer-canary.ja.md)に追記済み。

## 残存制約と優先度

分類: **1** v0.3.0で改善価値が高い、**2** 後続へ送れる、**3** 意図した設計制約、**4** 調査済みで追加対応不要。

| 制約 | 分類 | 根拠と判断 |
|---|---:|---|
| Computed生成/interop overhead | 4 | M12のraw `alien-signals`との差は契約・adapterの異なる参考値であり同等比較ではない。M14はRFSG内のA/Bでcreate/discard中央値約46–51%短縮などを再現し、cross-copyとsize budgetを保ったlazy interop materializationを採用。残る差をrelease blockerまたは追加optimization根拠とする有効な測定はない |
| Managed destructuring subset | 3 | 既知のstatic const object/nested subsetはM15/M15.1で対応済み。computed/default/rest/assignment/mutable/annotated/destructured signal accessorなどは元の評価順序・例外・TDZを安全にpreserveできる変換が立証されていない。直接path、explicit tracking、selector Hookの代替があるためv0.3.0では範囲を固定 |
| Imported helper、dynamic aliases/keys、render prop / children callback、遅延callback | 3 | module間のbody/呼出側実行時点やReact Hook ownerを一般に静的証明できない。未知callbackへambient captureを延長すると誤subscription、stale owner、Rules of Hooks違反を招き得る。component化または明示boundary/Hookを使う。対応patternでstale renderなら不具合であり、既知制約として無条件許容しない |
| bare `useSignalTracking` / `inject` ambient scope | 3 | plugin無しでも便利なbest-effort互換レイヤーとして残すが、readが別component/effect/async callback由来の場合に正確なownerは保証しない。推奨はmanaged。manual `useManagedSignals`はlexical captureであり、managedのper-read outputと等価とは説明しない |
| Transformの巨大関数と500件alias chain | 2 | M15.1 batch expansionを保持し、正しいfixtureでcandidate 500件chain中央値約5.8秒。baseline 500件は60秒timeout、profileではBabel traversal/alias source checkが主費用でscope crawl/codegenは小さい。500件は極端な単一関数stressで通常consumerの問題は未確認。実buildの再現profileが出るまで大規模分割/再設計は行わない |
| Primitive collection-key cleanup sweep | 2 | 10,000 key cleanupはbounded 128候補/task turnで継続し、最終raw JSONではMap/Setとも約1.22秒median。以前のM9説明文にはSet約2.04秒の別計測値もあり、計測幅があるため一般的な速度保証とは扱わない。最後のunsubscribeだけでは即時cleanupできず、次のmutationでsweepが進む。大規模/長寿命collectionで実メモリ負荷が報告された場合はsubscription lifecycle hookまたはindex設計をprofileして検討。正確性を落とさず、現状では変更しない |
| 同一native radio groupの初回attach確認 | 2 | 各attachでnative peerを検査し、同じgroupへN件を順にmountする総量はO(N²)になり得る。一方Signal update hot pathは再走査せず、強参照registryを避けてReact delayed disposal/retentionを守る。通常formでは小規模で、巨大groupの実測問題があれば再検討 |
| Collectionのspecial cases | 3 | Same-realm標準builtin、proxy経由mutationが契約。`.peek()`/raw referenceからの変更、異realm、accessor/prototype mutation/frozen root、class instance等を追跡しない。広げる便益に比べ、identity/native semantics/Proxy複雑性が高いためscope外 |
| JSDOM final-host retention | 4 | M12の最後host survivorは後続retainer調査でJSDOM selector cache側に帰属。後続のVitest fixture再構築と実Chromium 112/112、JSDOM mount/unmount再checkでRFSG固有保持は再現せず、M16 consumerで製品修正は不要。retaining pathの記録を履歴として残す |
| Local full suite / browser実行時間 | 4 | 過去のhost負荷による固定timeoutは、失敗testのfocused retryとGitHub Test/E2Eの成功でテスト欠陥・製品不具合と区別された。threshold/timeoutを緩めていない。M16.1 SHAでもGitHub Test/E2E success。新しいCI failureや安定したclean-host reproが出た場合のみ再調査 |
| Fast Refresh外部control failure | 4 | 6件は通常ReactのOxc `try/finally` controlとPreact Oxc controlで、RFSG managed Oxc/Babelのsupported scenarios 18件はpass。RFSG sourceの失敗ではなく対応対象外 |

**分類1（v0.3.0で今すぐ改善するもの）はなし。** Collection sweepとtransform stressは数量の大きい特殊条件で計測されたため、測定値は隠さず記録し、一般利用の問題に拡大解釈しない。

## 追加機能候補

v0.3.0へ追加する新機能候補はない。特に任意callbackの自動capture、deepSignal object snapshot API、signalをReact component propsへ透過する機能、任意host/SVG prop binding、collection custom adapterは見送る。いずれも利用者コード上の便益に対して、callback/Hook ownership、immutable snapshot生成コスト、React prop semantics、DOM scheduler、native collection semanticsの互換性負担が大きく、現行APIで回避手段がある。

## 公開可能性と次のマイルストーン

**技術スコープ判断: v0.3.0はfreeze可能なrelease candidate。** M8 qualification gate、M16 consumer smoke、Browser E2E、Compiler/Fast Refresh、cross-copy、bundle budgetについて、最新のM16/M16.1証拠は成功し、重大な未解決release blockerはない。M13の`READY WITH KNOWN LIMITATIONS`はその時点の判定である。以降、M14のcomputed creation改善とretention調査、M15のdestructuring拡張、M15.2 benchmark修正、M16/M16.1 packed consumer監査が行われた。解消済み事項は当時の記録に履歴として残し、現在の制約と混同しない。

packageを実際に公開すること、version/date/release notesを確定すること、npm publish/tag/GitHub Releaseは本判断の範囲外で未実施。v0.2.1からのbreaking changeは利用者が少ないという前提だけでなく、API所有権を明示し、React standard semanticsを保つ仕様上の理由を持つ。

次は **M18 — Release execution checklist** を提案する。新しい製品機能は含めず、公開実行の明示指示があるときに、version/release notes、artifactとprovenance確認、pack/install確認、npm publish、tag/Release、公開後install smokeを実施する。実行指示までは0.3.0を未公開のまま維持する。公開を延期する間は、実利用でstale render・memory accumulation・build slowdownの再現報告があった時点で、小さなconsumer fixtureとprofileを作るmaintenance milestoneを切る。

## 実施した変更

- Runtime、Transform、公開API、package versionを変更していない。
- development roadmapの最新milestoneと現在のCI結果をM16.1へ同期し、v0.2.1 tag情報とM13以降の後続判断を修正した。
- 公開英語・日本語ガイドを主要なAPI契約、tracking boundary、M16.1 consumer assertionsと照合した。現行仕様の矛盾は見つからず、M0〜M16時点の歴史記録は履歴として保持する。
- コード変更を伴わないためテストは再実行していない。`git diff --check`を実施する。
