# M10 — 細粒度レンダリングとWritable Computed

開始基準: `18872dab0625da06151cf23e05f596ce5d6ee3ba` (`main`)

## 判断の要約

- `For`のkeyごとにmemoized Rowを置く案を実測した。単一行更新ではcallback実行を大きく減らす一方、10,000行ではmount、heap使用量、移動・全件置換が悪化したため、本番の`For`には採用しない。
- `Index`は位置identityと最新collectionを読むaccessorの契約を維持し、変更しない。
- `computed({ get, set })`を追加した。既存computed nodeのlazy evaluation、cache、依存追跡、interop protocolを使い、Writable computedをM9.1 form bindingで利用できる。
- JSX runtimeに対してReact 19のfactoryを使った単体測定を追加した。計測の結果はPhase Cのqualification欄に追記する。

## Phase A — `For` / `Index`

### 現行契約

`For`は配列、Set、Mapを受け取り、全行について`by(item, index)`と`children(item, index)`を実行する。React keyは行のidentity、state、DOMのreconciliationに使われるが、リスト構造の変更時にcallback自体を省略するものではない。Mapのchildrenには`[key, value]`を渡す。

`Index`のidentityはkeyではなく位置で決まる。childrenには位置を読むaccessorを渡し、accessorを保存して後から呼んでも最新のcollectionを読む。配列のimmutable replacementでは、位置にある値が同じでもcallback/accessorを更新する。

既存テストで、Forのkeyによるstate保持、Indexの位置state、signal/deepSignal更新、Map/Set/配列、fallback、StrictMode、SSR、兄弟へのtracking境界、保存したIndex accessorを確認した。追加テストではFor/Indexのunmount後にmicrotaskでcollection subscriptionが解除されること、Forの親closureとContextが更新されることを確認した。

### 測定条件

候補はkeyごとに`React.memo` Row componentを作り、Row内で`useManagedSignals()`を使ってchildren callbackを追跡する設計。baselineはM10前のFragment/map実装を同じbenchmark process内で再現した。候補はbenchmark専用実装で、製品コードには残さない。

- Node v24.21.0、React 19.3.0、jsdom、同じprocessでbaselineと候補を実行
- 100行と1,000行はwarmup 1回、timed samples 3回。中央値とp25/p75、および各sampleをJSONへ記録
- 10,000行はwarmupなし、timed sample 1回。実行時間が大きかったため、このサイズの数値は参考値
- mount時にGC前後のheap差を測定。これはmount treeが保持するheapの参考値で、unmount後のretained heap測定ではない
- callbackとRow render回数は各updateで検証。update操作はsingle item replacement、append、prepend、middle delete、move、replace all
- 実行ホストの詳細なCPU/OS情報は記録していない。壁時計の絶対値は同一環境内の比較として読む

測定データと再現用harness:

- [100/1,000行の候補試作比較](./m10-list-prototype-100-1000.json)
- [10,000行の候補試作比較](./m10-list-prototype-10000.json)
- [benchmark harness](../../benchmarks/m10-list-bench.mjs)

### `For` baselineと候補

時間はmedian ms、heapはmount時heap差。100/1,000行は3 timed samples、10,000行は1 sample。

| 行数 | 実装 | mount / heap | 単一行更新 | append | prepend | 中央削除 | move | 全件置換 | unmount |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | baseline | 52.3 ms / 0.76 MB | 34.5 ms, 100 callbacks | 38.9 ms, 101 | 43.4 ms, 101 | 43.5 ms, 99 | 49.1 ms, 100 | 37.8 ms, 100 | 5.2 ms |
| 100 | memo Row | 64.0 ms / 1.17 MB | 16.8 ms, 1 callback | 12.8 ms, 1 | 52.1 ms, 101 | 31.6 ms, 49 | 48.1 ms, 100 | 63.3 ms, 100 | 7.8 ms |
| 1,000 | baseline | 434.8 ms / 6.03 MB | 362.9 ms, 1,000 callbacks | 499.2 ms, 1,001 | 685.6 ms, 1,001 | 537.4 ms, 999 | 364.3 ms, 1,000 | 572.3 ms, 1,000 | 24.4 ms |
| 1,000 | memo Row | 508.7 ms / 10.52 MB | 100.2 ms, 1 callback | 115.5 ms, 1 | 677.0 ms, 1,001 | 342.7 ms, 499 | 544.2 ms, 1,000 | 411.4 ms, 1,000 | 41.1 ms |
| 10,000 | baseline | 1,611.7 ms / 45.36 MB | 1,177.4 ms, 10,000 callbacks | 1,141.7 ms, 10,001 | 1,419.0 ms, 10,001 | 1,192.8 ms, 9,999 | 1,572.0 ms, 10,000 | 1,774.8 ms, 10,000 | 215.1 ms |
| 10,000 | memo Row | 2,628.0 ms / 87.88 MB | 898.5 ms, 1 callback | 891.7 ms, 1 | 2,104.4 ms, 10,001 | 1,674.9 ms, 4,999 | 2,336.9 ms, 10,000 | 2,444.7 ms, 10,000 | 308.3 ms |

単一行更新とappendでは、候補が既存row callbackを省略し、10,000行でも1 callbackまで減った。一方、10,000行のmountは約63%遅く、mount時heap差は約1.94倍になった。prepend、move、全件置換はいずれも候補の方が遅い。100/1,000行の候補もheapとunmountコストが増えた。差分更新の利得に対し、rowごとのReact componentとmanaged tracking scopeの費用が大きく、ここでは採用価値がないと判断した。

したがって、**製品の`For`と`Index`はM10前の実装を維持する**。Index用のmemoized Row候補は実装・計測していない。位置accessorのsourceを最新化する必要があるため、immutable replacementで全callbackを呼ぶ現行契約を維持する設計判断とした。benchmark専用CandidateForはFor比較の再現だけに使う。

## Phase B — Writable computed

### API

```ts
const count = signal(1);
const doubled = computed({
  get: () => count.value * 2,
  set: (value: number) => { count.value = value / 2; },
});

doubled.value = 10;
console.log(count.value); // 5
console.log(doubled.peek()); // 10
```

`computed(() => T)`は引き続き`ReadonlySignal<T>`、`computed({ get, set })`は`FormBindableSignal<T>`を返す。公開`Signal<T>`のshapeは引き続きstructuralで、custom writable signalの型代入互換性を保つ。一方、明示的form bindingの型には、package `signal()`またはwritable `computed()`が返す型専用`FormBindableSignal<T>`を要求する。これはruntimeのRFSG signal-brand検査と一致し、runtimeで拒否される未登録のstructural objectをbinding可能とは型宣言しない。getter-only computedはreadonly型なのでbindingから拒否される。runtimeではgetter-onlyとwritable computedに別のprototypeを使い、readonly computedにsetterを露出させない。

両形式とも既存のlazy computed nodeを使う。別signalへの値コピーや専用reactivity graphは作らない。Writable setterはuntrackedかつbatch内で一度実行されるため、setterが読む補助signalは依存に含まれず、複数のsignal writeはsetter完了後に通知される。setter例外は伝播する。setterの処理がgetterの完全な逆変換でなくてもよく、以降のreadはsetterが書いた状態をgetterが導出する。

Interop protocolを同じnodeに付けたままにし、独立runtime間でWritable computedをread/writeするテストを追加した。Getter-only readonly判定、lazy evaluation、`peek()`、等価な派生値の通知、batch、effect、setter error、text input、checkbox、単一/複数select bindingのテストを含む。`useComputed()`は今回拡張せず、引き続きreadonlyである。

## Phase C — JSX runtime overhead

Reactの`jsx`/`jsxs` factoryと本パッケージのfactoryを同じprops入力で比較する単体benchmarkを追加した。host no-props/ordinary props/child/multiple children、custom component、Fragmentを比較し、signal prop/style/children、`bindValue`、`bindChecked`はRFSGのみのfeature costとして別計測する。各callでprops literalを生成し、ReactとRFSGをsampleごとに交互の順で実行する。

React 19.3.0 / Node v24.21.0で、各factoryを1万回/round、warmup 1回、timed sample 3回実行した。通常ケースのRFSG/React中央値比はno-props 1.54、ordinary props 2.41、one child 0.59、multiple children 3.61、custom no-props 0.94、custom ordinary props 3.49、Fragment 0.43だった。ただしsample間のばらつきが大きく、同一ケースでも数倍の揺れがあったため、これらの比率から実環境のrender性能を判断しない。これはprops literal生成とelement factory呼び出しのみを測る診断値で、React render/DOM更新は含まない。signal/bindingのfactory専用中央値と全sampleはJSON artifactに保存した。測定精度が足りず、runtime最適化は行わなかった。

- [JSX runtime測定結果](./m10-jsx-runtime-results.json)
- [JSX benchmark harness](../../benchmarks/m10-jsx-bench.mjs)

開始commit `18872dab` と同じNode/pnpm依存環境でbaselineを別の一時directoryに展開し、runtimeをbuildして`check-size.mjs`を実行した。baselineとM10後のconsumer bundleサイズ差（raw / gzip）は次のとおり。

| Import graph | baseline | M10後 | 差分 |
|---|---:|---:|---:|
| signal-only | 25.75 / 7.10 kB | 25.95 / 7.14 kB | +0.20 / +0.04 kB |
| core | 25.92 / 7.13 kB | 26.17 / 7.20 kB | +0.25 / +0.07 kB |
| core + hooks | 31.91 / 8.83 kB | 32.16 / 8.91 kB | +0.25 / +0.08 kB |
| deep | 56.09 / 13.88 kB | 56.29 / 13.93 kB | +0.20 / +0.05 kB |
| main entry全体 | 76.70 / 20.03 kB | 76.95 / 20.10 kB | +0.25 / +0.07 kB |
| JSX runtime import graph | 42.43 / 12.27 kB | 42.60 / 12.30 kB | +0.17 / +0.03 kB |
| utils | 31.33 / 8.64 kB | 31.53 / 8.70 kB | +0.20 / +0.06 kB |

全シナリオは既存size budget内。出力`dist/jsx-runtime.js`本体は0.48 kB（gzip 0.27 kB）で、M10ではJSX runtimeを変更していない。core runtime chunkは45.89 kBから46.26 kBへ+0.37 kB、gzipは9.98 kBから10.07 kBへ+0.09 kB。共有JSX chunkは92.84 kBで変化なし。size check artifactのraw/gzip差はWritable computed API追加による小さな増加であり、tree-shaking budgetを越えていない。

## Qualification

| 検証 | 結果 |
|---|---|
| Focused core / control-flow / JSX form binding | pass — 3 files, 89 tests |
| Runtime full coverage | pass — 40 files, 587 tests; statements 94.09%, branches 90.23%, functions 97.36%, lines 95.65% |
| Transform full coverage | pass — 8 files, 408 tests; statements 92.85%, branches 90.36%, functions 97.37%, lines 95.47%. `react-compiler.test.ts`とVite compiler-order testsを含む |
| Typecheck / lint / build | pass — runtime/transform typecheck、oxlint（warningsのみ）、runtime/transform build |
| Consumer package smoke / cross-copy / mixed-version | pass — packed consumer/Vite builds、duplicate-copy interop、mixed-version smoke。旧version間の一部signal interopはテストでunsupportedとして確認 |
| Browser E2E | pass — 59/59 cases: Chromium 16, Firefox 16, WebKit 16, production bundle 4, React Router 7。1 workerで実行。5-worker実行ではWebKit hydration testが一度timeoutしたが、直列suiteでは再現せず |
| React Compiler / Fast Refresh | pass — React Compiler専用suiteはtransform full coverageに含まれ、Vite plugin-order compiler integration testsも通過。今回pluginのFast Refresh出力は変更なし。既存HMR matrixは18 passed |
| Bundle size | pass — 7 consumer import graphすべてbudget内。baseline差分は上記表のとおり |
| Independent code review | pass — For/Index契約とwritable-computed APIをレビュー。Index memo候補は実装・測定済みとは扱わず、製品変更なし |
| Performance / memory | pass — 100/1,000/10,000行For候補測定。候補のmount/heap/再配置コスト悪化により採用せず。Index 100/1,000行の現行測定も保存 |

## 既知の制約とM11候補

- `For`はReact keyによりidentityとstateを保つが、collection更新時に全rowのrender callbackを実行する。行単位callback memoizationはmount時間とheap増加が大きく採用しなかった。
- `Index`は位置identityで、配列の置換時に行accessorを最新化するためcallbackを再実行する。
- Writable computedはcore APIとJSX bindingまで。`useComputed`のwritable版は今後の候補。
- 10,000行は単一sampleの参考値であり、性能の一般化には追加の実機測定が必要。

M8 freezeはこの記録に基づき再評価する。5-worker E2EのWebKit hydration timeoutは直列再実行で再現せず、既知のコード欠陥とは判定していない。再現性のないtimeoutを隠すためのtimeout延長・テスト除外は行っていない。
