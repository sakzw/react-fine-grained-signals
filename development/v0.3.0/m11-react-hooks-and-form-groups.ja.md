# M11 — React hooks・フォームgroup・snapshot評価

## 対象と判断

開始時の`main`は`2dc28691d61cb8a432fae0dbe0094487cc56acf7`。M11.1とM11.2は製品APIとして実装する。M11.3はimmutable object snapshotのprototypeを計測し、採用条件を満たさないため製品コードには入れない。

## M11.1 — writable `useComputed`

- getter-only overloadは従来どおり`ReadonlySignal<T>`を返す。
- `{ get, set }` overloadは`FormBindableSignal<T>`を返し、`bindValue` / `bindChecked`へ渡せる。
- dependencies付きoverloadも追加し、get/set closureを一体で更新する。更新はcommit後に反映し、abandoned renderが現行closureを置き換えない。
- dependency modeとreadonly/writable capabilityはcall siteの生存期間中固定し、切り替えをruntime errorにする。
- form bindingではgetterを表示値の正本とする。setterが拒否・正規化した場合だけ、Reactのイベント処理後にDOMを補正する。

検証にはno-deps/deps binding、複数dependencyの更新、dependency切替、StrictMode、Suspenseで中断されたrender、capability切替のtestを追加した。

## M11.2 — radio / checkbox group

APIは明示`bindValue`を継続する。単独checkboxはbooleanの`bindChecked`、radio groupは共有`FormBindableSignal<string>`、checkbox groupは共有`FormBindableSignal<string[]>`を使う。各radio/checkboxにはstring `value`を要求する。

- group bindingはReact renderなしにSignalとDOMを同期する。checkbox groupは追加値を配列末尾へ加え、既存順序を保つ。解除時は一致する値をすべて除く。既存配列に含まれる重複値は、選択を解除するまで保持する。
- `disabled` optionのユーザー操作は無視する。radioとcheckbox groupは同一のSignalを共有し、別Signalのフォームは独立する。
- target native `click`でSignal setterをReact delegated handlerより先に呼ぶ。DOM correctionはgetterのchecked stateとユーザー操作後のstateが異なる場合だけ、event propagation後に予約する。受理された通常Signal入力にはtimerを作らない。これによりReact synthetic `onChange`が1回届き、拒否・補正時も最終DOMがgetterに一致する。
- signal更新は`checked`と`defaultChecked`を同期し、form resetは最新のSignal値へ戻る。SSRはsignal値を初期`defaultChecked`に反映し、hydration後にbindingを開始する。
- signalが同じradio/checkbox optionのbindingを解除するときはmember registryから除去する。timerはdispose・再binding時にcancelし、同じDOM nodeの古いbindingが後続値を上書きしない。
- TypeScriptはgroup種別・値型・name要件・競合checked/defaultValueを可能な範囲で検査し、runtimeでも同じ不正組合せを拒否する。`bindChecked`と通常の`value`/`defaultValue`の併用は引き続き有効。
- `Set<string>`は配列と異なる意味論を追加し、型・SSR・FormData・resetを複雑にするため今回見送る。

追加テストはJSX型、SSR/hydration、JSDOM、実ブラウザ操作、FormData、disabled、reset、Signal切替、拒否setter、render回数を扱う。

## M11.3 — `useDeepSignalValue` object snapshot prototype

選択したplain object/arrayを再帰的にcopy/freezeし、structural equalityでstable identityを保つprototypeを`src/react/hooks.ts`に一時実装して測定した。対象は同一React/jsdom環境、Node v24.21.0、5 trial、各trial 30更新。変更した値は選択subtree内の先頭recordの数値field。primitive selectorはそのfieldのみを返す。

| 選択subtree | primitive median ms/update (min–max) | object snapshot median ms/update (min–max) | object/primitive比 |
|---:|---:|---:|---:|
| 10 records | 0.643 (0.537–0.752) | 1.922 (1.264–2.805) | 3.0× |
| 100 records | 0.880 (0.538–1.241) | 7.365 (5.977–9.146) | 8.4× |
| 1,000 records | 0.876 (0.327–2.521) | 75.675 (71.155–91.674) | 86.4× |

両方で外側のunrelated mutationは0 render、equal replacementは0 renderだった。selector callはequal replacementあたり1回。forced-GC後のheap delta中央値はobjectで10 records `+18,656 B`、100 records `-46,592 B`、1,000 records `-266,512 B`。負値と大きな揺れはこの計測ではretained memory差を示せず、heapの効率保証を支えない。JSDOM/Reactのtimer警告が一部出ており、絶対時間はブラウザ性能保証ではないが、subtreeサイズに応じた明確な増加が観測された。

**判断: prototypeは不採用。** 1,000-record selectionで更新がprimitive比86倍となり、copy allocationとheapの安定した利点も実証できなかった。現在の`SignalSnapshot`/`useDeepSignalValue`のprimitive-only型とruntime validationを維持し、prototype code/test/benchmark scriptを製品へ残さない。必要な表示値をprimitive selectorで選ぶか、tracked component内で読む。

## Qualification

| 項目 | 結果 |
|---|---|
| Focused runtime suites | `react-dom-binding`, `react-hooks`, `react-deep-signal`, `ssr`: 124/124 pass。reset回帰を追加した後、`react-dom-binding`: 63/63も再実行してpass |
| Typecheck | runtime + transform pass |
| Lint | `pnpm lint` pass。既存warningを含む |
| Build | `pnpm build`でruntime + transform pass |
| Browser E2E | 68件中66件が5-worker runでpass。負荷時にtimeoutしたFirefox hydrate/Activity 2件は単独workerで再実行して2/2 pass。reset追加後のfinal radio/checkbox E2EはChromium、Firefox、WebKitで3/3 pass |
| Runtime full coverage | 613/613 tests、statements 94.10%、branches 90.13%、functions 97.50%、lines 95.86% pass。40 default-pool workerで実行 |
| Transform full coverage | 408/408 tests、statements 92.85%、branches 90.36%、functions 97.37%、lines 95.47% pass |
| Consumer/package | `pnpm test:consumer` pass。runtime/plugin tarballs、consumer TypeScript/Vite build、cross-copy runtime smokeを確認 |
| Mixed-version | `pnpm test:mixed-version` pass。v0.1.1とのSignal interop拒否など、既存のunsupported boundaryを確認 |
| Bundle size | final buildで`jsx-runtime` 13.34 kB gzip、`index-full` 21.25 kB。旧budget 12.88/20.94 kBを機能追加分が超えたため、`pnpm size:update`で各実測値+5%のheadroomへ更新。tree-shaking presence/absence checkを維持し、最終`node scripts/check-size.mjs` pass |

### Performance characterization

計測はNode v24.21.0 / React 19.3.0 / AMD Ryzen 7 PRO 6850U上の手動診断。別環境の予測値や性能保証には使わない。既存`benchmarks/core.mjs`は100,000 operations、3 warmup、9 samplesでsignal/computedのcreate/read/update/batchを測る。再実行は`pnpm build:runtime; node --expose-gc benchmarks/core.mjs`。M11では直接のcomputed生成時間も比較するJSX factory characterizationと、JSDOM上で実際にmount/update/unmountするフォームbinding比較を追加した。

#### Core signal/computed

| Case | alien-signals raw ops/s (p25–p75 ms/100k) | RFSG ops/s (p25–p75 ms/100k) | @preact/signals-core ops/s (p25–p75 ms/100k) |
|---|---:|---:|---:|
| signal/read | 15.69M (6.342–7.169) | 5.76M (11.530–31.394) | 26.25M (3.502–6.600) |
| signal/write | 15.41M (6.451–7.018) | 9.87M (5.581–12.154) | 8.52M (9.711–12.808) |
| signal/observed-write | 2.43M (34.480–63.050) | 0.54M (94.164–245.871) | 1.80M (36.723–62.275) |
| computed/create | 5.07M (18.948–29.427) | 0.14M (567.126–842.477) | 3.16M (27.239–37.925) |
| computed/read | 1.66M (34.396–94.246) | 4.62M (13.184–63.708) | 6.30M (6.386–20.153) |
| computed/update-and-read | 0.60M (151.580–278.437) | 2.34M (41.818–45.654) | 2.75M (28.243–62.541) |
| batch/two-observed-writes | 0.46M (165.824–270.825) | 0.58M (141.087–278.435) | 0.65M (141.553–166.990) |

`benchmarks/core.mjs`はcomputedの生成、cached read、update-and-readを別々に測るよう拡張した。生成caseは最後のcomputedを保持して結果を確認する。今回の9-sample runではRFSGのcomputed生成中央値がraw比較対象より遅く、他のcaseもp25–p75の幅が大きい。これは現状値を記録する診断であり、M11でcore algorithmを変更していないためM11起因の回帰とは結論しない。M11機能のない同じpackage baselineとの同時A/B結果ではなく、性能差の帰属はできない。

#### JSX factory characterization

既存`benchmarks/m10-jsx-bench.mjs`へradio/checkbox-group binding casesを足し、Node v24.21.0 / React 19.3.0で10,000 iteration、2 warmup、5 sampleを比較した。これはJSX factoryのみ（DOM mount/subscribeを除く）なので単体mount時間として解釈しない。

| Case | median ns/call (p25–p75) |
|---|---:|
| React host ordinary props | 6,069 (5,622–6,133) |
| RFSG host ordinary props | 8,692 (6,989–8,877) |
| RFSG `bindValue` text | 12,896 (12,188–12,946) |
| RFSG `bindChecked` | 12,955 (12,743–13,259) |
| RFSG radio `bindValue` | 13,013 (12,828–14,885) |
| RFSG checkbox-group `bindValue` | 15,608 (14,159–16,115) |

radio factory costは従来のtext/checkbox direct bindingに近く、checkbox-group factoryは約2.7 µs/call増だった。測定分布には通常props caseを含むばらつきがあるため、傾向確認としてのみ扱う。owner rerenderが起きないことはruntime tests/E2Eで別途確認した。

#### Form mount/update and retained heap

再現コマンドは`pnpm build:runtime`の後に`node --expose-gc benchmarks/m11-form-runtime-bench.mjs`。環境変数`M11_FORM_WARMUPS`、`M11_FORM_SAMPLES`、`M11_FORM_UPDATES`、`M11_FORM_HEAP_CYCLES`、`M11_FORM_HEAP_WIDTH`で測定量を変更できる。PowerShellで記録条件を再現するには、`$env:M11_FORM_WARMUPS='2'; $env:M11_FORM_SAMPLES='5'; $env:M11_FORM_UPDATES='40'; $env:M11_FORM_HEAP_CYCLES='10'; $env:M11_FORM_HEAP_WIDTH='5'; node --expose-gc benchmarks/m11-form-runtime-bench.mjs`を実行する。update・mount時間は中央値とp25–p75、heapは5 sampleのprocess heap差を記録した。

| Binding | mount ms React / RFSG (p25–p75) | update ms/op React / RFSG (p25–p75) | owner rerender React / RFSG |
|---|---:|---:|---:|
| text | 4.30 (3.48–4.58) / 3.45 (3.10–4.08) | 0.67 (0.65–0.86) / 0.06 (0.05–0.06) | 40 / 0 |
| checked | 4.25 (3.37–11.80) / 5.05 (4.14–12.59) | 0.91 (0.79–1.02) / 0.05 (0.04–0.17) | 40 / 0 |
| single select | 5.64 (5.44–10.11) / 7.47 (5.41–8.25) | 1.10 (0.96–1.39) / 0.11 (0.11–0.17) | 40 / 0 |
| multiple select | 4.64 (4.62–5.00) / 4.79 (4.54–5.09) | 0.82 (0.77–1.07) / 0.14 (0.13–0.14) | 40 / 0 |
| radio group | 4.84 (4.57–5.69) / 5.17 (4.79–5.41) | 1.11 (1.10–1.16) / 0.09 (0.08–0.10) | 40 / 0 |
| checkbox group | 4.31 (4.30–5.55) / 5.70 (5.02–5.81) | 1.03 (0.98–1.07) / 0.06 (0.06–0.06) | 40 / 0 |

Mount times include JSDOM/React root setup and have wide sample ranges. Update medians were lower for direct binding in this harness, while owner render counts matched the intended no-rerender contract. These are process-local results, not browser latency claims.

Forced-GC retained-heap median deltas and p25–p75 ranges (React / RFSG) were text `11,656 (10,992–24,864) / 36,824 (11,536–37,248) B`, checked `3,696 (3,456–8,720) / 25,336 (6,352–42,736) B`, single select `15,864 (12,808–46,296) / 22,024 (17,352–22,808) B`, multiple select `4,640 (3,872–11,768) / 36,592 (13,040–45,264) B`, radio `8,048 (2,256–9,320) / 14,608 (10,648–17,800) B`, checkbox group `9,424 (7,064–18,360) / 11,784 (10,728–13,408) B`. The ranges overlap or vary broadly, so these measurements do not establish a stable retained-memory advantage or regression. Across the full binding run all 544 created MutationObservers were disconnected and none survived the post-GC WeakRef check. One weakly referenced multiple-select node from an RFSG mount remained reachable in JSDOM after five event-loop/GC passes. Its retaining path was not identified, so the process-level heap diagnostic cannot establish whether this is a runtime retention or a JSDOM/React artifact. Browser heap profiling remains outside this diagnostic.

The benchmark checks final DOM values after updates and counts owner renders. Heap measurements are intentionally diagnostic: React, JSDOM, Node GC scheduling, and process caches make small deltas noisy. They are not a memory guarantee.

## Commits / push

- `ec657f0194fcbbbe6bbcb56d37553d036eb1cb92` — `feat: complete M11 hooks and form groups`。`origin/main`へpush済み。
- push後のGitHub Actionsは両方成功: [Test #146](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38586490331)、[E2E #146](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38586490068)。
- 追跡用のdocumentation commitでも`origin/main` SHAと上記のCI結果を記録した。
- `ef512b6c721539a089edfffc6d378b8dbdf1b132` — `perf: record M11 runtime binding benchmarks`。benchmark script、computed create/read測定、今回の性能記録を追加しpush済み。GitHub Actions [Test #149](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38591382266) と [E2E #149](https://github.com/sakzw/react-fine-grained-signals/actions/runs/38591382325) は両方成功。
