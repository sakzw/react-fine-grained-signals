# M15 — Managed Tracking Coverage Expansion

開始baseline: `5c5a78decc6f7f4682e5a1fe8fe6ad4289b65b32` (`main`、2026-10-15)。

M14で採用したlazy interop protocolを維持したまま、managed transformが安全に自動追跡できるJavaScript patternを拡張した。package version、runtime API、coverage threshold、bundle budgetは変更していない。

## M15.1 現行契約の確認

既存のalias解析は、`const user = state.value.user`のようなidentifier declaratorをtracked aliasへ登録し、`user.name`を後続のcapture対象にできる。単純aliasの連鎖、`.value`の静的property path、optional/dynamic member、選択済み関数内で同期実行されるlocal helper/callbackは既存の解析・実行テストで扱われる。ここは再実装しなかった。

未対応だったのは`ObjectPattern`で取得したbindingである。`const { user } = state.value`の初期captureは`.value`までで、property `user`の取得と後続の`user.name`がalias解析へ伝わらず、deep property writeやobject replacement後にUIがstaleになり得た。古いwarningテストと新しいReact DOM regressionで差を確認した。

## M15.2 追加したsubsetと変換方式

次のすべてを満たすblock-body `const` destructuringだけを展開する。

- tracked readを含む同期initializer
- 単純なobject pattern。全property keyが非computedのstatic identifier
- 各propertyのbindingが単一identifier
- `const` bindingであり、再代入がない
- nested/default/rest/assignment patternおよびpattern-level・binding-level TS annotationがない

例:

```tsx
const { user } = state.value;
return <p>{user.name}</p>;
```

initializerを一時bindingへ一度だけ評価し、その後の各静的property accessを通常のmember expressionとして表す。既存capture passが`state.value`と`source.user`を個別captureし、alias passが後続の`user.name`を捕捉する。property getterは元のdestructuringと同じ順序で一度だけ呼ばれる。生成Hookの位置・数・順序は変えない。実行テストでsource getterとproperty getterが各1回であることを検証した。

次の形は展開せず、tracked sourceを静的に確認できる場合は従来の位置付きdiagnosticを維持する。

- nested object/array pattern、computed key、default、rest
- `let`/`var`、再代入されるbinding、destructuring assignment
- signal accessor自体のdestructuring（`const { value } = signal`）
- TypeScript annotation付きpattern/binding

initializerを複製したり、computed key/defaultの副作用順序を変えたりする変換は行わない。既存のReact Hooks diagnosticと未知callback timing diagnosticの判定規則は変えていない。対応済みpatternにはdestructuring warningを出さない。

## M15.3 Alias / callback境界

展開後のmember readは既存のBabel binding解析へ入るため、追跡済みaliasを介する複数段const aliasとstatic nested property readへつながる。dynamic keyは、関数が別の静的read/opt-inで選択されていれば既存のruntime-key capture対象になる。JSX render prop、children callback、async/escaped callbackのcapture scopeは拡張していない。実行タイミングを証明できないcallbackへrender captureを漏らさない。

`mode: "auto"` / `"manual"` / `"all"`の関数選択契約、および`transform: "inject"`のambient runtime boundaryは変更していない。明示的な`useSignalTracking()`、`useSignalValue()`、`useDeepSignalValue()`を使う選択肢も維持した。

## React動作と意味論

- 実際のReact render regressionで、`state.value.user.name`のdeep writeと`state.value.user`置換の両方がDOMへ反映されることを確認。
- 実行されたinitializer / property getterの呼び出し回数を各1回と確認。
- Transform、React execution、React concurrent capture focused suites: **317/317 passed**。
- Hook挿入は既存top-level `useSignalCapture()`だけで、展開部分にHookを生成しない。
- React Compiler suite: **27/27 passed**。
- 実browser Fast Refresh harness: RFSG managed Oxc/Babelの全18 scenario passed。ordinary React try/finally OxcおよびPreact Oxcの6 control scenarioは既知のRefresh signature問題を再現し、RFSG実装の失敗ではない。
- CI serial Browser E2E: **71/71 passed in 8.4m** after the final transform changes (Chromium、Firefox、WebKit、production bundle、React Router)。SSR/hydration、StrictMode、Suspense、実DOM更新を含む。

## Performance / bundle

既存`benchmarks/transform.mjs`をNode `v24.21.0`、Windows x64、AMD Ryzen 7 PRO 6850Uで実行。100 small / 5 large modules、warmup 1、sample 3の短いmanual comparisonをbaselineとcandidateで行った。`m15-transform-baseline.txt`と`m15-transform-candidate.txt`にraw tableを保存。

| Case | M14 baseline median ms/module | M15 candidate median ms/module |
| --- | ---: | ---: |
| small auto / no candidate | 8.875 | 6.033 |
| small auto / inject | 10.743 | 6.049 |
| small auto / managed | 11.303 | 7.499 |
| large auto / no candidate | 328.760 | 199.596 |
| large auto / inject | 444.365 | 245.405 |
| large auto / managed | 748.913 | 905.261 |

sample数が3回のみでhost/load variationも大きいため、短縮率は主張しない。特にlarge managedのsampleは430–1,194 ms/moduleと幅があり、medianがbaselineより高い一方、分布は重なっている。一般コードへの影響を確定するには追加profileが必要であり、M15ではdestructuringを含まないfixtureの出力byte数がsmall managed 305 bytes、large managed 25,830 bytesで不変だった。対応patternでは一時bindingとcapture expression分だけ生成コードが増える。

transform package buildではbaseline `unplugin` chunkが121.52 kB / 32.99 kB gzip、final candidateが125.11 kB / 33.83 kB gzip（+3.59 kB raw、+0.84 kB gzip）。bundleの追加はtransform解析・出力コードであり、runtime entryやruntime bundleへの追加はない。runtime coreは46.58 kB / 10.12 kB gzipで、M14値から変化なし。全size budgetはqualificationで再確認する。

## M16 — JSDOM host retention再確認

[短いGC診断script](m16-jsdom-host-retention-recheck.mjs)を保存した。M14 baseline snapshotでNode `v24.21.0`、React/react-dom `19.3.0`、JSDOM `30.1.2`を使用し、React plain input、RFSG bound input、React multiple-select、RFSG bound multiple-selectを各12 mount/unmount cycleで比較。各条件6回のforced GC/event-loop pass後、すべて **12/12 host collected、survivor 0**。独立subagentのVitest 5.0.3 minimal-config + JSDOM recheckも、plain React/RFSG各8件でsurvivor 0。

この再現条件では過去の最後のhost retentionを再現できず、heap snapshot/retainer pathは得られなかった。歴史的Vitest fixture固有のsetup/cleanupが未再現要因として残る。RFSG固有のretention証拠がないためruntime変更はしていない。

## Qualification / M8

- Runtime full coverage: **621/621 passed**。Statements 94.13%、Branches 90.30%、Functions 97.52%、Lines 95.91%。
- Transform full coverage: **417/417 passed** (Statements 92.84%、Branches 90.31%、Functions 97.44%、Lines 95.56%)。最終追加したTypeScript annotation diagnostic testもfocusedで**1/1 passed**。最初の集約試行ではesbuildの既存5秒timeoutが1件発生したが単独では5.33秒で成功。`--isolate=false`ではConcurrent mock scheduler 2件が失敗したため採用せず、suite isolationを保って1 workerで全件通過した。その後の再試行はhost load時にReact execution workerが起動せず、thread poolはNode exit -1073741819で終了したため、passとして数えていない。test timeout/thresholdは変更していない。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` passed。lintは既存warningを出すがexit 0。
- Consumer pack/install/Vite smoke、3-copy duplicate runtime smoke、mixed-version smoke passed。
- React Compiler **27/27**、final CI serial multi-browser E2E **71/71** passed in 8.4m。
- 全7 bundle budgets passed。runtime core 46.58 kB / 10.12 kB gzip、transform plugin 125.11 kB / 33.83 kB gzip。M14比transform pluginは+3.59 kB raw / +0.84 kB gzip、runtime bundle差分なし。
- Transform benchmarkはbaselineとcandidateの双方で実施。小sampleの測定ノイズがあるため速度向上は主張しない。no-destructuring fixtureの生成サイズは不変。
- Fast RefreshはRFSG managed Oxc/Babelで18/18 passed。6 control failureは通常Reactのtry/finally OxcとPreact Oxcに限定された既知のHook signature問題。
- M16 JSDOM再調査ではplain ReactとRFSGのinput/select hostすべてGCされ、RFSG固有retainerは未確認。製品変更なし。
- `git diff --check` passed。実装commit `696a16ac41c47a245075fe0dfacc2a8f4fd7dc45` のGitHub [Test run 38683023129](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38683023129) と [E2E run 38683023223](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38683023223) は両方success。Testはcoverageを含む全job、E2EはReact Router typecheckとbrowser suiteを通過した。

以上によりM8をM15 candidateで再freezeする。対象patternは安全性を証明できる単純なstatic `const` object destructuringに限定し、未対応構文は変換しない。npm publish、release tag、GitHub Releaseは作成しない。
