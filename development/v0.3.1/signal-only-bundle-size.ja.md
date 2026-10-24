# `signal`単体のバンドルサイズ

状態: 調査のみ。実装・PoCは見送り。計測日 2026-10-24、基準 `main` / `34e4912`。

## 現状

`import { signal } from "react-fine-grained-signals"`だけのConsumer（`scripts/check-size.mjs`の`signal-only`）は、raw 22,153 B / gzip 6,239 B / brotli 5,644 B。v0.2時代の記録（gzip 5.8〜5.9 kB）からほぼ横ばいで、M18.9の遅延初期化で約1.27 kB減らした後の値である。`index-full`はv0.2の11.4 kBから25.5 kBへ増えたが、増分はJSX Runtime、deep、form bindingで、`signal`単体は増えていない。

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
