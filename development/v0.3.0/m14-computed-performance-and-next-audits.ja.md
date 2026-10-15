# M14 — Computed performance and next audits (2026-10-15)

Baseline: `7ca77fb29b1f5dbc0a9bf9c1aaff416ffda4350d` (M13 READY candidate).

M13のrelease-readiness判断は履歴として維持し、computed生成profileで改善余地が確認されたため、M8 freezeをM14の性能改善・追加監査のために解除した。runtimeは自前実装、graph backendは`alien-signals@3.2.1`のまま。公開API、package version `0.3.0`、閾値、サイズbudgetは変更していない。

## Profileと計測方法

環境はNode `v24.21.0`、Windows x64、AMD Ryzen 7 PRO 6850U。baselineは開始SHAからruntimeをbuildし、新規processで3回測定。候補の設計比較はbaseline/candidateを各2回、新規processで交互に実行した。computed profileは10,000 iterations、warmup 2回、sample 5回。CPU profile / allocation samplingは専用profile runで取得した。

CPU profileでは`attachProtocol()`内のprotocol生成、`registerHelperBrand()`、`makeNode()`が目立った。CPU sampleはinlined function単位の概算であり、exclusive CPU timeではない。allocation samplingでは`attachProtocol`配下に約1,048,656 bytesが現れたが、これもsampling結果であり正確な全allocation量ではない。CPU/heap profileおよびraw benchmark logを本directoryに保存した。

baselineのpublic API create/discardedは30,000 iterationsでround median 226.807 / 273.574 / 305.309 msと広く変動した。このため小さな差を改善として扱わず、後述の同条件candidate A/Bを判断材料とした。raw alien-signalsはwritable computedを提供しないため参考値に限定した。

## 試した設計と採否

1. **ProtocolをSignal本体に直接実装** — version/runtimeToken/getRevision/subscribeをbase prototypeへ置く案は、不許可の継承可能な名前をruntime surfaceへ露出するため不採用。
2. **Interop protocolのlazy materialization（採用）** — 各readableに置く非enumerable `READABLE_INTEROP_V1`をdata propertyからgetterへ変更。cross-copyがSymbolを読む初回だけprotocol objectを生成し、`WeakMap`にstable identityをcacheし、runtime nodeにも保持する。初回ローカルread・生成時にはprotocol objectを作らない。getter経由の`Reflect.get`、interop取得API、同一Signalのprotocol identity、foreign subscriptionを保持する。内側Symbol property descriptorの`value`が`get`へ変わるため、descriptor introspectionでは形状差が観測可能。
3. **Brand descriptor共有案** — 別worktreeで`Object.freeze()`した共有descriptorを`defineProperty`へ渡す方式を試した。focused 38/38、3-copy smoke、runtime typecheck、size budgetはpass。5,000 iterationsのpaired profileは、例としてgetter create/discardがpair 1で39.645→57.970 ms、pair 2で47.779→62.196 msと候補側が遅く、他のcaseも逆方向を含む大きなhost noiseがあった。retained heapは約0.6–0.8%減ったがdiscarded heap診断は候補側が増加。Core chunk gzipも10.07→10.08 kBでsize benefitは見られず、性能改善を立証できない。allocation削減はbrand登録ごとの小さなdescriptor object一つに限られるため不採用。

追加したruntime testは、local readのみではprotocolを生成しないこと、interop Symbol descriptorが非enumerable getterであること、Symbol read後にnodeへ安定したprotocolがcacheされることを確認する。別worktreeの3-copy smoke、1,000 computedをmaterialize後のforced-GC probeもpassし、20回GC後にWeakRef生存は0だった。

### 同条件A/B — public API、10,000 iterations、2 warmups、5 samples

| Case | Baseline run 1 | Candidate run 1 | Baseline run 2 | Candidate run 2 | 判断 |
|---|---:|---:|---:|---:|---|
| Getter-only create/discard | 50.998 ms | 25.040 ms | 47.856 ms | 25.833 ms | 46–51%短縮 |
| Getter-only create/retain | 64.196 ms | 34.361 ms | 50.755 ms | 43.554 ms | 両roundで短縮、幅あり |
| Writable create/discard | 45.279 ms | 26.846 ms | 60.450 ms | 33.665 ms | 両roundで短縮 |
| Writable create/retain | 53.317 ms | 33.206 ms | 51.972 ms | 38.412 ms | 両roundで短縮 |
| Create + first read | 81.004 ms | 26.813 ms | 60.283 ms | 36.055 ms | candidateが両roundで短縮。baselineの分散大 |
| Cached read | 2.982 ms | 1.875 ms | 2.771 ms | 2.028 ms | 両roundで短縮 |
| Dependency update + read | 17.547 ms | 11.166 ms | 16.894 ms | 8.253 ms | 両roundで短縮 |
| Observed update | 17.715 ms | 13.845 ms | 23.103 ms | 18.207 ms | 両roundで短縮 |
| Writable set + read | 5.959 ms | 3.959 ms | 5.356 ms | 3.429 ms | 両roundで短縮 |

Getter-onlyで10,000個retainしたときのheap deltaはbaseline 3,283,128 / 3,297,624 bytes、candidate 2,567,344 / 2,564,832 bytes（約22%減）。Heap deltaはGC後の診断値であり、全allocationや一般的なheap保証ではない。candidateのcross-copy benchmarkは全checksumが期待値と一致し、3 process medianは21.477–26.652 ms、19.273–22.380 ms、17.167–22.154 ms。baselineは33.221–70.308 ms、26.191–38.677 ms、62.849–111.102 msで、process間ばらつきが大きいため参考値に留める。

React mount/update計測はpaired run間の分散が大きく、安定した改善/退行を示さない。render countは維持された。最終buildで`core-runtime`は46.26 kB / 10.07 kB gzipから46.60 kB / 10.12 kB gzipへ増加（gzip約+0.05 kB、約+0.5%）。7つのbundle budgetsは全てpass。size上昇は初回cross-copy用protocolを遅延生成する小さな実装コストとして許容する。

## Managed tracking — M15候補

独立したtransform調査では、direct static `.value` chain、constの`"value"` alias、同一module内の同期helper、静的に解決できる`map`等の同期callbackは現在のtransformで追跡できる。`all`、明示opt-in、annotation/Hook、または他の静的readで関数が選択される場合、dynamic member readも実行時captureされる。一方、importされたplain helper本体は`auto` selection時に静的解析されず、deep proxy destructuring (`const {user}=state.value; user.name`) 後のproxy readとJSX render prop/children callbackはmanaged attemptの同期境界外になり得る。これらを暗黙に同等保証と説明しない。

M15では最初に安全性の高い一段static destructuringをprototype化する。sourceを一度だけ評価し、key/getterの評価順・TDZ・例外を保ち、取得aliasの後続static property readをcaptureへ昇格できるか確認する。nested/computed/default/restを含む形は個別に証明できるまでskipし、diagnosticsを補う。Rules of Hooks、Fast Refresh、React Compiler、SSR、abandoned render cleanupを満たせない形は誤変換しない。imported helperとcallback boundaryは明示Hook/annotationか診断案内を優先する。

## DOM retention — 実ブラウザ監査

Playwright headless Chromium `156.0.8078.4`でCDP `HeapProfiler.collectGarbage`を3回要求。React標準input/select、RFSG input/single/multiple select/radio-checkbox group、empty rootを各8 mount/unmount cycle実行した。WeakRefで追跡したhost nodeは112/112回収され、RFSG固有のretaining pathは確認されなかった。heap snapshotは参照がすべて切れたため不要と判断した。これはこのケース/Chromiumでの観測であり、全browser・長時間利用のleak-free証明ではない。M16は具体的な保持再現が出た時に対象を絞って続ける。

## Qualification

- Runtime coverage: 40 files、621/621 tests、Statements 94.13%、Branches 90.30%、Functions 97.52%、Lines 95.91%。threshold変更なし。
- Transform coverage: 8 files、408/408 tests、Statements 92.85%、Branches 90.36%、Functions 97.37%、Lines 95.47%のpackage単独full runを確認済み。後続の全体再実行は、既存のesbuild adapter testが固定5秒timeoutを超えて1〜2件失敗した。timeoutは変更していない。失敗ケースは他の集約条件では単独passを確認したが、高負荷の最後の再試行では`.js` rewrite testが再び5.072秒となった。Host上でDropboxが約2.7 GB working set、他のbrowser/compiler processも常駐しており、local worker負荷が高い。coverage thresholdもtestも変更していないためGitHub Testを最終集約判定とする。
- Typecheck: pass。Lint: exit 0、既存warningあり。Build: runtime/transform pass。
- Consumer pack/install/Vite smoke、3-copy duplicate runtime、mixed-version 0.1.1 smoke: pass。mixed-versionで世代間`isSignal`/JSX/effect interopがunsupportedとして拒否される現行契約も維持。
- Browser E2E: 5-worker探索は69/71で、Firefox初回hydration timeoutとWebKit Activity hidden-reader assertionの2件が失敗。既知の負荷依存ケースを区別するため、完成したsourceで`CI=true`・1 workerにて再実行し71/71 pass（Chromium/Firefox/WebKit、production bundle、React Router）。閾値・spec・testは変更していない。
- Bundle budget: 7/7 pass。GitHub Actionsはpush後の結果を追記する。

## Freeze判断と次の作業

M14のlazy protocolは生成コストとretained heapの改善が両roundで確認され、cross-copy correctness・public surface・bundle budgetも維持したため採用する。Observed updateおよびReact実測は一貫した高速化を示さず、一般的なReact性能向上は主張しない。M13 READYは当時の判断として残す。最終qualificationとGitHub workflowsを確認してからM8を再freezeする。

M15はmanaged trackingの安全なdestructuring/alias範囲とdiagnosticsを詰める。M16はこの監査でleak blockerが見つからなかったため、再現可能なretaining pathが提示された場合に再開する。
