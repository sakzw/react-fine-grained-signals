# `signal`単体のバンドルサイズ

状態: 調査のみ。実装・PoCは見送り。計測日 2026-10-24、基準 `main` / `34e4912`。

## 現状

`import { signal } from "react-fine-grained-signals"`だけのConsumer（`scripts/check-size.mjs`の`signal-only`）は、raw 22,153 B / gzip 6,239 B / brotli 5,644 B。v0.2時代の記録（gzip 5.8〜5.9 kB）からほぼ横ばいで、M18.9の遅延初期化で約1.27 kB減らした後の値である。`index-full`はv0.2の11.4 kBから25.5 kBへ増えたが、増分はJSX Runtime、deep、form bindingで、`signal`単体は増えていない。

## 他ライブラリとの比較（実測）

同じViteのproduction build（minify、react系はexternal）で、import元はpnpm storeにある版を使った。

| 対象 | raw | gzip | brotli |
|---|---|---|---|
| alien-signals 3.2.1（signal + computed + effect） | 6,691 B | 2,108 B | 1,920 B |
| @preact/signals-core 1.14.4（signal + computed + effect） | 6,153 B | 2,013 B | 1,814 B |
| @preact/signals-core（signalのみ） | 6,100 B | 1,997 B | 1,807 B |
| react-fine-grained-signals（signalのみ） | 22,142 B | 6,237 B | 5,637 B |
| react-fine-grained-signals（signal + computed + effect） | 22,285 B | 6,276 B | 5,680 B |
| @preact/signals-react 3.12.0（core + hooks + runtime） | 12,730 B | 4,021 B | 3,577 B |
| react-fine-grained-signals core+hooks | 37,083 B | 10,092 B | 9,101 B |

グラフ本体だけなら約3倍、React統合込みで約2.5倍。

## 差の理由（coreの関数をソース文字数で分類した概算）

`alien-derived-runtime-core.mts`（約40.9k文字）の大きい部分:

- Concurrent React向けのspeculative評価: `promoteComputed` 3.1k、`readComputed` 1.6k、`getRenderDependency` 0.75k、`evaluateSpeculatively` 0.6k。合計約6k（約15%）。graphを変更せずに描画中のComputedを評価し、commit時に昇格する仕組みで、alien-signalsにもpreactにもない。
- cross-copy interopとbrand: foreign系関数が約2.8k、brand classが`HelperBrandSignal`/`HelperBrandComputed`/`WritableHelperBrandComputed`で約5k、別ファイルの`foreign-readable-v1`が約9k。複数のcopyが共存しても`isSignal`と読み取りが動くための構造。
- effectの所有権・破棄・エラー報告: `effect` 2.4k、`runEffect` 1.2k、`reportFailure`、`disposeEffect`、`withGraphOwner`。
- deep signal用の`DeepSignalRuntimeSource`（約1.5k）が、deepを使わない`signal`単体のbundleにも残る。Runtime closureに束ねられているため。
- writable computed、`subscribeReadables`（React用）、`batch`/`untracked`。

上記の分類は「何が大きいか」の目安であり、それぞれが何バイトのgzipになるかの内訳ではない。また、実装が機能に対して最小かどうかは評価していない（classやWeakMap、`Reflect.get`を多用しており、サイズ最適化を目的に書いてはいない）。

## 内訳

バンドルの約78%は`dist/plain-result-iterators-*.js`の1チャンク。このチャンクのsourcemap上の割合（空白・未対応付けを除く元ソースの文字数）:

| ソース | 割合 |
|---|---|
| `core/alien-derived-runtime-core.mts` | 約58% |
| `core/foreign-readable-v1.mts`（cross-copy interopとreadable登録簿） | 約12% |
| `core/interop.ts` | 約5% |
| `core/execution-owner.ts` | 約3.5% |
| `core/reactive-runtime.ts` | 約2.7% |
| `core/render-tracking.ts` | 約2.6% |

別に`alien-signals`の`system.mjs`がminify後で約2.3 kB。`signal`はComputed、effect、batch、interop、render trackingを1つのRuntime closureに持つため、`signal`だけをimportしても残りをtree shakeできない。

## 削減の検討

削れる可能性があるのはcross-copy interop（別copyのreadableを読むための`foreignAdapter`と、coreのforeign依存の更新処理）。見積もり（ソース文字数ベース）では、`foreign-readable-v1`の約9 kB（うちローカルreadableの登録簿は残る）と、coreのforeign関連関数・行を合わせて、`signal`のグラフ全体の2割前後。gzipでは多くても1.0〜1.3 kB程度で、ローカル登録簿を残す分、実際はそれ以下になる。

## 見送りの理由

- cross-copy interopは同期の読み取り経路にある（別copyのSignalを読む瞬間にadapterが必要）。動的importによる遅延ロードはできない。
- 分離するなら別entryへ切り出し、利用者が明示的に有効にする形になる。現在は既定で動くcross-copy互換を外すので、破壊的変更になる（v0.4以降の候補）。
- coreのforeign依存の更新処理はComputedの評価・購読経路に散在する。差し込み点を条件分岐にするとhot pathのコストと複雑さが増える。
- 削減量の上限（gzip約1 kB、約15%）に対して、契約変更とメンテナンスコストが大きい。

M14の「interop protocol lazy materialization」でprotocol生成自体は遅延済み。残る固定費は、Runtime closureの構造に由来する。

## 次に調べるなら

- cross-copyを使わない利用者向けの、明示opt-inのslim entry（別package exportまたはbuild-time flag）の契約とメンテナンスコスト。
- 実Consumer（signal-onlyではなくフレームワーク込み）での相対的な重み。React/ReactDOMだけで約140 kBあり、`signal`の6 kBは全体の数%にとどまる。
