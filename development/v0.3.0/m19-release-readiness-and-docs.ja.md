# M19 — v0.3.0 Release Readiness & Documentation Refresh

## 判定

**READY WITH KNOWN LIMITATIONS** — 現時点で再現可能な重大release blockerは確認できなかった。既知の制約を利用者向けドキュメントに明記した。これは公開操作またはrelease freezeの承認ではない。

## 基準と公開状態

- 作業開始HEAD: `83ae3879cba5a7d31708a34803600714f7a1bf26`。
- 製品package version: runtime / unpluginともrepository上は`0.3.0`。
- npm公開版: 2026-10-19に`pnpm view`でruntime / unpluginとも`0.2.1`を確認。
- `v0.2.1` baseline tag: `58f01b9314a1b09b88b162c57912ff736201e790`。
- M19では製品コード、versionを変更せず、npm publish、tag、GitHub Release、Pages deploy、release freezeを実施していない。

## ドキュメント更新

- 英日READMEにnpm公開版と未公開repository版の違い、Node / React条件、ESMとTypeScript resolution、React標準 / Full / Lite JSXの選択を追加。
- install例は現在のnpm版`0.2.1`へ固定。pluginも同じ公開版runtimeと組み合わせる説明を追加。
- 英日migration guideにFull/Liteの任意性、Hook dependency契約、Managed Transformのfunction selectionとread captureの差、ambient trackingとlexical boundaryの違いを補足。
- 日本語JSX binding guideとwebsiteで、Signalをchildrenに含む`option`は表示ラベルとして更新できるが、`value`は安定して明示する必要があると揃えた。
- Website Installation / Migration / React Hooks / Managed Transform / JSX Direct Bindingを更新。READMEはCoreとHookだけならcustom JSX runtime / pluginは不要であることを説明。
- `docs/releases/v0.3.0.md`に未公開draftを作成し、Highlights / Added / Changed / Fixed / Performance / Known limitations / migration guideを記載。測定値は対象Consumerの結果として表現し、公開日やRelease URLは記載しない。
- `docs/README.md` / `.ja.md`からrelease notesへリンク。
- 日本語`docs/`を正本、英語websiteを独立して移設・build可能なサイト固有コンテンツとして運用し、複製更新が必要な箇所を今回英日で照合。

## v0.2.1からの重要な公開契約差分

1. React 19向け、ESM-onlyのpackage。runtimeはNode.js `>=22.0.0`、transform pluginはBabel 8により`^22.18.0 || >=24.11.0`。
2. Full JSX Runtimeがhost Signal children、文書化されたattribute/style、明示form bindingを提供。Lite (`/lite`) はSignal childrenのみを追加サポートし、direct bindingを含まないopt-in。
3. Managed Transformは旧function全体の`try/finally`収集から、top-level capture Hookと静的に証明できる同期readのper-read captureへ移行。module外helper本体や遅延callbackを無条件には追跡しない。
4. `useComputed`は省略dependenciesで初期getter closureを保持し、props/state捕捉時は明示dependenciesが必要。`useSignalEffect`では省略と`[]`が同義。`useDeepSignalValue`は省略時に初期selector closureを保持。mode / 長さの不正な変更は明示エラーになる。
5. Form bindingは明示`bindValue` / `bindChecked`で、`number`と`range`もstring Signal契約。native constraintによるDOM補正はSignal値を自動変換・正規化しない。
6. 異なる0.3.x package copy間のreadable interoperabilityを支援する一方、cross-copy batchはcopyごとであり単一atomic transactionではない。0.1.x世代とのSignal reactivity混在は非対応。

既存の英日移行ガイドを現行公開型・実装と再照合した。各契約の詳細は[移行ガイド](../../docs/migration/v0.3.md)と[日本語版](../../docs/migration/v0.3.ja.md)を参照。

## 検証結果

### ローカルで実施

| 検証 | 結果 |
| --- | --- |
| `pnpm lint` | exit 0。既存warningあり。 |
| `pnpm typecheck` | runtime / transformとも成功。 |
| `pnpm build` | runtime / transform build成功。 |
| `pnpm test` | runtime 44 files / 942 tests成功。transform 8 files / 728 tests成功。esbuild adapterの3 testsはそれぞれ5,000ms上限を超過してtimeout。 |
| `pnpm size` | 全budgetとstructural guard成功。`index-full` gzip 24,673 B / budget 24,704 B。Lite child gzip 7,119 B / budget 7,552 B。exact出力は`node scripts/check-size.mjs --exact`で取得。 |
| `pnpm test:consumer` | packed runtime/plugin install、exports/型、Vite build、SSR/hydration、Signal/form update、Core-only、cross-copy smoke成功。 |
| Website independent install | `website/scripts/pack-local-rfsg.mjs`で作成した0.3.0 tarballをwebsiteの独立lockfile環境にinstall成功。 |
| Website typecheck / build | 成功。Vocs `full-static`生成と`/react-fine-grained-signals/` base path、13 skip links補正を確認。 |
| Website Chromium smoke | 全route、CSS/favicon、404、`.nojekyll`、base path、Counter / Computed / Deep Signal / Collections / Form / Range / For / Index / Switch / shared state / direct binding / Managed Transformの操作成功。hydration mismatch・console warning/error・failed requestなし。 |
| Markdown relative links | fenced code / inline codeを除いた19 Markdown filesの相対targetすべて存在。 |

Website production buildにはVocs playground等の1MB超chunk warningが出る。今回の範囲ではドキュメントサイトの全体初回通信量の再最適化は行わず、runtime bundle予算とは分離した既知のサイト重量として扱う。

### GitHub Actions

開始HEAD `83ae387`に対する既存のGitHub Actions Test `39249334200`、E2E `39249334447`、Website CI `39249334279`はすべて成功。M19はドキュメントのみの更新だが、commit後のworkflowも追跡し、最終記録へ追記する。

### Test timeoutの扱い

ローカルのtransform testでesbuildの3つの実build testが各5秒上限を超過した。残る728 transform testsは成功した。開始HEADと同一製品コードのGitHub Test / E2Eは成功し、websiteのVite/Vocs buildとConsumer smokeも成功している。製品コード変更はないため、ローカルtimeoutを再現性のある機能失敗とは判定せず、環境上の検証差として開示する。commit後のTest workflowが失敗した場合は判定を更新する。

## Release blockers

- 再現可能な重大runtime / 型 / package / SSR・hydration / docs blocker: **なし**。
- ローカルのesbuild test timeoutはCI成功および実website buildに照らし、単独ではblocking defectの証拠ではない。
- 現npm版が0.2.1であることは未公開v0.3.0を誤って案内しないようREADMEに明記。

## Known limitations

- Managed Transformは静的に証明できる同期readを対象とし、import helper本体からcallerを自動選択しない。`mode: "auto"`でhelperだけにreadが隠れたcallerは対象にならない。
- `useSignalTracking()`および`transform: "inject"`はbest-effort ambient boundary。厳密な同期lexical scopeには`useManagedSignals()`と`try/finally`を使用する。
- Liteはdirect host attribute/style/form bindingに対応しない。Fullが同じeager chunkに含まれるConsumerでLite単体時のbyte削減を保証しない。
- range / number bindingはstring Signalとnative DOM constraint semanticsを維持する。範囲外やstep不一致値はブラウザー表示値が補正されてもSignal側を自動正規化しない。
- 0.1.xと0.3.x間のSignal reactivityは非対応。cross-copy batchも複数package copyをまたぐ単一atomic batchではない。
- React 19以外をサポート対象としない。transform pluginはruntimeより高いNode.js最小versionを要求する。
- Websiteのproduction outputには大きなPlayground/code-language chunkが含まれる。M18.2のpage-specific transfer調査を超える新たな最適化調査は今回実施していない。
- `pnpm test`のローカルtransform内esbuild 3件はホスト上5秒timeout。最新CI再確認が必要。

これらは既知の利用・環境条件として公開ドキュメントに明記されており、今回の判定ではrelease blockerとしない。

## 公開前の残作業

公開操作へ進む前に、承認されたrelease runで以下を実施する。

1. npm上の最新版・公開状態を再確認し、runtime/plugin間のバージョン整合を確認する。
2. release candidate commitから両packageのtarballを再生成し、独立したclean consumerへinstallしてexports・型・SSR・transformを確認する。
3. 公開を明示承認された後にのみversion metadata、tag、npm publish、GitHub Releaseを行い、publish後にregistry install smokeを行う。
4. Pages workflowは今回実行せず、公開判断後に別途明示操作する。

これらは公開手順であって、今回のcommitでは実行していない。
