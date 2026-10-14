# M9 — API redesign and collection performance (2026-10-14)

## 状態

M8で行ったv0.3.0のre-freezeは履歴として残す。この開発でそのfreezeを解除し、APIとcollection runtimeを更新した。ここに記録する結果は公開前の候補qualificationであり、公開やreleaseの承認を意味しない。

基準commit: `1f5017fc61721f6a4ce29ba9c1f9bd08c223bc2f`。主な実装commitはM8から後に追記する。

## Phase A — `deepSignal` の既定仕様

`deepSignal(value, options)` のoptionsと公開型 `DeepSignalOptions` を削除し、same-realmのplain object、array、`Map`、`Set`、`WeakMap`、`WeakSet`を既定で追跡する。rootとnested collectionの読み書きを `.value` に統一した。legacy read-only Map/Set viewとそのcache、opt-in用コード・テスト・benchmark指定を削除した。`useDeepSignal()`も同じ仕様を使う。

`.value`から取得したcollectionを変更するとkey/iterationの購読者へ通知する。元のraw collectionと`.peek()`からの変更は通知を迂回する。plain object、array、collection以外の不透明値は従来どおりProxy化しない。object aliasとcycle、raw/proxy identityの既存契約を維持する。

破壊的変更は、第2引数optionsの削除とread-only collection viewの撤去。以前の`collections: "reactive"`は不要になり、既定で全collectionがreactiveになる。

## Phase B — 明示的なJSXフォームbinding

新しいpropsは `bindValue` と `bindChecked`。前者はtext系`input`と`textarea`、後者はcheckbox inputで書き込み可能なSignalを要求する。`value`と`checked`はReact標準の意味論を維持する。標準のvalue/checkedへsignal objectを渡すと移行案内付きruntime errorになり、RFSG JSX型でも拒否する。selectとradio groupはReact controlled inputのまま。

text fieldはnative `input` event、checkboxはnative `change` eventでsignalへ書き戻す。Reactの`onChange`/`onInput`はそのまま呼び出される。direct listenerが先にsignalを更新するため、handlerが編集を無視しても入力拒否にはならない。IME中の外部更新は`compositionend`まで遅らせ、text selectionは対応するinput typeで維持する。form resetは最後にDOMへ適用したsignal値を戻す。SSR/hydrationでは初期値を一致させ、hydration前編集が上書きされる可能性を明記した。

このAPIはRFSG JSX runtimeでのみ認識される。通常のReact JSX runtimeと同じ動作をしない。

## Phase C — Weak key semantics と collection cleanup

native WeakMap/WeakSetが受理するobject keyは不透明なidentityとして扱う。RFSG自身が生成した既知proxyだけrawへunwrapし、それ以外のkeyのown propertyやprototypeを走査しない。これによりrevoked Proxyとthrowing `ownKeys` trapを持つProxyもnativeと同様にkeyとして扱う。Symbolの受け入れ条件もnative runtimeに合わせ、登録済みSymbolのstrong metadataはmutation-driven sweepで回収する。

primitive collection-key metadataはsignal dependencyの最後の購読者が外れた瞬間を通知するhookを持たないため、最後のunsubscribe時の直接cleanupは追加しなかった。現在のbounded mutation-driven sweepを維持し、metadata候補が0ならiterator生成自体を省く短絡を追加した。128候補を超えるcleanupはtask turnへyieldして最後まで掃引する。object keysはWeakMap/WeakSet metadataにWeakMapを使い、metadataからkeyをstrong retentionしない。

`benchmarks/collection-scaling.mjs`はMap/Setのupdate/add/delete、10/1,000/10,000 subscribed keys、WeakMap/WeakSetのnative/reactive比較、empty/own-data object keys、unsubscribe後cleanup、heap deltaを計測する。quickとfullのraw結果、median、mean、variance、standard deviationを`m9-collection-scaling-*.json`に保存する。測定環境はNode v24.21.0、Windows x64、AMD Ryzen 7 PRO 6850U。

### Weak collection before/after

同一quick fixture（3 samples、各300 operation sequences）で、自前propertyを持つobject keyのreactive Weak collection操作は次の中央値になった。native/reactiveは同じ順序の複合操作（例: `set`+`get`）あたりnanosecondsで、個別method時間ではない。

| Sequence | 前: graph normalizationあり | 後: opaque identity | 倍率 |
| --- | ---: | ---: | ---: |
| WeakMap set + get | 23,788 ns | 1,612 ns | 14.8× |
| WeakMap update + get | 20,392 ns | 1,639 ns | 12.4× |
| WeakMap delete + set + get | 38,485 ns | 2,337 ns | 16.5× |
| WeakSet add + has | 10,347 ns | 1,966 ns | 5.3× |
| WeakSet duplicate add + has | 10,366 ns | 1,181 ns | 8.8× |
| WeakSet delete + add + has | 28,570 ns | 1,248 ns | 22.9× |

改善はobject keyを正しくnative互換に扱う修正そのものから得られ、別の意味論を省略していない。ただしquick計測は3 samplesなので、これを全machineでの性能保証とはみなさない。`m9-collection-scaling-final.json`は7 samples/2,000 sequencesのfull計測。Map/Set 10,000購読keyのmutation中央値はおよそ125–154 µs。unsubscribe自体は1–49 ms、10,000 keyの後続sweepはMap約1.21 s、Set約2.04 sの中央値だった。掃引はtimer turnへyieldする。heap deltaはGCとallocatorのばらつきが大きく、retentionの有無やbytes/keyを断定しない。

## Phase D — managed React tracking

managed transformはtop-level `useSignalCapture()`とper-read captureを維持し、確実に同期と証明できる式だけをwrapする。destructured deep-proxy reads、signal accessor destructuring、dynamic key、import helper、JSX render-prop/children callbackで無条件の依存取得を約束しない。特定可能なdestructuringや遅延callbackにはdiagnosticを出し、deep proxy propertyを含む必要がある場合は明示的な先頭文`useSignalTracking()`を残す。`mode: "auto"`/`"all"`/`"manual"`は関数選択の方式で、選択後のcapture意味論は変えない。

`mode: "all"`でも不透明な別module helperや非同期callbackをcaptureできない。安全なrewriteの根拠がないpatternは自動書換えしない。readを実際に実行するcomponent/Hookへ移すか、同期ambient trackingを明示する。

## Vue 3.6との設計差

参考実装は`vuejs/core` v3.6.0-rc.11、commit `b55f3b92a185e87680ca7f69252451964be08b00`。Vueはruntimeがeffectとcollection操作を所有し、collection target/keyのdependencyを追跡する。M9は同じくper-key notificationを維持する一方、low-level graphを`alien-signals`へ委譲し、React componentのrender ownershipとHook順序を守るため、managed transformが静的に証明できる読み取りだけをcaptureする。Reactのrender全体をVueのeffectのようなambient scopeとして所有しない。collection metadataもVue Depのsubscriber unlink時cleanupを直接移植せず、現在利用可能なsubscription lifecycleに沿ってbounded sweepを使う。

## Core-only consumer bundle

packしたv0.3.0 runtimeをclean Vite consumerにinstallし、package rootから`signal`/`computed`だけをimportした実bundleを確認した。core-only bundleは47.34 kB raw / 10.47 kB gzipで、React識別markerを含まなかった。別のsubpath exportやpackage分割は不要と判断する。

## 対応しなかった提案

- `markRaw()` / `shallowDeepSignal()` は、今回の要件に固有のユースケースが確認できず追加しなかった。
- WeakMap/WeakSetの最後のunsubscribe時cleanupは、subscriber lifecycle hookのないadapterから安全に実装できないため採用しなかった。bounded sweepと0候補短絡を維持する。
- form bindingは`select`/radioを含む全要素へ広げなかった。radioのshared selectionとselect option lifecycle/resetに別の契約が必要で、まずtext/checkboxを正確にする。
- runtime keyだけを使うmanaged componentを`auto`で自動選択しない。静的なreadがなければ明示opt-inまたはambient trackingを求める。

## Final qualification record (2026-10-14)

- `pnpm test:coverage`: runtime 40 files / 573 tests passed; statements 93.07%, branches 88.83%, functions 96.06%, lines 94.63%. Transform 8 files / 408 tests passed; statements 92.85%, branches 90.36%, functions 97.37%, lines 95.47%. Thresholds and exclusions were unchanged.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` passed. Lint reports existing warnings, with no errors. The final production browser build no longer reports a false destructuring warning for the collection sweep iterator result: `Reflect.get` keeps that non-signal `.value` read outside the managed capture syntax.
- `pnpm test:browser`'s Playwright webServer subprocess could not resolve the configured Volta pnpm 12.3.4 shim. The same Playwright config and all local production/dev servers were then run through Node directly; Chromium, Firefox, WebKit, production-build, and React Router passed 59/59. The first run exposed a stale test expectation: form reset correctly restored the latest accepted signal value. The browser and production assertions now match the documented contract and passed on rerun.
- React Compiler suite: 27/27 passed. Real-browser Fast Refresh harness: 18/24 passed; all managed Oxc/inject/Babel scenarios passed. The six known failures are the ordinary React `try/finally` and Preact Oxc control variants with hook-shape edits, as previously recorded in M8; these are not failures in the RFSG managed paths.
- Clean consumer pack/install/Vite smoke passed for both v0.3.0 tarballs. The core-only runtime consumer bundle was 47.34 kB raw / 10.47 kB gzip and contained no React markers. Genuine three-copy interop, `test:phase4-duplicate`, and mixed-version v0.1.1 compatibility smoke passed.
- `pnpm size`: all seven existing gzip budgets passed. Final sizes were signal-only 7.09 kB, core 7.12 kB, core+hooks 8.82 kB, deep 13.88 kB, full entry 19.85 kB, JSX runtime 12.06 kB (at its existing budget), and utils 8.63 kB.
- Japanese migration/guide links were checked against actual Japanese heading anchors. The final independent code review found no release blocker. It noted a low-priority interop edge: a custom branded writable signal whose `value` setter is inherited above its immediate prototype is rejected by the compact runtime check; native RFSG and cross-copy signals are accepted. This tradeoff keeps the published JSX runtime within its unchanged size budget.

The post-fix full benchmark is saved as `m9-collection-scaling-final.json` (Node v24.21.0, Windows x64, Ryzen 7 PRO 6850U; 7 timing samples and 5 cleanup samples). For 10,000 subscribed keys, observed Map update/add/delete medians were about 62/88/72 µs and Set duplicate-add/add/delete about 89/94/51 µs. Unsubscribe medians were 1 ms or less. The 10,000-key sweep medians were about 1.22 s for both Map and Set. These timing samples vary substantially across runs; they do not support a universal performance claim. Post-sweep heap deltas also vary with GC and allocator behavior, so no bytes-per-key or leak-free claim is made. Cleanup work remains bounded to 128 candidate checks per turn and continues in timer turns.

No M9-specific release blocker remains. The documented Oxc Refresh-signature failures occur only in non-RFSG control variants. M8 is re-frozen on the final M9-qualified v0.3.0 candidate, integrated on `main`. The push revision and GitHub Actions outcomes are recorded below after remote verification. No release tag, npm publish, or GitHub Release is part of this work.

### Commits

- `5da19c7` — default deep collection reactivity and option removal.
- `4694dbf` — safe managed tracking and destructuring diagnostics.
- `855ba39` — bounded collection cleanup measurements.
- `ac80052` — installed core-only consumer bundle smoke.
- `7a7eec1` — explicit JSX form bindings.
- `a523afb` — native opaque WeakMap/WeakSet key semantics and iterator transform-safe read.
- `82f7e8a` — compact binding validation and migrated runtime fixtures.
- `9b7a7e4` — browser reset assertions aligned with accepted signal edits.
