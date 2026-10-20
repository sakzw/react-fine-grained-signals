# M19.2 — Opus Findings Final Closure

開始HEAD: `8f6d6878c208280d39e85d8408e1f1e45279ad92`

## 判定

LOW-5、LOW-8/9を再現条件どおり修正し、Lint、Transform branch coverage、実Vite Fast Refreshの取りこぼしを閉じた。既存のMEDIUM-1、LOW-1〜4、LOW-6/7の修正も維持した。

Opusレビュー11件は修正・確認を完了した。開始HEADの`index-full` gzipは25,102 Bで、当時の予算24,704 Bを398 B超えていた。最終実装は25,343 Bとなり、開始HEADから241 B増、旧予算から639 B超過した。ユーザー承認に基づき、既知の正確性修正を維持するため`index-full` gzip予算だけを26,624 Bへ更新した。この値は25,343 Bへ既存方針の5% headroomを加え、64 B単位で切り上げたもの。その他scenarioの予算は変更していない。

ローカル最終検証はすべて成功した。release readinessの確定は、変更をpushした最終commitに対するGitHub Actions Test、E2E、Website CIの結果確認後に行う。v0.3.0はnpm未公開であり、version・公開操作・tag・GitHub Release・Pages deploy・release freezeは行っていない。

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
| Bundle size | **RESOLVED** | ユーザー承認により`index-full` gzip予算を26,624 Bへ更新。測定値25,343 Bに既存方針の5% headroomを確保。その他scenario予算は不変。 |

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
| `index-full` | 98,948 B | 25,343 B | 22,386 B | 予算26,624 B以内 |
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
- `node scripts/check-size.mjs --exact`: `index-full` 25,343 B gzip / 26,624 B。全scenarioのbudgetとstructural guard成功。
- `git diff --check`: 成功。

## GitHub Actions

最終実装commit `680c73c5ff1485a6e78c61775c90e705a40b7957`のrun:

- [E2E #39351699522](https://github.com/sakzw/react-fine-grained-signals/actions/runs/39351699522): **success**。
- [Website CI #39351699523](https://github.com/sakzw/react-fine-grained-signals/actions/runs/39351699523): **success**。
- [Test #39351699560](https://github.com/sakzw/react-fine-grained-signals/actions/runs/39351699560): **failure**。Lint、typecheck、coverage、buildは成功し、`scripts/check-size.mjs`が`index-full`の予算超過で失敗した。workflowはこの後のConsumer/mixed-version smokeへ進まなかった。Consumer smokeは同じsourceを使ってローカルで成功済み。

したがってCIでも残るblockerは`index-full` gzip budgetのみ。E2EとWebsite CIに回帰はない。

## Final bundle gate decision

2026-10-20、ユーザーは`index-full`予算26,624 Bを承認した。25,343 Bからの5% headroomを既存の64 B単位切り上げ規則へ適用した値であり、他のscenario予算は変更していない。639 B超過を解消するための探索では、正確性修正を保ったまま有意に削減できる自然な簡素化は確認できなかった。承認後のローカル最終検証でLint、TypeScript、Coverage、Build、全size scenario、packed Consumer、mixed-version、Browser E2E、Websiteの型検査/build/smokeが成功した。GitHub Actionsの最終commit結果とreadiness確定はpush後に記録する。

公開準備の既存チェックリストは、npmの公開状態・runtime/plugin整合確認、tarballからのclean consumer検証、明示承認後のversion/tag/npm publish/GitHub Release、公開後install smoke、Pages workflowの別途明示実行を列挙しており、未公開状態と整合している。現在npm未公開。実際の公開操作は行っていない。
