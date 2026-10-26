# M1 cross-copy interopの削除と複数コピー検出

- 基準: M0完了時点（`9a68499`）
- 方針: D1（完全削除＋検出エラー）、D1b（v0.1検出とdevDependencyを削除）

## 手順1: 特性テスト

`tests/local-subscription-characterization.test.tsx`（8件）を先に追加し、削除前に通ることを確認した。公開APIだけを使い、protocolに触れない。

- `useSignalValue`: 書き込みで再renderされる／unmount後は止まる／unmountで購読が解放される／computedが同値なら再renderしない／computedの分岐切り替えに追従する／throwするcomputedはwrite時ではなくrender時にError Boundaryへ届く／エラーを挟んでも購読が続く
- JSX binding: `bindValue`が外部書き込みに追従しunmount後は止まる／computedのattributeが同値で更新されない

削除後も同じ8件が通る。

## 削除した経路

| 対象 | 内容 |
|---|---|
| `src/core/foreign-readable-v1.mts` | ファイルごと削除。bridge node、`advance`、`observeForeignRevision`、`activateForeignNode`、`publishForeignReadable`、protocol生成 |
| `src/core/interop.ts`、`interop-context.mts` | ファイルごと削除。`globalThis`上のinterop contextとprotocolのsymbol |
| `alien-derived-runtime-core.mts` | foreign関連（`updateComputed`のfinally、`readComputed`の再取得、`isComputedClean`、`promoteComputed`、`runEffect`と`effect()`の分岐、`refresh/activateForeignDependencies`、`recompute/updateForeignDependencyAncestors`、`isWatchedByEffect`、`RuntimeExternal`、stale bit 128）。getterの`isForeignOwner`分岐はthrowに置き換えた |
| `render-tracking.ts` | `ForeignRenderDependency`と`getForeign*`、`withoutInteropRenderCollector` |
| `react-adapter.mts`、`render-runtime.mts` | `isInteropProtocol`分岐。combinedモードの購読はlocal依存だけの1本になった |
| owner型 | `add`、`own`（graph owner）、`ReadableProtocolV1`を削除 |
| `deep-signal-engine.ts` | `getSharedInteropContext`の参照を外した（graphCollector/renderCollectorは常にundefinedだった） |

## 残した経路

- ローカル登録簿: `readableNodes`は`alien-derived-runtime-core.mts`の中の`WeakMap`にし、名前から`foreign`を外した。`getNodeForReadable`、`getReadableRevision`（`renderRevision`を返す）が使う。
- `globalThis`で共有する`executionContext`と`runtimeToken`（検出に使う）。
- `src/core/readable-subscription.ts`は`subscribeLocalReadable`に置き換えた。protocolの代わりに、ローカル登録簿にあるreadableだけを`detachedEffect`で購読する。登録簿にないreadableは`undefined`を返し、従来どおりeffect bridgeにfallbackする。`DeepSignalImpl`は`delegateSubscription`で内部sourceに委譲する。**手順1の「ローカル専用の軽い購読経路を残す」にあたる。** protocol版は`effect`を作らず直接購読していたため、`useSignalValue`とJSX bindingは`detachedEffect`1つ分の割り当てが増える。

## 検出

`multipleCopiesError()`（`execution-owner.ts`）が"Multiple copies of react-fine-grained-signals are loaded; install a single copy ..."をthrowする。

- 別コピーのgraph/render ownerの下でsignal・computedを読んだとき（`alien-derived-runtime-core.mts`の3つのgetter）。effectの中ならeffectのエラー報告に出る。
- `isSignal`: 自コピーの登録簿にないのに、自身のプロパティとしてbrandを持つ値。継承されたbrandは対象外。
- 検出できないもの: ownerのない状態（effect・computed・追跡コンポーネントの外）での単純な読み取り。docsに明記した。

## テスト

- 追加: `tests/multiple-copies.test.ts`（実際に2つbundleして読み込み、6件）
- 削除: `interop-internals`、`cross-copy-smoke`、`cross-copy-effects`、`phase4-duplicate-smoke`（とfixture2つ）、`mixed-version-smoke`、`cross-instance`、`core-reaudit-regressions`、`runtime-review-regressions`、`subscription-path`、`benchmarks/computed-interop-profile.mjs`
- `consumer-smoke.mjs`からcross-copy呼び出しを削除。CIの`mixed-version-smoke`ステップ、`test:phase4-duplicate`/`test:mixed-version`スクリプト、devDependencyの`react-fine-grained-signals-v0.1`（lockfileも）を削除（D1b）。
- 修正・部分削除: `core-runtime-audit-regressions`（A1・A3・A5・A6と1件）、`reactive-runtime`（foreign系28件ほど）、`core`、`deep-signal`、`post-m3-review-regressions`、`react-deep-signal`、`react-render-tracking`、`render-tracking-internals`、`runtime-surface`、`react-jsx-reaudit-regressions`、`execution-owner`。
- 件数: 42ファイル・935件（M1前の特性テスト追加後） → 41ファイル・910件。

## サイズ（`pnpm size`のVite計測、gzip）

| scenario | 前 | 後 | 差 |
|---|---:|---:|---:|
| signal-only | 6.09 kB | 4.61 kB | −1.48 kB |
| core | 6.15 | 4.67 | −1.48 |
| core+hooks | 9.86 | 8.35 | −1.51 |
| deep | 14.59 | 12.92 | −1.67 |
| index-full | 24.88 | 23.14 | −1.74 |
| jsx-runtime | 13.53 | 12.08 | −1.45 |
| lite-jsx-child | 6.99 | 5.52 | −1.47 |
| utils | 9.58 | 8.10 | −1.48 |

`scripts/size-budget.json`は`pnpm size:update`で下げた。signal-onlyは目安の約1 kB減を超えた。

## docs

`docs/guides/core-primitives.md`・`global-state.md`（英日）、`development/design/packaging.md`（英日）、`website/src/pages/core-signals.mdx`、`signal-brand.ts`のコメントを「1コピーだけをinstallする。混在はエラー」に書き換え、dedupeの案内（pnpmの`dedupe-peer-dependents`、`resolve.dedupe`）を添えた。過去のrelease notes・migration（v0.2、v0.3.0）は履歴なので変更していない。

## ゲート

lint、typecheck、runtime vitest、`test:transform`、`size`、`test:consumer`は通過。`test:browser`は53件成功（chromium、firefox、webkit）。CIは末尾の「GitHub CI」を参照。

## GitHub CI

233ad06（コード）と3f556f8（README）のpushで、どちらもTest、E2E、Website CIがすべて成功した。
