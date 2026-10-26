# バンドルサイズの追加削減

- 基準: レビュー対応後（`e440c66`）
- 指示: 「v0.3ユーザーのことは考えなくていいから、バンドルサイズが小さくなるようにして」

## 方針

まず内訳を調べた（unminifiedのバンドルを関数ごとに数え、最小化後の文字列リテラルをASTで集計）。

- 文字列（エラーメッセージなど）は全体の1割以下（`signal-only`で約0.3 kB、`jsx-runtime`で約1.3 kB）で、削減の主戦場はコード。
- `signal-only`の大半は`createAlienDerivedRuntime`（約630行）とalien-signalsの`createReactiveSystem`（約165行）。`core+hooks`の追加分は、render adapter（約240行）とreact adapter（約180行）、capture用の反復ヘルパー（約100行）。
- JSXランタイムの追加分（約1,400行）は機能そのもので、削れる死んだコードは見つからなかった。

## 実施した削減（挙動は変えない）

1. **v0.3互換のための`add()`を撤去**: レビュー対応で足した、v0.3のコピーが呼ぶ`owner.add`の受け皿を削除した。v0.3の混在は非対応とした。
2. **コアの未使用コードの削除**: コアが返していて外から使われていなかった`isSignal`・`SIGNAL_BRAND`・`hasBrandAndPeek`、`subscribeReadables`、`withRenderAttempt`、`getRenderVersion`を削除した。
3. **重複の統合**: `DeepSignalRuntimeSource`クラスは`HelperBrandSignal`とgetterが同一だったので、`HelperBrandSignal`に`deep`フラグを足して1つにした。同一だった`createDeepSignal`と`createDeepSignalVersion`も1つにした。
4. **react adapterの死んだ部分の削除**（本番では使われず、テストからのみ使われていたもの）: アダプタ版の`useSignalValue`と`snapshot()`、`per-readable`モード（`SubscriptionMode`と`RenderStore`の分岐）、`managed()`、render adapterの`captureRenderSnapshot`。`RenderStore`の購読は`Map`から単一の`#unsubscribe`にした。関連するテスト（`per-readable`の2件、不明なモードの検査、`managed`、`captureRenderSnapshot`）は、その死んだコードを検証していたので削除・書き換えた。
5. **capture用の反復ヘルパーを分離**: `captureIteration`、`captureForIn`、`CapturedIteratorResult`、`NATIVE_ITERATOR_NEXT`（約100行）を`src/react/capture-iteration.ts`に移し、`useSignalCapture`（`/internal`、プラグインの生成コードだけが使う）の中でだけ参照するようにした。プラグインを使わないアプリには入らなくなった。

## 結果（`pnpm size`、gzip）

| scenario | 削減前 | 削減後 | 差 |
|---|---:|---:|---:|
| signal-only | 4.63 kB | 4.45 kB | −0.18 |
| core | 4.69 kB | 4.50 kB | −0.19 |
| core+hooks | 8.23 kB | 7.30 kB | **−0.93（−11%）** |
| deep | 10.12 kB | 9.95 kB | −0.17 |
| deep-collections | 13.45 kB | 13.28 kB | −0.17 |
| index-full | 16.83 kB | 15.94 kB | −0.89 |
| jsx-runtime | 12.07 kB | 11.90 kB | −0.17 |
| lite-jsx-child | 5.49 kB | 5.32 kB | −0.17 |
| utils | 8.13 kB | 7.21 kB | **−0.92（−11%）** |

予算は`pnpm size:update`で下げた（すべて減少）。`index-full`の予算も、増加を伴わないので下げてよい。

## 試して見送ったもの・今後の候補

- **コアからdeep用・render用のコードを切り出す**: `signal-only`・`core`だけを使うアプリ向けに、約150行（推定0.5〜0.9 kB）を別moduleに分けられる。ただしReact利用者のバンドルには入るので、効果は非React利用に限られる。コアのクロージャとの絡みが強く、リスクに見合わないと判断して見送った。
- **エラーメッセージの本番での短縮**（`process.env.NODE_ENV`による分岐）: 文字列は全体の1割以下で、効果が小さく、テストとdocsのメッセージ検査に影響するため見送った。
- **JSXの要素名リスト**（`SVG_ELEMENTS`など）の表現変更: 型にも使われており、効果が小さい（推定0.1 kB以下）ので見送った。

## ゲート

lint、typecheck（runtime・transform・examples・website）、runtime vitest（43ファイル・931件）、transform（8ファイル・733件）、`pnpm size`（予算を下げた）、`test:consumer`、`test:browser`（53件）、website（build）は通過した。CIは2071784のpushでTest、E2E、Website CIがすべて成功した。
