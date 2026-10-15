# M13 — v0.3.0 release readiness review

## 対象と範囲

- 監査開始時の `main` / `origin/main`: `6888bdae64effdd102ac8539806c0fb8eeb24309`
- M13のドキュメント・consumer assertion commit: `58ca8ed4f0cedc3bc9c59097ee92f1f8e4335e2d`
- 比較対象: v0.2.1 baseline `58f01b9314a1b09b88b162c57912ff736201e790`
- Runtime公開entry、生成型、transform package、migration/docs、pack/install consumer、React 19、SSR/browser、cross-copy/mixed-version、performance記録、bundle budgetsを確認した。
- Runtime/transformの実装を変更する重大な不具合はこの監査では見つからなかった。M13で行ったコード変更はpackage descriptionとpack consumer assertionsだけ。

## v0.2.1からの変更とmigration

- `deepSignal`はsame-realmのMap/Set/WeakMap/WeakSetを既定でreactiveにする。旧 `collections` optionとread-only collection viewは削除。raw collectionや`.peek()`を通すmutationは通知しない。
- JSXの暗黙 `value={signal}` / `checked={signal}` は廃止。明示 `bindValue` / `bindChecked` がDOM bindingを所有し、React controlled propsは引き続き通常どおり使える。型はwritable `FormBindableSignal<T>`を区別し、readonly computedを拒否する。
- managed transformは関数全体の `try/finally` trackingからtop-level `useSignalCapture()` とper-read captureへ変更された。`.value`を含む静的に証明可能な同期read向けであり、destructuring後のdeep proxy read、destructured signal accessor、opaque callback、dynamic alias/keyの一部には移行が必要。明示 `useSignalTracking()` はmanaged出力でも保持される。
- `mode`は関数の選択、`transform`はcapture方式を選ぶ。`mode: "all"`でもすべてのJSX callbackの実行時期を保証しない。migration guideは差と移行手順を説明する。
- Writable computed、明示form binding、single/multiple select、radio/checkbox group、reset、IME、React event順序の現行契約は[v0.3 migration guide](../../docs/migration/v0.3.md)に集約されている。`useDeepSignalValue`のobject snapshotは見送り済み。
- managed transformとruntimeは同じ0.3.x release lineを使う。v0.1.1からの旧migration guideは歴史資料として明示した。

## Public API・型

Root、`/runtime`、`/utils`、`/jsx-runtime`、`/jsx-dev-runtime`のexportsと生成`.d.ts`、JSX型テスト、consumer TS fixtureを確認した。独立したpublic-types auditではentry point間のexport/type mismatchや公開型から内部moduleへの不適切な依存は確認されなかった。型checkとpack後のconsumer型解決も成功した。

## Package・tarball・consumer

- Runtime `react-fine-grained-signals@0.3.0`: ESM-only、Node `>=22.0.0`、React peer `>=19.0.0`、`alien-signals@3.2.1` runtime dependency、`sideEffects: false`。
- Transform `unplugin-react-fine-grained-signals@0.3.0`: ESM-only、runtime peer、Babel 8が宣言するNode `^22.18.0 || >=24.11.0`。runtimeより狭いengine rangeはtransformのBabel依存による。
- 実際のtarballを作成し、独立consumerへinstallして公開exports、TS/JSX、Vite plugin build、React 19動作、cross-copy smokeを検証した。pack後 `workspace:^` は `^0.3.0` に書き換わる。両packageのLICENSE noticeが含まれ、runtimeにはalien-signals noticeが含まれ、standalone `src` directoryに依存しない。runtime JS sourcemapsとsourcesContentはtarballに含まれる。
- M13でconsumer smokeへpeer version rewrite、license notice、source directory不在のassertionを追加した。

## Qualification

| Gate | 結果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass、既存warningあり |
| `pnpm build` | runtime、transform build smokeともpass |
| `pnpm test:consumer` | pass。実tarballを独立consumerへinstallして検証 |
| Cross-copy | consumer smoke内3-copy interop、および `pnpm test:phase4-duplicate` pass |
| Mixed-version | `pnpm test:mixed-version` pass。0.1.1とのsignal reactivityはunsupportedとsmokeが明示 |
| Bundle size | 7 budgetすべてpass: signal-only 7.18 kB gzip、core 7.23 kB、core+hooks 9.05 kB、deep 13.96 kB、index-full 21.51 kB、jsx-runtime 13.62 kB、utils 8.73 kB |
| Runtime coverage | Full runは620件中619件成功。`tests/concurrent.test.tsx`のfan-out testが通常5秒timeoutを5.419秒で超過。対象file単独では7/7 pass。thresholdは変更せず、coverage gateをpassとは扱わない |
| Transform coverage | Full runは408件中405件成功。esbuild adapter 3件が各5秒timeout。該当3件の単独実行は3/3 pass。threshold/timeoutは変更していない |
| Browser E2E | `pnpm test:browser`は71件中70件成功。Firefox hydration初回navigationのみcold Vite start中にtimeoutし、同じtestのFirefox単独実行は1/1 pass（58.4秒）。Chromium、WebKit、production bundle、React Routerはpass |
| Fast Refresh | M13で再実行を開始したがhost crashでsessionが失われ、今回の実行結果はない。前回のM9/M12 qualification記録ではRFSG managed Oxc/inject/Babel supported casesがpass。ordinary try/finally / Preact Oxcの既知signature制約は[以前の記録](./m9-api-performance-development.ja.md)にある |
| GitHub Actions | `58ca8ed4f0cedc3bc9c59097ee92f1f8e4335e2d`でTest (`38662092010`) / E2E (`38662092091`)がsuccess。Test jobの全step（coverage、sizeを含む）とE2E browser / React Router typecheckが完了 |

coverageのaggregate timeoutは前回M12.1のesbuild full-suite timeoutと一致し、該当テストは単独で通過した。ただしこれはlocal全体coverage gateの成功を意味しない。1-worker full coverage診断はworker memoryが約800 MBへ増え、host crash後の環境を保護するためsummary前に停止した。

### Performance・memory上の制約

- M12/M12.1のsame-condition profileではcomputed create/readのraw `alien-signals`との差が大きい一方、RFSG public/internal分布は重なり、単一の比較値からwrapperの支配性は結論できない。writable workloadはread-onlyのraw adapterから除外し、全checksumを検証済み。M13ではruntime性能変更をしていない。
- collection sweep / heap測定のばらつきは既存記録どおり。heap deltaはallocation量やleakの証明にしない。JSDOM最終unmount host survivorはretainer path未特定で、RFSG固有leakとは確定していない。
- radio group attach時native peer確認は通常小規模group向けで、同一groupの初回mount合計がO(N²)となり得る。signal update hot pathではpeer rescanしない。

## 判定とrelease blockers

**READY WITH KNOWN LIMITATIONS — M8を再freezeする。**

重大な再現性あるruntime、型、package、consumer互換性の不具合は見つからなかった。localでtimeoutしたcoverageの4 testとFirefox hydration testは単独実行で通過し、同一candidateのGitHub Test/E2Eもsuccess。CIではfull coverageとmulti-browser E2Eを完了した。local並列実行のtimeoutは既知の負荷制約として残すが、release blockerではない。

既知の制約はmanaged trackingの静的capture boundaryとinject modeのbest-effort性、unsupported cross-generation signal reactivity、computed性能比較の限定性、JSDOM memory attribution未確定、local full coverage/browser suiteのworker-load timeout。いずれもmigration/docsまたは過去の記録で説明される。**Release blockers: なし。**

M8 freezeはpackage version `0.3.0`、M13 candidate `58ca8ed4f0cedc3bc9c59097ee92f1f8e4335e2d`で再開放後に再freezeした。監査記録・ロードマップを追加したfinal main SHAはGit履歴で確認する。

## 未実施の公開手順

公開前にはrelease notes/version/dateの最終確定、承認済み公開時点でのpackage publish workflow、公開物のinstall確認が別途必要。今回npm publish、tag作成/push、GitHub Release作成、version更新は行っていない。
