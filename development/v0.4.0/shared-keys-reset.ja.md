# copy間で共有するキーの整理（`.v2`の削除）

v0.4.0のマイルストーン後に行った変更の記録。v0.4は別のcopyとの相互運用をやめたので、世代を区別するための名前とバージョン番号は役目を終えていた。公開前に整理した（2026-10-27、メンテナ判断）。

## 経緯

レビューで「v0.3の`isSignal`がv0.4のsignalに`true`を返す」件が要判断として残っていた（[review-fixes.ja.md](./review-fixes.ja.md)）。キーを変えるとv0.4がv0.3のcopyを検出できなくなるため、いったんは据え置くと決めた。そのあとメンテナから「キーに世代を持たせる必要があるのか」と問いがあった。v0.4からは「どのreleaseのcopyでも混在はエラー」という方針なので、世代を区別する意味はない。v0.3以前のcopyの検出を手放して、名残を一度に消すことにした。

## 変更

`globalThis`の`Symbol.for`で共有するキーは3つある。すべて新しい名前にした。過去に使った名前（`.signal`、`.signal.v2`、`.readable-interop.v1`、`.shared-execution-owner.v2`、`.untracked-owner.v2`）とは重ならない。

| 用途 | 変更前 | 変更後 |
|---|---|---|
| signalのbrand | `react-fine-grained-signals.signal.v2` | `react-fine-grained-signals.brand` |
| 共有の実行コンテキスト | `react-fine-grained-signals.shared-execution-owner.v2` | `react-fine-grained-signals.execution-context` |
| untrackedのowner | `react-fine-grained-signals.untracked-owner.v2` | `react-fine-grained-signals.untracked` |

あわせて、次を削除した。

- brandの値のバージョン番号（`SIGNAL_BRAND_VERSION`、`SIGNAL_BRAND_MIN_VERSION`）。brandの値は`true`にし、`isSignal`は`brand !== true`なら`false`を返す。
- ownerと共有コンテキストの`version: 2`、型名の`V2`（`ExecutionOwnerV2`など）。
- 共有コンテキストのバージョン検査（`Incompatible RFSG shared execution owner`）と、古い形への補正（`frames ??= []`）。

## これからの約束

キーを変えると、そのreleaseと以前のreleaseが互いを検出できなくなる。そのため、次の3つは今後のreleaseで変えない。`signal-brand.ts`と`execution-owner.ts`のコメントにも書いた。

- 3つのキー
- 共有コンテキストの形（`owner`、`frames`）
- ownerの`kind`と`runtimeToken`

形を変える必要が出た場合は、キーを変えずに、古い形を読んでも`multipleCopiesError`になるようにする。

## 影響

- v0.1〜v0.3のcopyがv0.4と並んでいても、検出されない。互いのsignalをただのオブジェクトとして扱う。v0.3とv0.4の混在はもともと非対応で、メンテナの方針（「v0.3ユーザーは考えなくてよい」）にも合う。docs（`core-primitives`英日、移行ガイド英日、リリースノート）に、検出はv0.4以降のcopyだけが対象だと書いた。
- v0.4同士の検出は変わらない（`tests/multiple-copies.test.ts`は実ビルド2つで確認している）。

## テスト

- `tests/core.test.ts`: brandの値を`true`に変更。v0.1のキーだけを見ていたテストを、旧キー2つ（`.signal`、`.signal.v2`）を認識せず、v0.4のsignalも旧キーを持たないことの確認に置き換えた。バージョン番号のテストは「値が`true`でないbrandは認識しない」に変えた。
- `tests/deep-signal.test.ts`、`tests/execution-owner.test.ts`、`tests/render-tracking-internals.test.ts`: 新しいキー・値・型名に合わせた。

## ゲート

すべて成功した（2026-10-27）。

- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:consumer`
- `pnpm exec vitest run --maxWorkers=2`: 43ファイル、935件
- `pnpm test:transform`: 8ファイル、734件（既定の並列数では、esbuildのビルドテスト1件が5秒でtimeoutした。`--maxWorkers=2`と単独実行では通る。今回の変更はtransformの経路に関係しない）
- `pnpm size`: signal-only 4.45→4.39 kB、deep 9.95→9.88 kBなど、各scenarioで約0.05〜0.08 kB減った。予算は据え置いた（下げ幅が小さいため）
- `pnpm test:browser`: 1回目はFirefoxの2件が失敗した（全体が6.4分かかる高負荷の状態だった）。Firefoxだけを再実行すると14件すべて通った
