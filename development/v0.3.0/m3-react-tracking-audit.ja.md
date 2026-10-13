# M3 — React tracking / Fast Refresh audit

## 現行方式と状態 (2026-10-13)

旧試作・再開判断の記述はその時点の履歴であり、現在の実装方針ではない。続く試作記録は残すが、managedの既定codegenはtop-level `useSignalCapture()` とread単位captureへ変更した。user Hookをtry/finallyへ移さず、静的に証明できる同期readだけを短いcapture scopeで囲む。generator/async bodyやReact Hookを含むhelperは同期callsite captureへfoldしない。JSX function propや`.value`を含むdestructuring initializerなど、検出できる追跡外readにはsource位置付きwarningを出す。

現行方式の根拠は、transform/runtime executionの対象2 suite 303 tests、runtime 555 tests、TypeScript runtime/plugin成功。React Compiler専用suiteは71 passed / 3 skipped。実browserのFast Refresh harnessは24ケースで18 passed、6 known failure（通常React `try/finally` control 3件とPreact Oxc 3件）を完走し、managed Oxc/BabelはHook追加・削除・並べ替えの全6ケースを通過した。Fast Refresh subgateは完了。複数root/concurrent interleavingとhydrationを含むM3 acceptance gateは未完了。静的に解決できないJSX children callback、import先が返すcallback、複雑なaliasや任意のdeferred callbackは一般に同一file transformで実行ownerを確定できないため、既定managedの完全なexactnessはまだ主張しない。

最新の契約比較に対するClef-flashの補助意見は、bounded implicit capture + diagnostics 0.8996、explicit targeted subscription 0.1004、confidence 0.6386。これは採用判定ではない。既定managedへの統合は維持したが、未追跡readの診断とowner正確性を確認できるまでM3は未完了とする。

## 現状

M3は未完了。M2実装後、React Hook配置の違反とFast RefreshのHook署名欠落を同時に解消する案を調べ始めた。既存のmanaged transformを単純にinjectへ置き換えない。

- `managed` はruntime hookをcomponent先頭に挿入したあと、元のbody全体を生成 `try/finally` に移す。`finish()`は通常return、throw、Suspense throw時に同期実行されるが、ユーザーがbody内で呼ぶHookもtry内になる。
- Reactの[Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)はHooksを`try`、`catch`、`finally`内で呼ぶことを禁じている。
- Vite/OxcのFast Refresh harnessはtry内のHook列についてsignatureを欠落させる再現を持つ。Hook追加・削除・順序変更でHook-order runtime errorが起こる。同じtry形状の通常React componentも再現し、RFSG固有ではない。ただしmanagedがこの構文を生成する責任はRFSGにある。[root cause](../phases/phase10/fast-refresh-root-cause.md)、[harness](../phases/phase10/fast-refresh-harness/README.md)
- `inject`はHooksをbody先頭に残し、現在のVite/Oxc matrixでHook変更を通す。一方、runtimeのscopeは同期的なcomponent-end境界ではなく、managedと同じ正確性・aborted render cleanupを保証しない。
- Reactの[`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)はtop-level Hookとsnapshot subscriptionを提供するが、それ自体は任意のsignal readをcomponent単位で検出しない。store更新時の同期renderやSuspenseに関する制約もある。

## 追跡契約の暫定境界と追加回帰修正 (2026-10-13)

managed captureが自動追跡を保証するのは、同期的なcomponent/custom Hook render中に評価されるreadに限る。同一moduleで解決できる同期helper/render callbackに加え、対象componentがすでにmanaged変換される場合は直接呼び出すnamed/default import helperの同期callもcaptureする。`.value`と、`const key = "value"`のように不変な文字列へ解決できるcomputed keyをreadとして扱う。`current`、`target`、`currentTarget`というproperty名だけを根拠にsignal readを除外しない。実際のsignal以外の`.value`に対するcaptureはdependencyを追加しない。

`key`が実行時に決まる`signal[key]`、import越しreadだけを持つcomponentの`auto`判定、import先が返すcallback、所有componentと別時点で実行されるcallback、一般的なclosure escapeは保証外であり、M3のexactness gateは未達。未検出のsignal readしかないcomponentは`auto`が変換を選べない。これらを従来のambient trackingと同等とは扱わない。明示的なreadが必要な境界では`useSignalValue` / `useDeepSignalValue`等のtargeted APIか、変換対象側でreadを同期的に表現する。

この追跡修正では、ref-like property名を持つobject内のsignal (`holder.value.current.value`)、定数computed key (`signal[valueKey]`)、import helperが同期的に読むsignalを実Reactで更新まで検証する回帰testを追加した。transformとReact executionの2 suiteは303/303通過し、plugin `tsc --noEmit`も成功。別root/concurrent interleaving、import先のdeferred callback、任意callback ownershipの実環境gateは継続。

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

## 試作1の結果（2026-10-13）

独立worktreeで`applyManaged()`の生成`try/finally`を外し、`useManagedSignals()`と元のcomponent bodyを同じ関数bodyの先頭レベルに置く試作を実行した。worktree内でruntime/pluginをbuildし、既存のPlaywright + Vite Fast Refresh harnessを完走した。

- Vite/Oxcのmanaged試作: JSX-onlyとHook追加・削除・並べ替えをすべて通過。Hook署名が更新され、Hook変更時にcomponent stateが安全にresetされた。
- legacy Babel managed: 同じ4シナリオを通過。
- Oxcの通常React `try` controlとPreact control: Hook追加・削除・並べ替えは既知の失敗を再現。
- `inject` control: 4シナリオ通過。
- 合計: 6 variant、18 passed、6 known failures。6件は通常React `try` controlとPreact controlの各Hook変更3ケース。

この結果はmanaged transformがHookをtryの外に置けばFast Refresh署名問題を避けられることを示す。一方で、この試作は`finish()`を同期的に呼ばず、runtimeの`useInsertionEffect`または`queueMicrotask()`による終了に依存する。従って、失敗したrenderから別rootのrenderへ同期的に移った場合や、commit前に走るuntransformed callbackのread帰属を検証しておらず、exact trackingの根拠にはならない。試作コードは本線へ統合しない。

## 試作2の結果（2026-10-13）

試作1を継続し、Hookをcomponent bodyのtop levelに維持したまま、明示的なreturn直前とユーザー記述の`finally`実行後に`finish()`を挿入した。return expressionは一時変数へ先に評価する。AST traversal中にreturnを置換すると試験が停止したため、対象return pathを先に収集してから置換するよう修正した。

- 専用のreturn/finally実行テスト: 1 passed。signal readの通常追跡、ユーザー`finally`のread追跡、Hook順序を検証。
- `react-execution.test.ts`: 49 passed。
- plugin build: success、124.32 kB。
- 既存Fast Refresh harness: 6 variant、18 passed、6 known failures。失敗は通常React `try` controlとPreact controlのHook変更ケース。
- plugin全体test: 175 passed、113 failed、3 skipped、およびworker起動timeout 3件。主な失敗は既存transform/unplugin testが生成`try/finally`を前提にしているためで、この試作に合わせた期待値更新は未実施。従ってsuite全体の合格とは扱わない。

この試作は通常returnとreturnを囲む通常のユーザー`finally`では同期境界を改善したが、同期throw、Suspense、ユーザー`finally`自身のthrowでは`finish()`を保証しない。runtimeのmicrotask cleanupは同期境界ではなく、insertion effectはcommitされるrender attemptに限られる。Reactの[Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)はHookを`try`/`catch`/`finally`内で呼ぶことを禁止し、[Suspense](https://react.dev/reference/react/Suspense)は初回mount前にsuspendしたtreeを破棄して再試行する。このため、試作2もstrict trackingのacceptance gateを満たさず、本線へ統合しない。

現在の設計仮説として、ambient scopeをcomponent全体で開く代わりに、各signal/deepSignal readをrender-attempt tokenへ短く記録する方式を次に試す。read評価だけを`try/finally`で閉じればHook呼び出しを囲わず、例外時の同期cleanupを保てる可能性がある。一方、render callback・custom Hook・nested proxy・評価順序・stale closureまで自動trackingを維持できるかは未証明である。明示的なtargeted subscriptionへ公開契約を変える案も比較対象に残す。

Clef-flashは次の優先調査としてtargeted subscription契約（B）を0.5473、per-read token方式（A）を0.2441、throw時のdeferred cleanup（C）を0.2086と評価した。confidenceは0.1039で低く、採用判断ではなく比較材料として記録する。Aの小さなprototypeで公開APIを維持できる見込みを測り、Bのmigration負担とReact lifecycle適合性を同時に確認する。

## 試作3 — per-read capture runtime / transform（2026-10-13）

既存managed scopeを変えず、runtime subpathに内部試作用`useSignalCapture()`を追加した。Hookはrender attemptを作るがcomponent全体のambient scopeやmicrotask cleanupを開始しない。`capture(fn)`だけが`withRenderScope()`で同期scopeを開閉し、commit時のdependency promote/subscriptionは既存`RenderStore`を再利用する。insertion effect後のstale captureはcallbackを実行してもclosed attemptへ依存を追加しない。

transformにはテスト専用`experimentalCapture`分岐を置き、既定`managed` codegenは変えていない。候補readの最大member chainを包み、`.value` readから識別子aliasへの単純なdata-flowも同じfunction内で追う。method call・call後のproperty read・`new`・tagged templateは式全体を包んでreceiver/constructor意味論を維持する。単純代入・update・delete・destructuring代入・TypeScript assertion付き代入の左辺は書き換えない。inline同期callback内のreadはcallback bodyを、別定義の同期helper/render callbackは静的に解決できる呼び出し式をcaptureし、React Hookを含むhelperはwrapを避ける。既知のdeferred read除外も適用する。

検証結果:

- `tests/use-signals-managed.test.tsx`: 20 passed。shallow/deep read、capture中throw後のscope復元、commit後のstale handleを確認。
- `tests/use-signals-managed.test.tsx`: 22 passed。shallow/deep read、capture中throw後のscope復元、commit後のstale handle、StrictMode replay/update/unmount、SSRを確認。
- plugin `tests/react-execution.test.ts`: 56 passed。top-level Hookとtry不在のcodegen、shallow/deep chain、identifier alias、inline・module-scope同期helper/render callback、auto modeでのmodule/local同期helper検出とcallsite capture、Suspense fallbackとabandoned attemptの分離・retry、optional read、write target、call後property、nested constructor、tagged receiverを確認。
- plugin `tests/transform.test.ts`: 239 passed。既存transform契約の回帰を確認。
- plugin package `tsc --noEmit`: success。
- root runtime `tsc --noEmit` とplugin package `tsc --noEmit`: success。`git diff --check`: success。

独立レビューでは、destructuring代入、`new`、tagged template、call後propertyの意味破壊・漏れが指摘された。pattern親を辿るwrite除外、constructor/tagged式全体、call後member chain、call expressionをcalleeとする`new`を包む修正を入れ、focused assertionsを追加した。最新差分の再レビューで、JSX prop経由の外部callback、destructuring deep read、generator helperの実行時readが未捕捉になる具体例が残った。呼び出し時に実行されないgenerator本体とawait以降を同期callsiteのcaptureへfoldしないガードを追加した。JSX function propの静的callbackとdestructuring `.value` initializerには位置付きwarningを追加したが、JSX children、dynamic alias、cross-module callback、async/deferred helperは保証対象外であり、M3のexactnessは未達。

追加したStrictMode/SSRテストはcapture runtimeが通常のcommit lifecycleで動くことを確認するが、Vite/Oxc Fast Refresh実環境、複数rootの同時render、Concurrent time-slicing、hydration、React Compilerの検証には代わらない。StrictMode更新ではrender関数が複数回呼ばれるため、回数ではなく値の追従とunmount後の停止をassertする。

この試作は**採用・M3完了の根拠にはならない**。`const proxy = deep.value; proxy.user.name`の単純identifier aliasと同一module内で静的解決できる同期helper/render callbackは試験した。追加変更で、同期plain helper readを`mode: "auto"`のinspectionへfoldし、helper本体ではなく静的に分かるcallsite全体をcaptureする。async/generatorとHookを呼ぶhelperはこのfoldから除外する。helperが返すcallbackのbodyは同期実行されるとは限らないためinspectionから除外し、実行地点を特定できないclosureをrender attemptへ結び付けない。JSX function propとdestructuring `.value` initializerには診断を追加した。JSX children、aliasの複雑な再代入、cross-module helper、任意の独自deferred callbackには一般解がなく、引き続きM3 exactness未達として扱う。

## 旧判断の履歴（managed統合前）

Clef-flashの比較では「静的に証明できる自動tracking範囲を定義し、曖昧patternへ位置付き診断を出し、曖昧な読み取りには明示subscriptionを使う」案を選好した（A 0.9354、B 0.0425、C 0.0221）。これは補助意見であり、実装の正確性を保証しない。現時点の方針として、per-read prototypeは自動追跡範囲の正確性と診断可能性を測るために続ける。根拠が揃うまで既定managedへ接続せず、暗黙のbest-effort降格も行わない。曖昧ケースを安全に拒否できない場合はtargeted subscriptionを主要契約にする案へ戻る。

この方針には、静的に分かるdestructuring deep read、generator、JSX render prop、未知callbackの代表例に位置付きdiagnosticまたは明示APIで対応できることが必要。cross-module sourceを一file transformだけで判断できない境界は、検出不能として説明し、無音のexactness保証をしない。

2026-10-13の再判断でもClef-flashは有限な静的範囲を定義して既存managed契約を保つ案を支持した（A 0.9452、B 0.0548）。補助意見として記録し、正確性は診断と実環境gateで判定する。

### 当時の未完了項目（履歴）

1. cross-module helper、destructuring read、complex aliasを含むtracked read漏れを診断できる範囲を定義する。
2. 同一task内の別root、StrictMode、SSR/hydration、React Compiler、Fast Refreshでattempt ownershipとHook orderを検証する。
3. 自動trackingを保証できる静的範囲とtargeted subscription契約への変更を比較し、breaking change・migrationを文書化する。
4. exactness gateを満たすまでM3を未完了のまま保つ。
