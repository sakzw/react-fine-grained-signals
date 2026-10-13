# M3 — React tracking / Fast Refresh audit

## 現状

M3は未完了。M2実装後、React Hook配置の違反とFast RefreshのHook署名欠落を同時に解消する案を調べ始めた。既存のmanaged transformを単純にinjectへ置き換えない。

- `managed` はruntime hookをcomponent先頭に挿入したあと、元のbody全体を生成 `try/finally` に移す。`finish()`は通常return、throw、Suspense throw時に同期実行されるが、ユーザーがbody内で呼ぶHookもtry内になる。
- Reactの[Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)はHooksを`try`、`catch`、`finally`内で呼ぶことを禁じている。
- Vite/OxcのFast Refresh harnessはtry内のHook列についてsignatureを欠落させる再現を持つ。Hook追加・削除・順序変更でHook-order runtime errorが起こる。同じtry形状の通常React componentも再現し、RFSG固有ではない。ただしmanagedがこの構文を生成する責任はRFSGにある。[root cause](../phases/phase10/fast-refresh-root-cause.md)、[harness](../phases/phase10/fast-refresh-harness/README.md)
- `inject`はHooksをbody先頭に残し、現在のVite/Oxc matrixでHook変更を通す。一方、runtimeのscopeは同期的なcomponent-end境界ではなく、managedと同じ正確性・aborted render cleanupを保証しない。
- Reactの[`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)はtop-level Hookとsnapshot subscriptionを提供するが、それ自体は任意のsignal readをcomponent単位で検出しない。store更新時の同期renderやSuspenseに関する制約もある。

## 試作順の判断

Clefは「top-level Hook + per-render-attempt capture」を最初に試作する案を選び、他案より強い選好を返した（clef-flash、A 0.9022、B 0.0463、C 0.0515）。これは候補の試作順への助言で、正確性の証明や採用判断ではない。

| 案 | 利点 | 主な未解決点 |
|---|---|---|
| A. top-level managed Hookとrender-attempt token | Hooksは通常のtop-level配置になり、動的signal/deepSignal readの既存runtime captureを活かせる。試作範囲が小さい | 関数return時の同期境界を失う。untransformed callback、throw/Suspense、複数root、time-slicingで誤帰属しない証明が必要。単なるinject改名に終わる可能性 |
| B. 読み取りごとの静的変換とcomponent-owned React subscription | Hook ownershipを明示でき、Reactのsubscription APIに沿う | 動的・nested read、custom Hook、JSX、parameter default、conditional expressionで網羅性と評価順を保つコストが大きい |
| C. targeted subscriptionへ公開契約を変更 | `useSignalValue`、`useDeepSignalValue`、JSX bindingの既存方式を使える | 現在の全component dynamic readの価値を失い、API/移行の大きな再設計になる。managedの既存契約も処理が必要 |

まずAを独立worktreeでprototypeし、精度を実測する。設計上の判断として、採用前に「次のHook callやmicrotaskで以前のcollectorを閉じる」だけでexactnessを主張してはならない。commitされたattemptだけdependenciesをpromoteすることに加えて、renderされないcallbackや失敗render、root間の帰属を検証する。Aがbest-effortを超える根拠を出せない場合はB/Cの契約を比較し、managed既定を安全と見なしたまま公開準備へ進まない。

## Prototypeのacceptance gate

1. transform後にユーザーHooksがすべてcomponent bodyのtop levelに残り、try/finallyの内側に入らないことをASTとRules-of-Hooks lintで確認する。
2. 既存browser harnessを拡張し、Vite/OxcでHook追加・削除・順序変更後に正しいRefresh state reset/preservationが起きることを確認する。
3. signal/deepSignal read ownershipを隣接sibling、nested tree、render callback、同期throw、Suspense retry、StrictMode、複数root、time-sliced yieldで確認する。
4. abandoned attemptはdurable subscriptionにならず、committed attemptだけが正確にpromoteされ、unmount時にcleanupすることを確認する。
5. SSR/hydrationとReact Compiler enabled/disabledの両方でHook order、stale render、scope leakがないことを確認する。
6. いずれかのケースがexact trackingを裏付けない場合はM3を完了扱いにせず、契約変更案とmigrationを文書化する。

### 次の作業

1. prototype worktreeでrender scopeのambient pointer/restore semanticsと同じtask内のsibling isolationを確認する。
2. `managed`からtry/finallyだけを外した実験transformと、render-attempt token方式を比較する。
3. Fast Refresh harness、Rules-of-Hooks lint、commit/abort/sibling/runtime testsを合わせて実行し、境界の主張を採否する。
