# M0 — v0.3.0 アーキテクチャ・契約レビュー

## 結論

M0は**調査完了**。v0.2.1に対するコード変更やテスト実行は行っていない。確認した既存仕様と問題を後続マイルストーンの受け入れ条件へ引き継ぐ。

- 現行のcore backendは `alien-signals@3.2.1` のまま維持する。アーキテクチャ変更は契約上の必要性と正確性・性能・メモリ・サイズの比較が揃った場合に限る。
- `deepSignal` はplain object/arrayの細粒度追跡を維持し、Map/Set/WeakMap/WeakSet対応は互換性を考慮した**明示的なcollection reactive opt-in**として設計する。既定動作を一律に可変collectionへ変更しない。M2開始時にAPI名、型、nested/root両方の意味論を確定する。
- Reactの厳密なrender trackingは `managed` を `inject` に置き換えて解決扱いにしない。現行managedの厳密性とReact Hooks/Fast Refresh/Compiler制約を同時に解ける設計をM3の必須ゲートとする。
- M1、M2、およびM3の基礎調査は並行可能。M4実装はM3契約後。M5の静的検出調査、M6のDOM semantics調査、M7のbaseline収集は一部先行可能。

collection opt-inを選んだのは、現在 `deepSignal` 内のMap/Set mutatorがthrowする契約を壊さず、要求されたroot/nested collection機能の追加経路を設けられるため。既定挙動変更とのA/Bを判断補助CLIにも照会したところ、明示opt-in案が74.47%、標準動作を変更する案が25.53%だった。Clefのconfidenceは0.2395と低く、これは参考情報にとどめた。採用理由はAPI互換性と移行を明示できる点であり、確率値ではない。

## ベースラインと参照

| 項目 | 確認結果 |
|---|---|
| 作業開始時のbranch / HEAD | `main` / `58f01b9314a1b09b88b162c57912ff736201e790` |
| 作業開始時のgit status | clean |
| package version | `0.2.1` (`package.json`) |
| clone内のtag | `v0.1.0`, `v0.1.1`, `v0.2.0`。`v0.2.1` tagは存在せず、HEADはv0.2.1 release notes後の最終記録commit |
| 統合branch | `codex/v0.3.0-m0` |
| Vue 3.6参照 | `v3.6.0-rc.11`, `b55f3b92a185e87680ca7f69252451964be08b00` |

2026-10-13時点のVue公式Release一覧ではv3.6.0-rc.11が最新3.6 release candidateで、安定版ではない。タグを固定し、`main`やVue 3.5以前のコードを3.6として扱わない。

- [Vue v3.6.0-rc.11 release](https://github.com/vuejs/core/releases/tag/v3.6.0-rc.11)
- [Vue collectionHandlers.ts at the pinned tag](https://github.com/vuejs/core/blob/v3.6.0-rc.11/packages/reactivity/src/collectionHandlers.ts)
- [Vue reactive.ts at the pinned tag](https://github.com/vuejs/core/blob/v3.6.0-rc.11/packages/reactivity/src/reactive.ts)
- 対象spec: 同タグの `packages/reactivity/__tests__/collections/{Map,Set,WeakMap,WeakSet}.spec.ts`

## 現行の公開契約

### Coreとinterop

- `signal` / `computed` は `.value` / `.peek()` を持つ。`effect` は同期初回実行、cleanup、owner由来のdispose契約がある。`batch`は通知をまとめ、`untracked`は依存収集を止める。[core primitives](../../docs/guides/core-primitives.md)、[core API](../../src/core/base.ts)
- high-level semanticsとReact adapterはRFSG側、low-level graphは `alien-signals@3.2.1`。この境界は既存設計方針。[runtime architecture](../reviews/runtime-architecture.md)、[runtime](../../src/core/reactive-runtime.ts)
- 複数package copy間のsignal/readable interop、effect ownership、cleanup、speculative render時のread handlingが契約。copies間でbatchが単一atomic transactionになる保証はない。[interop](../../src/core/interop.ts)、[execution owner](../../src/core/execution-owner.ts)

### Deep reactivityとcollection

- `deepSignal` rootはplain object/arrayだけ。nested plain object/arrayはlazy cached Proxyでproperty/existence/iterationを追跡する。raw参照への書き込みは追跡しない。accessor propertyとnon-extensible objectなどサポート外条件は明示的に拒否する。[deep-signal.ts](../../src/core/deep-signal.ts)、[engine](../../src/core/deep-signal-engine.ts)
- nested Map/Setは**opaqueかつread-only view**。viewのidentityはcacheされ、mutatorはthrowし、immutable replacementを要求する。Map/Set entry内のobjectもopaque。WeakMap/WeakSetはproxyもiterationもせず、opaque valueとして扱う。`.peek()`や元raw referenceからのmutationは通知を回避する。
- public TypeScript surfaceはMap/Setのmutable型を維持している一方、`.value`からのruntime mutatorはthrowする。この差は現行制約であり、M2の型設計・migration判断に含める。
- 既存のalias/cycle、proxy normalization、opaque境界、配列mutator untracked/batch、per-property metadata cleanupはM2でも保つ。[deep-signal tests](../../tests/deep-signal.test.ts)

### React trackingとtransform

- `useSignalValue`やJSX host bindingは対象を絞ったsubscription。`useSignalTracking()`と`inject`はbest-effort。`managed`と手動 `useManagedSignals()` は同期 `try/finally` による厳密なlexical scopeが契約。[boundary design](../design/use-signals-boundary-design.md)
- managed transformはcomponent bodyを`try/finally`内に動かし、その内側にuser hooksを置く。これがHooks規則と構造的に衝突し、Vite 8/Oxc Fast RefreshではHook追加/削除/順序変更のsignatureを扱えない。通常のReact `try/finally` controlでも再現される。[root cause](../phases/phase10/fast-refresh-root-cause.md)、[Fast Refresh harness](../phases/phase10/fast-refresh-harness/README.md)
- React Compilerはsignal readのmemoizationとmanaged構文に別の制約がある。`"use no memo"`はCompiler bailoutを補う既存手段だが、managed構文の問題まで解消しない。[Compiler design](../design/react-compiler-compatibility.md)
- StrictMode、Suspense throw/cleanup、SSR/hydrationの既存テストはある。一方、Concurrent testはmid-fiber yield/torn frameを再現しない。RSCは保証されず、transformがServer Componentを誤ってHook化しない安全策が必要。

## Vue 3.6との具体的な差分

Vue RC11はcollection種別ごとのhandlersを使い、Map/Set/WeakMap/WeakSetをreactive targetとして扱う。RFSGへ機械移植しない。Vueのreactive collectionはmutating methodをProxy経由で許可し、Vueのraw/readonly flagsとdependency runtimeに依存する。RFSG現行nested collectionはread-only replacement契約で、runtime adapter・batch・speculative ownerと接続する必要がある。

移せる設計概念:

- collectionごとのmethod instrumentationと、native internal-slotを満たすreceiver処理。
- raw/proxy key正規化、raw graphへproxyを残さない運用、raw/proxy identityテスト。
- keyごとの `get`/`has` と、Map key iteration / value-entry iteration / sizeのdependency分離。
- `set`同値、既存keyの値更新、存在しないkeyのdelete、重複Set追加、clearの不要通知を区別するtrigger matrix。
- WeakMap/WeakSetをkey単位で追跡し、列挙・size・clearを導入しない。弱参照を保持する補助Mapを追加しない。

Vue semanticsと別に定義する点:

- opt-inが有効なcollectionのmutation APIと戻り値。既定readonly viewのthrow契約。
- Map/Set/WeakMap/WeakSet内のnested plain objectをいつproxy化し、値読み/iteration/getでどのidentityを返すか。
- weak collectionはentryを全走査できない。完全な初期graph validationやnested proxy exclusionをどう保証するか。
- `Map.keys()`とvalues/entries/forEach/size、Set iteration/size、Weak key reads、`clear()`が依存する範囲。
- batch/untracked/speculative readsとeffect subscription cleanupのruntime integration。

## 変更しない・変更候補

### 維持する契約

- alien-signals backend、signal `.value` / `.peek()`基本形、cross-copy interop、effect ownership/cleanup。
- deepSignal plain object/array modeのproperty-level behavior、root-only readとdeep readの区別。
- 既定modeでのMap/Set opaque read-only view。opt-inの追加後もexisting default behaviorを保持する。
- best-effort trackingをexact trackingと表現しない。strict render scopeはReact integrationの前提をM3で再確認する。

### additiveとして設計する候補

- `deepSignal(value, { collections: "reactive" })` 相当の明示的mode。plain object/array内部にあるMap/Set/WeakMap/WeakSetとcollection rootをproxy化・追跡する。正確なoption名や型はM2で確定し、ここでは確定APIとしては扱わない。
- iteration/dependency cleanupのcollection向け拡張、追加の診断、明確なRSC除外・報告。

### breakingまたは移行説明が必要な候補

- Map/Set mutatorがthrowから成功へ変わる既定動作変更。M0では避け、必要性が実証された場合は明示migrationを要求する。
- `DeepSignal<T>`のroot/value型をcollection semanticsに合わせて広げること、またはMap/Set readonly mismatchを型上で修正すること。
- React tracking boundaryのpublic/runtime契約変更、signal interop protocolやbrand version変更。

M0時点では、必須のbreaking changeは確定していない。各候補はM1〜M6の具体設計とconsumer影響が分かってから、minor内で安全に扱えるかを判定する。

## blocker・制約・受け入れ条件

### M3 blocker

現在の選択肢には、厳密scopeを保つとHookが`try`内に入り、Hook配置を回避すると同期finally cleanupとaborted renderの厳密性が失われるという衝突がある。`managed`→`inject`はbest-effortへ契約を変えるだけである。解決案はrender attemptの依存収集、commit時だけの購読promote、throw/Suspense abort時のcleanup、sibling isolationを示し、実Fast RefreshとReact Hook/Compiler検証を通す。安全な案がないなら公開契約を明示的に再設計する。現時点ではM3解決済みとは扱わない。

### Performance baseline

- v0.2.1基準commitは上表のSHAで固定する。
- Phase 9/10にcore runtime、deep signal、React、transform、package sizeの既存bench/harnessがある。[benchmarks](../../benchmarks/README.md)、[phase 9 records](../phases/phase9/README.md)、[v0.2.1 qualification](../phases/phase10/qualification.md)
- 過去のarchitecture prototypesと少数JSX計測にはrun間ばらつきや不確定結果がある。M7で同じ環境・反復・warmupを揃え、平均だけでなく分散を記録する。ベースライン再取得は実装に影響させずM1開始時から準備する。

### M0完了条件

- ベースラインcommit・タグの欠落・Vue参照タグ/SHAを固定。
- 現行public contract、React/Vueとの設計差、known limitations、performance evidenceを棚卸し。
- M1〜M8の依存関係、API互換方針、M3 blocker、M2 collection contract gateを記録。
- 次に実行する作業をroadmapに指定。

すべてを満たしたのでM0を完了とする。M2の詳細dependency matrix、M3の解法、M7の新計測値はそれぞれのマイルストーンで決定するため、M0の完了はそれらを既に解決したという意味ではない。
