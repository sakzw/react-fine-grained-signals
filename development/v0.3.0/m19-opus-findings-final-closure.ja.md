# M19.2 — Opus Findings Final Closure

開始HEAD: `8f6d6878c208280d39e85d8408e1f1e45279ad92`

## 判定

LOW-5、LOW-8/9を再現条件どおり修正し、Lint、Transform branch coverage、実Vite Fast Refreshの取りこぼしを閉じた。既存のMEDIUM-1、LOW-1〜4、LOW-6/7の修正も維持した。

release readinessは**NOT READY**のまま。開始HEADの`index-full` gzipは25,102 Bで予算24,704 Bを398 B超えていた。今回の最終実装は25,343 Bとなり、開始HEADから241 B増、予算から639 B超過した。サイズ予算は変更していない。コードの修正を戻して既知不具合を再導入することは採用せず、サイズgateを未解決として残す。

npm publish、version変更、tag、GitHub Release、Pages deploy、release freezeは行っていない。

## Findings

| Finding | 結果 | 対応 |
|---|---|---|
| MEDIUM-1、LOW-1〜4、LOW-6/7 | **維持** | Transform diagnostics、parameter relocation安全性、mutation capture、README/JSDoc、classic Fragment、未対応Signal host propの既存修正は維持。M19.1の詳細と既存回帰テストを参照。 |
| LOW-5: binding ref cache | **FIXED** | cache末端の上限を増やす方式は使わず、attached host node数を追跡する。commit済みentryは参照中だけ保持し、最終detach時にcacheから外す。未commit/新規候補のみ最大8件を保持する。 |
| Lint | **FIXED** | Fast Refresh再現scriptの未使用`beforeHmr`を削除。 |
| Transform branch coverage | **FIXED** | RFSG Control Flow namespace/alias/destructuring解決、通常の`Match` callback診断、安全性を証明できないparameter relocation拒否を回帰テストで補完。branch coverageは89.39%から90.34%へ上昇。 |
| LOW-8: collection key metadata | **FIXED** | 最終subscriberの解除時に内部`unwatched`通知から既存のbounded settled sweepを予約する。後続read/writeを待たない。 |
| LOW-9: missing object key metadata | **FIXED** | LOW-8と同じ内部通知契約をproperty version sourceへ接続し、最後のunsubscribe後にbounded sweepを予約する。 |
| LOW-10: omitted-deps `useComputed` Fast Refresh | **FIXED** | signal-only computedを`useRef`から既存の`useMemo`へ統一。通常の再renderではidentityを保ち、Fast Refreshでmemoが破棄された際は編集後のgetter/setterを使う。 |
| Bundle size | **UNRESOLVED / RELEASE BLOCKER** | `index-full` gzipが予算を639 B超過。予算の引き上げや機能削除は行っていない。 |

### LOW-5の再現と結果

同じ`bindValue` Signal、同じ`name`、異なるoption valueだけを持つ9/16/32個のradio groupとcheckbox groupを用意した。固有の追加Signal bindingなしで、user refなし・同じuser refありをそれぞれ確認した。

通常の親再renderでref callback、click subscriptionのadd/removeは増えなかった。radio/checkbox選択、form reset後のSignal/DOM整合、unmount後のsubscription解放を確認した。mounted nodeが同じbinding構成を保持する間はentryがevictionされず、最終detach時にはentryとbindingの強参照がcacheから除かれる。

### LOW-8/9の通知境界

Core graphの最後のsubscriber解除を内部`unwatched`から通知する。Deep Signal version nodeに対するcallbackは`WeakMap`に保持し、全Signal nodeへcallback fieldを追加しない。property metadataはそのmetadataに属するversionのどれかがunwatchedになったときpending sweepを確認し、collection metadataも同じbounded sweepを予約する。永続timerは使わない。

元の2件の`it.fails`を通常の成功テストへ変更した。subscriber解除後にread/writeがないケースでprunable metadataが空になることを確認した。callbackはDeep Signal version source限定で、public APIやcross-copy protocolは追加していない。

### LOW-10の実Vite確認

Vite 8.3.4、React 19.3.0、Chromium、StrictModeで`development/v0.3.0/m19-opus-fast-refresh-repro.mjs`を実行した。HMR後にcomponent state `1`を保持し、getter表示を新factorの`45`へ更新。編集後のsetterからSignalへ`20`を書き込み、effect接続数は1を維持した。続くSignal更新とunmount後のcleanupも成功し、console error/warningは0件だった。

### Bundleサイズ

| Scenario | 現在のraw | gzip | Brotli | 結果 |
|---|---:|---:|---:|---|
| `index-full` | 98,948 B | 25,343 B | 22,385 B | 予算24,704 Bを639 B超過 |
| `jsx-runtime` | 48,885 B | 13,850 B | 12,405 B | 予算内 |
| `lite-jsx-child` | 25,219 B | 7,161 B | 6,458 B | 予算7,552 B以内 |

開始HEADの`index-full` gzip 25,102 Bとの同条件比較では、最終実装は+241 B。単独差分のbuildではLOW-8/9通知実装が約+206 B、LOW-5 ref cache実装が約+145 Bだった。圧縮は非線形なので個別差分は合算できず、他の変更による相殺もある。Core-only、Lite、既存のscenario budgetは維持し、`size-budget.json`は変更していない。

## 検証

- `pnpm lint`: 成功。新規lint errorなし。既存warningは残る。
- `pnpm typecheck`: runtime / transformとも成功。
- `pnpm test:coverage`: Runtime 44 files / 960 tests pass、branch 90.57%。Transform 9 files / 738 tests pass、branch 90.34%。
- focused React/Deep Signal/JSX tests: 5 files / 202 tests pass。LOW-5の9/16/32 group回帰、LOW-8/9の最終unsubscribe回収、Hooksを含む。
- `pnpm build`: runtime build、plugin build-smoke成功。
- `pnpm test:consumer`: packed runtime/plugin install、consumer typecheck/build、SSR/hydration、Signal/form更新、Core-only build、duplicate-package cross-copy smoke成功。
- `pnpm test:browser`: 74/74 passed。Chromium、Firefox、WebKit、production build、React Routerを含む。
- Website独立typecheck: 成功。
- Website静的build: 成功。33ページを生成し、basePath補正を適用。
- Website Chromium smoke: 全route、basePath、404、フォーム/Range、list/control-flow/shared state、Managed Transform、consoleを確認して成功。
- `node scripts/check-size.mjs --exact`: `index-full` 25,343 B gzip。唯一の失敗は既存budget 24,704 B超過。
- `git diff --check`: 成功。

## GitHub Actions

最終実装commitをpush後、Test、E2E、Website CIの各workflow結果を確認して追記する。未完了のrunは成功扱いにしない。

## 次に必要な作業

1. 現在必要な修正を維持したまま、`index-full`から少なくとも639 B gzipを削減できる候補をprofileする。`useComputed` Fast Refresh、Deep Signal最終unsubscribe cleanup、radio/checkbox option安定性を外す案は採らない。
2. その後、Test、E2E、Website CIの最終commit結果でreadinessを再評価する。
3. size gateを満たすまではv0.3.0を**NOT READY**として扱う。
