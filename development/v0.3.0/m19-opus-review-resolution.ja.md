# M19 — Opus Review Findings Resolution

開始HEAD: `6563fa0ece4d6c026975153acc0869f2c123c081`

## 判定

11件を同一の開始HEADから再現・修正した。MEDIUM-1とLOW-1〜7は**FIXED**、LOW-10はReact Fast Refreshのclosure保持契約による**INTENTIONAL / DOCUMENTED**、LOW-8/9は最終unsubscribe後にmetadataを回収できず**UNRESOLVED**。Deep Signalの候補metadataを依存切替後や後続activity時にbounded sweepする部分改善は入れたが、最終cleanupの保証とは区別する。

さらに現行の`index-full` gzipは25,113 Bで、既存budget 24,704 Bを409 B超える。budgetは変更していない。未解決のcleanupとサイズgateのため、v0.3.0は**NOT READY**と再判定する。npm公開・version変更・tag・Release・Pages deploy・release freezeは行っていない。

## Findings

| Finding | 結果 | 実装・判断 |
|---|---|---|
| MEDIUM-1 RFGS003誤検知 | **FIXED** | `/utils`由来の`Show`/`For`/`Index`/`Match` callbackをimport binding、alias、namespace、custom `importSource`から解決し、library-owned boundaryのみ診断対象外にする。同名ユーザーcomponentと出自不明re-exportは従来どおり保守的に扱う。`diagnostics.errorOn`の正常Consumer buildを含むTransform/Diagnostics testsを追加。 |
| LOW-1 Plugin README矛盾 | **FIXED** | managed modeでの先頭`useSignalTracking()`、`@signalTracking`によるper-read capture、ambient trackingとの差を英日READMEで統一。 |
| LOW-2 公開JSDoc | **FIXED** | `useSignalCapture()`とper-read captureに説明を合わせ、`importSource`/`/runtime`を実際のexportsに一致させた。build済みdeclarationでも確認。 |
| LOW-3 parameter relocation semantics | **FIXED** | 後続parameterを参照する先行default closureなど、安全性を証明できないcaseは移動しない。最小再現とRFGS004 warningを確認し、引数順・parameter listを維持する。 |
| LOW-4 Update/Delete capture | **FIXED** | `count.value++`、`--state.value.count`、`delete state.value.x`など、完全なmutation expressionをcaptureする。postfix/prefix/delete結果とcomputed keyを含むcodegen回帰を追加。Hookをcapture closureへ移さない。 |
| LOW-5 binding ref cache上限 | **FIXED** | 8件でのevictionを固定上限引上げで隠さず、WeakMap trieをbinding sourceとuser ref identityで構成する。9/16/32 sibling、ref callback、subscription、更新、unmount cleanupを確認。 |
| LOW-6 classic Fragment | **FIXED** | Full classic `createElement(Fragment, { children })`のSignal/配列childrenを正規化。variadic childrenの優先、key/props、SSR/hydration、通常componentへのSignal prop非unwrapも検証。 |
| LOW-7 未対応Signal host prop | **FIXED** | Full Runtimeで未対応Signal-valued host propを誤ってDOMへ渡さず、Liteと同種の明確な診断を出す。対応済みbinding、React component props、custom elements等を維持。 |
| LOW-8 Map/Set primitive key metadata | **UNRESOLVED** | bounded sweepで読み捨てmetadataや依存切替後のkeyを回収する部分改善。最後の購読が切れた後、後続read/writeなしでは回収されない。 |
| LOW-9 missing object key metadata | **UNRESOLVED** | 欠損keyのqueued/bounded sweepを追加。missing→present通知や依存切替は維持するが、最後の購読解除だけではsweepを再起動できず、最終key metadataが残る。 |
| LOW-10 omitted-deps `useComputed` Fast Refresh | **INTENTIONAL / DOCUMENTED** | 実Vite HMRでgetter-only/writableの初期closure保持を再現。stateを保持するrefreshではHook stateも保持するため、Fast Refresh時だけ安全にcomputedを再生成するlibrary APIはない。`// @refresh reset`でcomponent remountすると新closureを適用できる代わりにReact stateはresetされる。 |

## LOW-8/9で残る境界

再現テストはreadでsweepをscheduleし、購読中のsweep完了を待ち、その後collection/objectへのread/writeを一切行わずscopeをdisposeする。最後の購読が外れてもDeep Signal adapterへ通知されないため、metadataを回収する契機がない。Coreのlinked subscriber状態はsweep時点では観察できるが、最終unsubscribe callbackをadapterに渡す経路は存在しない。

一度だけのtimer再試行では任意の後続unmountを取りこぼし、pollingは無期限処理になる。安全な回収通知を追加するにはCore graph lifecycle/ownership境界の変更が必要で、今回の最小修正範囲を超える。`it.fails`で両方の具体的な残存ケースを固定し、通常suiteでは期待失敗として可視化した。単なる文書化で完了扱いにはしていない。次はbounded final-unsubscribe hookをCore契約とConcurrent/abandoned renderのpending readに対して設計する必要がある。

## 検証

- Runtime React/JSX/Deep Signal focused: 4 files、170 passed、2 expected-fail regression cases。
- Transform/Diagnostics focused: 2 files、320 passed。
- Full Runtime suite: 44 files、955 passed（修正統合後、JSX共通diagnostic helper追加前）。共通helper後のfocused 170件も成功。
- Full Transform suite: 9 files、736 passed。
- `pnpm typecheck`: runtime + plugin成功。
- `pnpm build`: runtime + plugin成功。Plugin build-smoke成功。
- `pnpm exec oxlint`変更ファイル確認: 新規errorなし。classic `config.children`を直接検証する4箇所は意図を注記してruleを局所抑制。既存warningは残る。
- Browser E2E: Playwright 74/74 passed（Chromium / Firefox / WebKit、production build、React Router含む）。
- Website: 独立`tsc --noEmit`終了コード0。Vocs production build成功、33ページを静的生成し、13 skip linksへbase pathを適用。
- 実Vite 8.3.4 / React 19.3 / Chromium Fast Refresh: omitted-deps getter/writable stale closureを再現。component state保持、StrictMode下の単一effect接続、HMR後更新、unmount cleanup、console errorなしを確認。
- size check: `index-full` gzip 25,102 B / budget 24,704 B（+398 B）。`jsx-runtime`は13,668 Bでそのscenario budget内、その他の既存scenarioもbudget内。サイズ予算は緩和していない。
- `git diff --check`: 成功。

全検証はローカルで完了。GitHub Actions結果はpush後に確認し追記する。サイズ超過を解消できない限りrelease readinessはNOT READY。

## 次に必要な作業

1. Full Runtimeの追加診断/ref/FragmentコードとDeep Signal bounded metadata pruningを含む`index-full` gzip増分を、budgetを変えずに削減する。機能を落とす場合は各findingの正確性を再評価する。
2. 最終unsubscribeを通知するbounded metadata reclamation契約を設計し、commit済みsubscriberとConcurrentの未commit readを区別する。
3. 上記2点を解消後、full runtime/plugin suite、build、typecheck、size、Website CIを同一HEADで再実行してreadinessを改めて判定する。

