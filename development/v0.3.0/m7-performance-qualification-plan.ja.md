# M7 — 性能・memory・bundle qualification plan

## v0.2.1で利用できる設備

- `pnpm bench:react` は `benchmarks/react-render.mjs` を実行する。標準設定は500 sibling rows、300 updates、warmup 2回、sample 5回。CLI引数、`BENCH_WARMUPS`、`BENCH_SAMPLES`、`BENCH_VARIANT`、`BENCH_OUTPUT` で再現条件を指定できる。render-count assertionを含み、React 19/JSDOMでmount/update形状を測る。
- `pnpm bench:transform` はpluginの小/大fixtureを測る。標準は400 small modules、20 large modules、warmup 3回、sample 9回。現状はauto modeのinject/managed向けで、JSONL・heap記録はない。
- `pnpm size` はVite/minifier app-graphの7 scenarioをraw/gzip/brotliで測る。budgetはgzip中心で、transform packageはこのsize suite対象外。
- 既存の`benchmarks/results-m2-stabilization-2026-09-27.jsonl`等は履歴参考。多くは10 rows/100 updatesで、v0.2.1と現在候補の対比較ではない。M1 historical benchmarkもv0.1.1基準を含むため、v0.2.1 gateとして再利用しない。

## 正確な比較基準

baseline commitは`58f01b9314a1b09b88b162c57912ff736201e790`（package version 0.2.1）。benchmark suite自体がbaselineにある。現worktreeを上書きせず、同一Node/pnpm/依存lock/CPU上でbaselineと候補を別checkoutにし、run順を交互にして新規processで測る。

各ケースは正確性assertionを毎回走らせる。まず同一fixtureでbaselineと候補を最低6 paired rounds、2 warmup、7 measured samples以上実行し、raw result、各中央値/IQR、paired ratioを保存する。jsdomはbrowser performanceの代替ではない。

## 追加すべき測定

1. Existing core/deep/React fixturesをbaseline/candidateの両方で同一環境に固定する。array/Map/Setはすでに存在するbenchmark coverageとM2 contractを照合し、不足だけ追加する。
2. transformは同一のsource corpusと結果の意味論assertionを使い、実出力バイト数・transform時間を新規processのraw結果として記録する。M3/M5で決まった最終方式を含める。
3. React mount/update/unmount後のGCを伴うretained-heap scenarioを追加する。これはallocation rateではなく診断的なretention比較として明記する。
4. package sizeは既存7 app graphsに加え、両packageのnpm pack tarballと展開後ファイルを同じlockで比較し、runtimeとtransformの両方を記録する。
5. Compiler、browser E2Eを対応範囲へ含める場合は別測定として分離し、結果を一つのaggregate scoreへ混ぜない。

正確性に失敗する候補の性能結果は採用根拠にしない。測定条件・Node/pnpm version・CPU・OS・commit SHA・実行順・全raw data・中央値/IQRを結果と一緒に保存する。測定対象のarchitectureが確定し、M1〜M6の実装が安定してから比較を完了する。

## 2026-10-13 paired measurement

固定baselineは上記のv0.2.1 commit。Node `v24.21.0`、Windows x64、AMD Ryzen 7 PRO 6850U。candidate/baselineを順序交互で6 paired rounds、各round 2 warmups + 7 measured samples、新規processで実行した。JSONLのcandidate識別子はcommit前worktree (`codex/v0.3.0-m0`)。各raw記録には実行順、環境、条件、sample配列を含める。

結果ファイル:

- `m7-core-2026-10-13.jsonl`: signal、computed、effectのcoreケース。
- `m7-deep-2026-10-13.jsonl`: deep propertyとarrayケース。
- `m7-collections-preopt-2026-10-13.jsonl`、`m7-collections-2026-10-13.jsonl`: reactive Map/Set/WeakMap/WeakSet。
- `m7-react-2026-10-13.jsonl`: React 19.3 + JSDOM。負荷は100 rows / 10 updates。render-count assertionあり。ブラウザー速度の代替ではない。
- `m7-transform-2026-10-13.jsonl`: 40 small modules、120-component large module。warmup 2、sample 7。
- `m7-memory-2026-10-13.jsonl`: React mount/unmount後のGC retained heap。100 rows、5 cycles、sample 7。allocation rateやleakの証明ではない。

### 判定

- Core/deep property、React、transformの大半はIQRが広く、paired ratiosが1をまたぐ。環境ノイズ内であり、一般的な速度向上・悪化の主張はしない。React fixtureを500 rows/300 updatesから100/10へ減らした理由は、6 roundsを実行可能な時間で測るため。測定結果にはこの条件を明記した。
- pre-optimizationでWeakMap/WeakSetのplain object keyがnative比で約3,000倍遅くなる問題を確認した。generic normalizerが毎回graph stackを作ることが原因。proxy unwrapとown-keyのないobjectの高速経路を追加し、再測定でnativeとの中央値差をWeakMap約18倍、WeakSet約15倍まで縮めた。依然として絶対性能差はあるため、Map/Set等の結果も含めAPIの性能保証には使わない。
- retained heapのpaired candidate-minus-baseline中央値は`-20 B`、IQRは`-1,062〜+974 B`。サンプル分散が大きく、retention差なしと断定できる精度ではない。再現性のあるリーク兆候もこのfixtureからは観測していない。
- app-graph gzipはbaselineと比較して、signal-only `7,275→7,263 B`、core `7,304→7,291 B`、core+hooks `8,912→9,037 B`、deep `12,214→14,844 B`、index-full `17,130→20,360 B`、jsx-runtime `11,234→11,733 B`、utils `8,774→8,842 B`。deep/fullの増加はcollectionsおよび新runtime境界を含む。signal-only/coreは維持されている。5% headroomを足したgzip budgetを更新し、`node scripts/check-size.mjs`で全budget通過。
- `npm pack --ignore-scripts`は空のstagingから作成したv0.3.0 manifest（workspace依存をrelease rangeへ置換）で実行した。build hashの異なる前回artifactが混ざらないことをfile countで確認。baseline v0.2.1のnpm tarballはruntime `130,983 B` / unpacked `520,786 B`、plugin `60,860 B` / `204,011 B`。candidateはruntime `130,164 B` / `519,553 B`、plugin `60,870 B` / `204,036 B`。gzip tarball差はruntime `-819 B (-0.6%)`、plugin `+10 B (+0.02%)`で、実質同サイズ。candidate npm tarballからruntime API、collection tracking、5 bundler adapterをimport/実行するconsumer smokeは成功。
- 補足として`pnpm pack --ignore-scripts`のcandidate tarballはruntime `131,263 B`、plugin `61,158 B`。npm pack結果とpackage metadata差分を混同しない。リポジトリ標準`tests/consumer-smoke.mjs`はpnpm `prepack`を実行するが、hostにpinされたpnpm 12.3.4がなく失敗した。最終release manifest/versionを更新した後に、正しいpnpm環境でこのbuilt-in smokeを再実行する。

### 追加した最適化

`src/core/deep-signal-engine.ts`のweak collection key normalizationは、すでにproxyならraw identityへ変換し、own keyが0の通常objectならgraph normalizationを省く。own propertyを持つobjectは従来どおりfull normalization/validationを通す。弱参照の意味論を維持しながら、benchmarksの主因だけを避ける。focused deep-signal/collection/review regressions 66 testsおよびruntime typecheckを通過した。最終runtime suiteも38 files / 555 testsを通過した。
