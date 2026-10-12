# M1 — Reactive Core review

## 結果

**完了。production code変更なし。** v0.2.1で既に受け入れられたlocal C3 graph runtimeを維持する。今回のレビューでは、既存のPhase 9/10記録を現HEADのcore/ownership/interop/cleanup回帰テストに結び付けた。新しいarchitectureやhot-path変更は、現在のデータから追加採用しない。

確認したベースラインはM0記載の `58f01b9314a1b09b88b162c57912ff736201e790`。M0文書コミット後もruntime sourceに変更はない。

## runtime判断

- 公開 `signal` / `computed` / `effect` / `batch` / `untracked` はRFSGの `coreRuntime` へ委譲する。[base.ts](../../src/core/base.ts)、[reactive-runtime.ts](../../src/core/reactive-runtime.ts)
- `createReactiveRuntime()`はRFSG graph、scheduler、ownership、render subscriptionを所有し、`alien-signals/system`を低level graph substrateとして使う。[alien-derived-runtime-core.mts](../../src/core/alien-derived-runtime-core.mts)
- 過去のPrototype A/C3 cutover記録は、固定workloadに対してsource create/read、effect、computed、fanout、batch、DeepSignal、Reactの測定を実施し、Phase 9最終matrixとallocation診断を保持している。[production migration review](../reviews/runtime-production-migration.md)、[Phase 9 M1.5.4](../phases/phase9/m1.5.4.md)
- その記録には局所的な遅いworkloadと測定ノイズも残るが、今回それを理由に別graphを再実装する再現可能な比較は得ていない。Prototype/旧benchmark harnessを製品runtimeへ戻さず、M7で同条件比較が必要な項目を再計測する。

## 回帰契約

| 領域 | 維持する意味論 | 実装・既存根拠 |
|---|---|---|
| Signal/computed | `Object.is` equality、lazy computed/cache/error、`peek()` untracked、一回の実変更ごとのrevision | [core.test.ts](../../tests/core.test.ts)、[computed-errors](../../tests/computed-errors.test.tsx) |
| Effect lifecycle | 同期初回実行、dynamic deps、cleanup順序、dispose/self-dispose、cleanup error containment | [execution-owner](../../tests/execution-owner.test.ts)、[runtime](../../tests/reactive-runtime.test.ts) |
| Batch/untracked | nested/throwing batch後のflush、revert/equality、untracked後のcollector restore | [core tests](../../tests/core.test.ts) |
| Ownership | ownerが次にrerun/disposeされた時に採用effectをdispose。flat nested behaviorと明示disposer契約 | [execution-owner.ts](../../src/core/execution-owner.ts)、[execution-owner tests](../../tests/execution-owner.test.ts) |
| Cross-copy interop | global Symbol protocol + revision、foreign readableをidentityで扱う、cross-copy batchは単一atomic transactionではない | [interop.ts](../../src/core/interop.ts)、[cross-instance](../../tests/cross-instance.test.tsx) |
| Speculative render | speculative computed/deep readsをdurable cache/subscriptionとして誤promoteしない | [render runtime](../../src/core/render-runtime.mts)、[concurrent regression tests](../../tests/core-runtime-audit-concurrent.test.tsx) |
| Subscription cleanup | last listener/effect disposal時にlistener set、外部subscription、per-key metadataを解放。listener errorで残り通知を止めない | [render tracking](../../src/core/render-tracking.ts)、[subscription path](../../tests/subscription-path.test.ts) |

現行runtime ownerはlexical frameを`finally`でrestoreし、cross-copy interop contextはglobal singletonから解決する。render listenerはlast unsubscribeでSetをundefinedに戻し、notificationはsnapshot iterationで再entrant変更を許容する。これらは最適化時に保つべき境界である。

## 今回の検証

既存の重点runtime suiteを実行した。pnpm経由はpackage-manager store lockのaccess deniedで起動できなかった。ローカルVitestはsandbox内でchild process `EPERM`となったため、同じ既存コマンドを権限付きで実行した。

- 1回目の9-file run: 6 files / 97 tests pass。3 fileのfork worker起動がtimeout。
- その3 filesを`--maxWorkers=1 --no-file-parallelism`で再実行: 3 files / 48 tests pass。
- 合計: **9 files / 145 tests pass**。Vitest最終結果はworker起動エラーなし。
- 対象: `core.test.ts`、`reactive-runtime.test.ts`、`runtime-surface.test.ts`、`cross-instance.test.tsx`、`subscription-path.test.ts`、`execution-owner.test.ts`、`interop-internals.test.ts`、`core-runtime-audit-regressions.test.tsx`、`core-runtime-audit-concurrent.test.tsx`。

このsuiteはfocused regressionであり、runtime全件、benchmark、heap profileの再実行を意味しない。

## 結論と未解決項目

- Alien low-level substrateは維持する。既存production cutoverの性能根拠を差し替える反証はなく、今回の重点回帰suiteも通過した。
- 性能が要件を満たすという新しい主張はしない。過去結果のraw dataと環境差を踏まえ、M7で固定ベースラインを同一環境・warmup・複数round・分散付きで比較する。
- M3のReact render boundary制約はcoreの不具合としてscopeを混ぜず、専用契約ゲートで扱う。
- M2のcollection version nodesは本runtimeのsource/batch/subscriber lifecycleと統合し、個別collection dependency cleanupを追加検証する。

次はM2のcollection API、型、identity、tracking粒度を設計する。設計レビュー後にruntime/deep Proxy実装を独立worktreeへ切り出す。
