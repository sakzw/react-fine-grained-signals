# M6 — JSX direct binding qualification audit

## v0.2.1時点の実装

M6の中核機能は未実装ではない。`src/runtime/jsx.ts` にhost binding、`docs/guides/jsx-bindings.md` に利用契約がある。v0.3.0では既存契約を再評価し、足りないqualificationを埋める。

- HTML hostのtop-level signalは`title`、`id`、`className`、`hidden`、`disabled`、`style`、`value`、`checked`、`data-*`、`aria-*`を束縛する。styleはobject全体のsignalで、`style={{ color: signal }}`は未対応。
- `input`/`textarea`/`select`の`value`と`input`の`checked`は`defaultValue`/`defaultChecked`を通して初期化し、attach後にDOM propertyを直接同期する。multiple select、遅延option、IME compositionの処理がある。
- NodeBinderは同じDOM node上でbindingを差分更新する。detachは通常prop/styleをReact snapshotへ復元し、signal/plain切替ではhost nodeとchildrenを保つ。controlled/uncontrolled切替でReact warningが起こり得る。
- SSR/hydrationの初期値一致条件とbinding read/ref例外時の扱いはdocsにある。JSX型はHTML intrinsicと非HTML hostで許可範囲を分ける。

## 高リスクのqualification gaps

1. **フォームreset:** 契約をdocs既存記載と一致させた。signal writeで設定されたdefault値へのnative resetとReact form action自動resetは対応する。ユーザー編集を`onChange`でsignalへ書いた場合、Reactがdefault値をownerの最終render値へ戻すため、native resetはDOMをそのrender値へ戻してもsignalは直前値のままになる。reset時にsignalを変更する場合はactionまたは`onReset`で明示的にwriteする。JSDOMとChromium production buildでsignal write、form action自動reset、accepted/declined editの差異をテストした。
2. **SSR select:** SSR/hydrationでsingle/multiple selectの初期選択とhydrate後のsignal更新を確認。SSR時に未存在だったsingle-select optionがhydrate後に追加された場合の再選択も確認した。JSDOMではsingle/multiple selectともsignalの最新default値へnative resetできることを確認した。
3. **style property lifecycle:** HTML hostのper-property signalをref commit時にpropertyごと直接subscribeする。render中にsubscriptionを作らない。signal/plain混在、render間のshape replacement cleanup、SSR/hydration、ownerの非再レンダーを確認した。同一objectをrenderなしで直接mutationした場合のshape変更は対象外。
4. **型/runtime境界:** deepSignal拒否、`select multiple`の配列型、`option`等の`value`、非対応HTML hostのpropsを型テストでさらに固定できる。
5. **derived input value:** computed valueが入力文字列と異なる場合、caretが末尾へ移る可能性は既知制限で、現状は受容済み。

## 残りのqualification順

1. JSX型テストでmultiple value、deepSignal、option、非HTML host、plain/signal切替の境界がどこまで既に固定済みか確認し、不足だけを追加する。
2. 既存のdirect-binding closure、StrictMode、exception、IME、hydration browser testsをmilestone checklistへ紐付ける。開発SSR browser matrixは48/48で完了した。

## 追加qualification記録（2026-10-13）

- `tests/react-dom-binding.test.tsx` と `tests/ssr.test.tsx`: 47 passed（別々に実行）。single/multiple selectのnative reset、single/multiple selectとper-property styleのSSR/hydration/updateを含む。
- `e2e/browser.spec.ts` の追加reset scenario: Chromium production buildで1 passed。signal write後のnative reset、React form action自動reset、accepted edit後のDOM/signal差異を実ブラウザで確認した。全browser engineは未実行。
- 開発用SSR harnessで`e2e/browser.spec.ts`をChromium/Firefox/WebKit各16件、合計48/48通過。初回cold optimizerでFirefox hydrationの30秒navigation timeoutが1件発生したため、Vite cacheをwarmにし60秒timeoutで全matrixを再実行した。Firefox単体retryもhydration・更新まで通過した。production-browser gateとは別のdev SSR/hydration gateを閉じた。
- 2026-10-14にrootのesbuild test dependencyを加えたlockfileでSSRを再確認したところ、Vite module runnerがReact CJS entryをESMとして評価して失敗し、また別プロセスとHMR portが競合するとSSR module invocationがtimeoutした。開発harnessにSSR-only native `createRequire` bridgeと専用HMR portを追加し、60秒navigation timeoutでcold Firefoxを含む全dev matrixを再実行。Chromium/Firefox/WebKit各16件、48/48 passed。Firefox単独cold-start matrixも16/16 passed。
- Per-property style bindingはrender後にpropertyごとのsubscriptionをattachする方式で実装した。render中にcomputed dependencyを残さない。signal/plain mixed entryとrender間のshape replacement cleanup、SSR/hydration後の更新を確認。root `tsc --noEmit` は成功。
- 当初、accepted edit後にresetすると信号最新値へ戻る想定でテストしたが、既存docsに記載されたReact default restorationと一致しなかった。契約を変更せず、テストを「DOMはownerの最終render defaultへ戻り、signalはonChangeのwrite値を保持する」と修正した。
- Production-browser qualificationで全engineがcoverするのはsignal counter、allowlisted props、form reset、styleの12ケース。select-specific SSR/hydration/resetはJSDOMで確認済みで、全engineのDOM select matrixは未実行。dev SSR browser harnessは権限付き直接起動後、48/48通過した。

M6完了条件は、form action/resetとselect hydrationの契約がテストか明示的な非対応範囲で確定し、型/runtimeのhost差とstyle entry lifecycleが説明され、browser binding lifecycleに重大な回帰がないこと。
