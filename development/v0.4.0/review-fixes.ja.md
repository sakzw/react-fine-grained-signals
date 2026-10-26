# v0.4.0 レビュー指摘の対応

- 基準: M10完了時点（`a3a75f9`）
- Opus 3本（計画の完了確認、コードの正しさ、docsとAPIの整合）の独立レビューを受けて対応した。依存ライブラリのバージョンは対象外。

## 直した不具合

1. **別コピーのsignalを`useSignalValue`に渡すと、エラーなしで更新が止まる。** `useSignalValue`がrender中に`isSignal(source)`を呼ぶようにした。別コピーのsignalでは`isSignal`が`multipleCopiesError`をthrowする。`tests/multiple-copies.test.ts`に、追跡コンポーネントと`useSignalValue`のレンダー時のテストを追加した（`renderToString`、2つの実ビルド）。
2. **v0.3のコピーがv0.4のsignalを読むと`owner.add is not a function`になる。** いったんv0.4のowner（graph・render）に`multipleCopiesError`をthrowする`add()`を持たせたが、メンテナから「v0.3ユーザーは考えなくてよい。バンドルサイズを小さくしてほしい」と指示があり、削除した（`development/v0.4.0/size-reduction.ja.md`）。v0.3とv0.4の混在は非対応で、特別な処理はしない。
   - **未対応（要判断）**: v0.3の`isSignal(v0.4のsignal)`が`true`を返す件。brandのキー（`signal.v2`）が同じためで、直すにはbrandのキーを変える必要がある。v0.3のコピーに対しては何もできず、v0.4側でbrandを新しくして旧brandを「複数コピー」として扱う案があるが、破壊的なので保留した。
3. **モードの不一致が代入時ではなく、あとの読み取り時にしか失敗しない経路があった。** `assertDeepDataGraph`が、carrierの中の他モードのproxy、`peek()`が返した生のオブジェクト、ルートの置き換えでも、代入時に`TypeError`を投げるようにした。carrierのコピーのキャッシュ（`normalizedProxyCarriers`）は、作ったモードを記録して、別のモードでは再利用しない。
4. **`DeepSignal<T>`がplain objectのルートで`Signal<T>`に代入できた。** `DeepSignal`/`DeepCollectionSignal`は`ReadonlySignal`のbrandだけを引き継ぎ、書き込み用のmarkerは持たない形にした。これで`T`によらず`Signal<T>`には代入できない。読み取り用途（`For`、`Index`、`Show`、`computed`の入力）には、これまでどおり渡せる（plain objectのルートなら`ReadonlySignal<T>`にも代入できる。配列・collectionのルートは`DeepReadonly<T>`が`T`と異なるため不可）。型テストを更新した。

## 直したその他

- `.d.ts`の末尾に残る、存在しないmapへの`sourceMappingURL`コメント: `scripts/strip-dts-sourcemap-comments.mjs`が再帰しなかったため、`dist/jsx/`以下の5ファイルに残っていた。再帰するようにして、12件すべて除去された。
- `deepSignal`だけを使うバンドルにも、`deep-collections.ts`のWeakMapのprobeが入って実行されていた。`supportsWeakSymbolKeys`を初回利用時の遅延評価にした。`scripts/check-size.mjs`に`weak-key-probe`の不在チェックを`core+hooks`と`deep`に、存在チェックを`deep-collections`に追加した。
- M1で消えていた、複数コピーと無関係な回帰テストを復元した（`tests/effect-lifecycle.test.ts`）: 自己disposeした後のreadを購読しない、間接的なcomputedの循環検出、effect内で作った内部購読の維持。加えて、`subscribeLocalReadable`の通知（成功→エラー→別のエラー→復旧）、多数のlistenerの解放、computedの分岐追従のテストを新設した。
- 意味のなかったテストを直した: `local-subscription-characterization`の「unmountで購読を解放する」は`coreRuntime.hasSubscribers`で実際に検証するようにし、検証していなかった「エラーからの復帰」は、新ファイルのテストで置き換えて削除した。

## 直したdocs

- サイズの比較: リリースノートの「`deepCollectionSignal`はv0.3より約0.5 kB大きい」は誤りで、v0.3の`deepSignal`（14.59 kB）に対して約1.2 kB小さい。「約2.7 kB小さい」は分離の寄与分で、v0.3比では14.59 → 10.10 kB（約4.5 kB）。リリースノートと移行ガイド（英日）を直した。
- 「新機能なし」の記述を、新しいAPIの列挙に直した。
- `jsx-bindings.md`（英日）の、`Signal<T>`と注釈するとbinding capabilityが失われるという古い記述を、現行仕様に直した。
- READMEのReact要件（`19 or newer` → `19.3 or newer`、英日）。
- Hookのシグネチャ: `useDeepSignalValue`が`DeepCollectionSignal`を受け付けること、`useDeepSignal`の`PlainRoot<T>`、websiteの「Keep the chosen mode」の削除、websiteのデモ名。
- `dedupe`の説明: `dedupe-peer-dependents`は設定で、実行するコマンドは`pnpm dedupe`。Rollupの`dedupe`は`@rollup/plugin-node-resolve`のオプション。移行ガイド、コアプリミティブ、global-state（英日）、packagingの設計メモ、実行時のエラーメッセージを直した。
- 移行ガイド（英日）: 削除したエラー名（`UseComputedCapabilityChangeError`）と、新しいエラー名（`UseWritableComputedDependencyLengthChangeError`）、素のJavaScriptでは`useComputed({ get, set })`が書き込み可能なcomputedを返し続けること、v0.1.xのcopyは検出されないこと、v0.3のcopyとの混在の挙動、`DeepSignal`の記述を直した。「公開契約を細くする」の言い回しを「公開APIの範囲を狭める」に変更。
- 設計メモ（`react-compiler-compatibility`、`use-signals-boundary-design`、英日）に残っていた、削除済みの`/runtime`境界への古い参照とアンカーを直した。`transform.ts`の古いコメントも直した。

## 対応しなかったもの

- マイルストーンごとのCI結果の記録（M1〜M8、M11が「push後に確認する」のまま）: 実際にはどのpushでもCIは成功している（M0の最初のpushを除く）。各マイルストーンの記録の末尾に「GitHub CI」として追記した。
- M3の`useManagedSignals`の内部保持、M8のクラスのインスタンスの扱い: 判断と理由は各記録に残してある。レビューが指摘するとおり、メンテナの個別の確認は得ていない。必要なら判断を仰ぐ（`useManagedSignals`の内部保持は、メンテナの問い合わせに対して「対応した方が良ければ」と任された上で、見送りの理由を示して残した）。
- v0.3のcopyの`isSignal`がv0.4のsignalを受け入れる件（上記）。
- `DeepReadonly<unknown>`が`{}`になる型の細部、`PlainRoot`に明示的なunion型引数を渡すと素通りする点: 影響が小さいので保留した。

## ゲート

lint、typecheck（runtime・transform・examples・website）、runtime vitest（43ファイル・935件）、transform（8ファイル・733件。1回目は負荷で既知の不安定な2件が落ちたが、該当2ファイルを単独で再実行すると61件すべて成功）、`pnpm size`（予算内、各scenarioが数十バイト増えた）、`test:consumer`、`test:browser`（1回目は52/53で1件が落ちたが、再実行で53件すべて成功）、website（build）は通過した。CIはe440c66のpushでTest、E2E、Website CIがすべて成功した。
