# M16 — Consumer Canary & Integration Audit

開始main HEAD: `896da9c9e60ae53e7639b11adf8824aee54c983a`  
対象version: `0.3.0`。publish、tag、GitHub Releaseは行わない。

## 検証環境とfixture

既存の`tests/consumer-smoke.mjs`を拡張した。毎回runtimeとunpluginを`pnpm pack`し、tarballを一時consumerへinstallしてから実行する。Vite consumerはReact 19.2.8 / React DOM 19.2.8、Vite 8.2.2、`@vitejs/plugin-react` 6.1.2、`oxc-transform-react` 0.152.0を使い、RFSGのmanaged transform、custom JSX runtime、React Compilerを同じbuildに組み合わせる。出力にmanaged captureと`react/compiler-runtime`が残ることも確認する。

packed bundleからReact SSR markupを生成し、JSDOMでStrictMode hydrationを行う。hydration後に次をひとつのtreeで操作する。

- signal / computed / writable computed
- `deepSignal`のnested destructuring、deep update、root replacement
- Reactive Map / Setの追加・更新・削除
- 同じSignalを読むmemoized childと、Signalを読まないmemoized sibling
- synchronous local helper、React stateとの併用
- native child / `title`・`data-*` prop binding
- text / checkbox / radio / single-select binding
- conditional mount/unmountと、unmount後のSignal write

これにより、package export mapとdeclaration解決だけでなく、pack済みtarballからロードされたruntime/pluginのSSR・hydration・更新を検証した。共有Signalの更新では親に必要なmanaged rerenderを許しつつ、関係しないmemoized siblingのcommit数が増えないことを確認する。

実ブラウザは既存のPlaywright suiteを再利用し、Vite browser exampleのSSR/hydration、form groups、single/multiple select、reset、React synthetic input/change、IME、StrictMode cleanup、Activity/Suspense、production build、React Router SSRをChromium/Firefox/WebKitで検証した。packed consumerのJSDOM経路と役割を重複させず、browser fixtureは追加していない。Fast Refreshは既存の専用real-browser harnessを再実行した。

## 問題と判断

製品runtime/pluginの正確性不具合は再現しなかった。初回canaryでは、Node 24の読み取り専用`navigator` globalへ`Object.assign`するtest harness側の問題が発生した。global descriptorを退避・復元する方式へ変更した。また、nested propertyを読む親componentにもrerenderが必要なケースがあるため、再描画判定を関係のないmemoized siblingのcommitに限定した。いずれも製品コードの変更ではない。

| 分類 | 監査結果 |
|---|---|
| 正確性の不具合 | この統合シナリオでは未検出。deep update/replacement、collection update/delete、form binding、SSR/hydration後更新、unmount後writeはすべて最新値を保った。 |
| API usability | ViteでReact Compilerを有効にする場合、plugin-reactに加えて`oxc-transform-react`の導入が必要。fixtureで実際にinstall/buildし、設定順とcustom JSX runtimeの組み合わせを確認した。runtime/pluginの別package構成とmanaged modeは既存READMEに説明があり、ユーザー向け契約の追加修正は不要と判断。 |
| 意図的な制約 | `auto`選択とmanaged captureは静的に特定できる同期readが対象。import先helperのbodyは自動選択のために解析しない。JSX render props / children callbackなど呼び出し時点が不明なcallbackは自動captureを保証しない。必要な場合は明示的tracking Hook/value Hookか、component化を選ぶ。現在の英日ガイドとplugin READMEに制約・diagnosticsが記載されている。 |

通常のconsumer操作で遅延は見られなかったため、追加profileは取得していない。極端なstress値を一般アプリ性能の根拠には使わない。

## Qualification

| 検証 | 結果 |
|---|---|
| Packed consumer smoke | pass。tarball pack/install、consumer typecheck、Vite + React Compiler build、SSR/StrictMode hydration、共有Signal・deep destructuring・Map/Set・form binding操作、core-only bundle、3-copy runtime smoke。 |
| Runtime / transform typecheck | pass (`pnpm typecheck`) |
| Lint | pass。既存warningのみ。初回canaryのrender-phase ref instrumentationはlintで検出されたため、commit後effectによる観測へ変更した。 |
| Build | pass (`pnpm build`) |
| Bundle budgets | pass。7 entry全て予算内。runtime/package sourceは未変更で、packed consumer fixtureのcompiler依存はdevDependencyのみ。 |
| Browser E2E | pass: 71/71、Chromium/Firefox/WebKit、production build、React Router SSR。 |
| Fast Refresh | pass: 6 variant、18 supported scenario。managed Oxc 4/4、managed Babel 4/4を含む。既知のfailure 6件は通常React `try/finally` Oxc controlとPreact Oxc controlに限定され、RFSG経路ではない。 |
| Cross-copy | pass。consumer smokeで3個のruntime copyを使ったbatch/interoperability検証。 |
| GitHub Test | pass: [run 38719386261](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38719386261) (`73438a31e8a52b7f7cd91a7b057850cde46743b4`) |
| GitHub E2E | pass: [run 38719386105](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38719386105) (`73438a31e8a52b7f7cd91a7b057850cde46743b4`) |

## M16.1 — Packed consumer assertion closure

開始main HEAD: `8ac89d4825431ae862db88611473b05f472fb13f`。既存のpacked Vite consumer smokeを拡張し、Runtime/Transformの変更や新しいテスト環境は追加していない。

- Text input: native input `"consumer"`でDOMと`canaryState.text.value`が一致。Signalを`"direct-text"`へ直接変更するとDOMも更新。writable computedが拒否する長文`"input longer than twelve"`はSignalを変えず、非同期補正後のDOMも`"direct-text"`へ戻る。
- Checkbox: click後は`checked.value === true`、Signalを`false`へ変えるとDOMのcheckedもfalse。
- Radio: second選択後は`radio.value === "second"`、Signalを`"first"`へ変えるとfirstが選択される。
- Select: change後は`selected.value === "two"`、Signalを`"one"`へ変えるとDOMもoneになる。
- 共有countの複合更新後、helperは`2`、`data-active`は`true`。その後の単独count更新ではcount/computed/child/helperが`3`/`6`/`3`/`3`へ更新し、無関係なmemoized siblingのcommit数は変化しない。
- Conditional componentをunmount後に再mountし、DOM nodeが新しくなり値`3`を表示することを確認。再mount後の単独count更新で表示とhelperが`4`へ更新し、無関係なsiblingのcommit数は維持される。

`pnpm test:consumer`はpass。runtimeとpluginのtarball pack、temporary consumer install/typecheck、Vite + Compiler build、packed SSR/StrictMode hydration、上記DOM操作、core-only bundle、3-copy runtime smokeまで完了した。初回sandbox実行はpnpm store operation lockの権限で開始できなかったため、同じコマンドを昇格実行して完了した。検査失敗や製品コードの不具合はなく、Runtime/Transform変更なし。commit `86d6bc7a9bc7cbd73a267f0950713045cffaaf53`の[GitHub Test](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38738193370)と[E2E](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38738193375)もsuccess。

### 結果と次の判断

M16/M16.1 consumer canaryでは、release blockerとなる再現可能な不具合は見つからなかった。既存の制約は診断可能なmanaged tracking契約として残し、API再設計は行わない。v0.3.0は未公開のまま維持する。M8のfreeze判断を変更する新しい証拠はなく、M16とM16.1対象SHAのGitHub Test/E2Eはいずれも成功した。
