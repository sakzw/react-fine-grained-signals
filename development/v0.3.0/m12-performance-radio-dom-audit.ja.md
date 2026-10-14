# M12 — computed性能・form group・DOM保持監査

開始基準: `main` / `584c7246209ae587775d4760ad01f1f1b1f1aa97`

目的は、性能値の正しい解釈、radio groupのnative semantics、binding cleanupを確認し、実測で利益が確かめられない最適化を加えないこと。`alien-signals`はlow-level runtimeとして維持する。

## M11から引き継いだ問題

- M11の`computed/create`はadapter込みで、public API wrapper・runtime内部・生成物を分離していなかった。
- raw `alien-signals`約5.07M ops/sに対しRFSG約0.14M ops/sという値は、同一consumer workloadのpaired before/afterではない。機能層、adapter、生成物の保持方法、GC状態も異なるため、「RFSG computed自体が一律36倍遅い」とは結論できない。
- radio group registryはSignal identity単位だが、HTMLの排他制御はform ownerと`name`単位。同じnative groupのradioに異なるSignalをbindすると、ブラウザーが相手のDOMだけを解除しSignalが古いまま残る経路がある。
- M11 JSDOMのWeakRef診断では最後にunmountしたhost nodeが1個残ることがあった。WeakRef単独ではruntime leakと断定できない。

## computed生成benchmarkと解釈

新しい再現用計測は`benchmarks/computed-profile.mjs`。runtime build後に実行する:

```powershell
$env:BENCH_ITERATIONS='20000'
$env:BENCH_WARMUPS='3'
$env:BENCH_SAMPLES='7'
node --expose-gc benchmarks/computed-profile.mjs
```

RFSG public API、built runtimeから得た`ReactiveRuntime`、public resultを包むbenchmark adapter、raw `alien-signals`を分離する。getter-only/writable、作成後破棄/保持、初回read、cached read、update+read、observed updateを測り、adapter順をsampleごとに交互にする。getter値や最終結果を読んで計測結果をobservableにする。retained heapはforced-GC後のprocess heap差として診断表示する。破棄ケースのheap差はGC基準値の揺れがあるため、allocated bytesの測定とは扱わない。

環境: Node `v24.21.0`, win32 x64, AMD Ryzen 7 PRO 6850U。20,000 operations、3 warmups、7 samples。代表値(中央値; p25–p75 ms):

| workload | RFSG public | RFSG internal runtime | RFSG + benchmark adapter | raw alien-signals |
|---|---:|---:|---:|---:|
| getter-only create/discard | 134.747 ms (121.616–145.259), 148k ops/s | 110.267 ms (97.178–155.812), 181k ops/s | 127.799 ms (115.197–145.445), 156k ops/s | 1.196 ms (1.093–1.849), 16.72M ops/s |
| getter-only create/retain | 142.618 ms (132.910–143.938), 140k ops/s | 102.761 ms (86.065–126.241), 195k ops/s | 147.697 ms (120.394–178.231), 135k ops/s | 10.047 ms (9.061–11.541), 1.99M ops/s |
| writable create/discard | 127.609 ms (101.152–140.284), 157k ops/s | 110.508 ms (97.069–114.303), 181k ops/s | 112.058 ms (101.226–139.085), 178k ops/s | n/a (read-only computed) |
| create + first read | 127.662 ms (104.975–136.636), 157k ops/s | 125.025 ms (116.755–128.596), 160k ops/s | 113.582 ms (105.304–134.916), 176k ops/s | 3.597 ms (2.931–3.846), 5.56M ops/s |
| cached read | 5.281 ms (4.360–5.894) | 6.039 ms (5.251–6.093) | 7.022 ms (6.739–8.074) | 1.065 ms (1.031–1.093) |
| update + read | 45.982 ms (37.063–48.146) | 40.633 ms (37.215–43.347) | 36.693 ms (31.626–38.370) | 17.394 ms (15.894–19.735) |
| observed update | 37.743 ms (36.286–44.263) | 39.015 ms (37.933–42.329) | 35.561 ms (32.527–40.160) | 25.322 ms (23.854–30.843) |

計測は層別化できたが、public/internal createの分布は重なる。wrapperが主因という帰属はできない。raw `alien-signals`との生成差は大きいが、raw側にはRFSGのbrand、readable interop protocol、WeakMap登録、React/ownership契約がない。比較値をそのまま最適化目標やrelease性能保証にしない。

補足: 初版scriptはraw `alien-signals`のread-only `computed(getter)`へ2番目のsetter引数を渡していた。この引数はAPI上サポートされず無視されるため、上表の初版「writable create/discard」のraw値はwritable computed測定ではない。M12.1でこの比較値を撤回し、scriptはread-only adapterからwritable workloadを除外する。詳細は[M12.1 regression/benchmark closure](m12.1-radio-binding-benchmark.ja.md)。

同じHEADで実行した既存`benchmarks/core.mjs`の50,000 operations、2 warmups、5 samplesではcomputed/create中央値はraw `alien-signals` 9.675M ops/s (p25–p75 4.954–5.519 ms) / RFSG 525k ops/s (94.204–96.506 ms)。これはgetter-onlyを作り、最後の値を読むadapter benchmarkであり、広い傾向を示す参考値である。M11の約36倍差は同条件のA/Bではなく、今回の計測値も分布と保持方式に依存する。

retained getter-only heapはforced-GC後20,000個でRFSG public 6.53 MB、internal 6.57 MB、adapter込み10.58 MB、raw 3.85 MBだった。process heap差の単一sampleであり、RFSGとrawの全allocationやpeak heapを表す値ではない。破棄ケースの差は負値または数十KBの振れがあり、allocation計測としては不採用。

### コスト要因と最適化判断

source profileで確認したreadable computed生成の層は、`makeNode()`のnode/fields allocationとspread、helper-class allocation、brand descriptor作成と`defineProperty`、ReadableInterop protocol objectとWeakMap entry、protocol property登録である。これらは`isSignal`/brand identity、cross-copy readable interop、ownership、revision trackingの契約を支えている。

専用node object literalへ変えるprototypeはM12 worktreeでM11 baselineと計測した。10,000 creations・3 warmups・7 samplesでdiscard中央値はbaseline 57.41ms (p25–p75 56.78–71.63)に対しcandidate 61.33ms (57.75–78.58)で改善しなかった。retained中央値は121.77ms (83.9–434.16)対79.21ms (77.92–86.39)だったが、baseline側の極端なばらつきがあり再現性のある利益とは判断できない。first/cached readの測定にも互いに矛盾するJIT/GC影響があり、最適化根拠にしない。

**最適化は採用しない。** 生成constructor prototypeは破棄し、runtime contractを弱めたり初回readへコストを移したりしていない。immutable brand descriptorの共有も安全そうな候補だが、本M12では効果を測っていないため未実装。

## Radio / Checkbox group監査

### 確認した挙動

- 同じform ownerと`name`のradioを別Signalでbindすると、クリック後のnative DOMは選択radioを切り替える一方、変更対象でないradioのSignalは以前の値を保持する。後のSignal更新で古いradioがDOMへ再適用され得る。
- 同じSignalを複数React rootから共有すると、書き込みと他rootのDOM反映は同期する。
- 同じ`name`でもform ownerが別ならnative排他は独立し、別Signalも独立して利用できる。
- 同じSignalを別form ownerに共有した場合も、Signal変更時の全member refreshは維持される。
- Reactで`form`属性が切り替わるとbinding configが変わり、旧form reset listenerを解除し新formへ登録し直す。
- checkbox groupはSignal単位の複数選択memberであり、radio native exclusive groupと混同しない。

### 修正

`src/runtime/jsx.ts`でlive radio nodeからform owner (ない場合はtree root) とnameを確認し、同じnative group内の別RFSG binding nodeが別Signalを使っていれば`TypeError`を投げて拒否する。確認はbinding attachとclick処理で行い、各Signal更新のhot pathではpeer走査をしない。node→sourceはWeakMapで保持し、dispose時にsource一致を確認して削除する。attach時は`form.elements`またはtree root内のradioを走査するため、同一groupへN個を順にmountする総peer確認量はO(N²)になり得る。一般的な小規模form groupを優先し、lifecycleが遅延disposeされるReact nodeを誤って拒否しないことを重視して、強参照のgroup registryは導入しない。新たなobserverや長寿命strong node registryも加えない。

同一owner/nameのdistinct source reject、異なるform ownerの独立、別formでのshared source、同一native groupを使う複数React root、form owner変更時のreset listener再bindをJSDOM testに追加した。production browser fixtureでは異なるform ownerに同じnameを持つradioが独立することをChromium/Firefox/WebKitで確認した。

現行ガードは同じRFSG runtime copyがbindしたpeerを対象にする。React標準`checked`/`defaultChecked` radioや別RFSG copyのradioが同じnative groupに混在する形はbinding contractに含めない。public EN/JA guideでこの制約を明記する。bound groupでは1つのSignalを共有し、React controlled/uncontrolled radioと明示`bindValue`を混ぜないこと。Reactで`form`/`name` propsを更新する経路はbinding identity更新により再bindする。一方、別要素の`id`変更など、React binding propsを変えずにnative form ownerだけが変化する操作は自動再bindされないため、サポート保証外とする。

## DOM保持・memory監査

同じJSDOM process内で複数hostをunmountした診断では、WeakRef survivorはReact/RFSG、single/multiple selectの種別ではなく**最後にunmountしたhost**へ移動した。12 controlsの全RFSG MutationObserverはdisconnect済み。追加の空root unmount、10 event-loop turn、10 forced GC後も最後のhost 1個は到達可能で、retainer pathは確定できなかった。したがって「回収された」とは判定しないが、RFSG固有リークとする根拠もない。

runtime code reviewではselect binding disposeがsubscriptionを解除し、MutationObserverをdisconnect、`change`/form `reset` listenerをremoveすることを確認した。binderは`WeakMap<Element, NodeBinder>`にあり、既存unmount regressionではdetached nodeがSignal writeを追わなくなる。実ブラウザのheap snapshot/retainer pathは未取得で、JSDOM/React process retentionとの判別は残課題。

## Final qualification

| Gate | 結果 |
|---|---|
| Runtime full coverage | 619 tests passed; statements 94.11%, branches 90.24%, functions 97.51%, lines 95.89% (thresholds未変更) |
| Transform full coverage | 408 tests passed; statements 92.85%, branches 90.36%, functions 97.37%, lines 95.47% |
| Typecheck | root runtime + transform package passed |
| Lint | passed; repository existing warnings remain |
| Runtime/transform builds | passed |
| Browser E2E | Chromium/Firefox/WebKit + production build + React Router: 71/71 passed with `--workers=1`. Initial 5-worker run had two unrelated hydration smoke timeouts; focused serial rerun passed both, then full serial run passed. Test timeout was not changed. GitHub E2E run [38627323881](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38627323881) passed. |
| Cross-copy | `test:phase4-duplicate` and consumer smoke cross-copy runtime passed |
| Mixed-version | `test:mixed-version` passed; v0.1.1 interop remains explicitly unsupported as reported by existing smoke |
| Consumer package / pack | runtime and unplugin tarballs installed into isolated consumer smoke and passed |
| Bundle size | pass. `jsx-runtime` 13.60 kB gzip (M11 13.34 kB, +0.26 kB); budget 14.00 kB. `index-full` 21.50 kB (M11 21.25 kB, +0.25 kB); budget 22.31 kB. Budgets unchanged. |
| Computed performance | profile added; no optimization adopted. See tables above. |
| DOM heap | JSDOM final-host survivor unresolved; no RFSG-specific retaining path found. |
| Radio group checks | Attach/click validate native peers; Signal update path does not rescan the group. Same-commit keyed replacement with a new source is covered. |

Full runtime coverage was rerun after the same-commit radio replacement regression test was added. GitHub Test run [38627324180](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38627324180) passed on `3dea01813c989a81ce75eb0f11ade6d1356269cb`.

## Commit / push / Actions

| Commit | 内容 |
|---|---|
| `093b4a0` | Native radio-group source validation, lifecycle replacement regression, browser fixture/E2E and EN/JA contract docs |
| `3dea018` | Computed profiling benchmark, M12 audit record and roadmap update |

Both commits were pushed to `origin/main`. At verification, `main` pointed to `3dea01813c989a81ce75eb0f11ade6d1356269cb`. GitHub [Test](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38627324180) and [E2E](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38627323881) workflows both succeeded. No release tag, GitHub Release, or npm publish was created.
