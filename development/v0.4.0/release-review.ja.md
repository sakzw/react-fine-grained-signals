# v0.4.0 リリース前レビューの対応

- 基準: `991c445`
- 3本の独立レビュー（コアのcomputedの寿命、React・JSX層、docsとコードの整合）を受けて対応した。pluginのtransform本体は、2026-11-03までのレビューで見ているので対象外にした。

## 直した不具合

1. **3段以上のcomputedのチェーンで、購読しても書き込みが届かなくなる（`1847c16`の回帰、`486a5b8`）。** `attachComputed`は、購読者を失ってdirtyのままdetachしていた依存をリンクしたとき、自分を`Pending`にするが、戻り値は「最新」のままだった。そのため、その上のcomputedはcleanのまま確認せず、末端のgetterは実行されず、sourceへのリンクができなかった。`Pending`になったcomputedは「最新ではない」と返すようにした。2段のチェーンは、attachした読み取りが自分で確認するので起きない。Reactでは、チェーンの下を読むコンポーネントのアンマウントと、上を読むコンポーネントの購読が、書き込みを挟まずに続くと起きる。`tests/unsubscribed-computed.test.tsx`に、コアとReactのテストを1件ずつ追加した。
2. **追跡コンポーネントの依存集合が変わると、読み続けているcomputedが再計算される（`649f612`）。** `RenderStore.commit`は、全部を購読解除してから購読し直していた。その間にcomputedは最後の購読者を失ってdirtyになり、何も書かれていないのにgetterが再実行された。新しいobjectや配列を返すcomputedは変化して見えるので、コンポーネントがもう1回レンダーされた。依存集合がレンダーごとに変わる場合（毎回作り直されるcomputedなど）は終わらず、Reactの`Maximum update depth exceeded`になった。先に購読し、そのあとで前の購読を外す順にした。`useSignalTracking()`とpluginの`useSignalCapture()`の両方に効く。`tests/react-render-tracking.test.tsx`に2件追加した。解除してから購読する順序はv0.3.0も同じ。

追加した4件は、修正を外すとすべて失敗する。

## 見送ったもの（メンテナ判断、2026-11-19）

- **getterの中でeffectを作る、またはsignalに書くcomputedに購読者が2つ以上あると、2つ目以降に通知されない。** effectの`checkDirty`の途中でgetterが再実行され、その中の`effect()`が入れ子の`flush`を呼び、ほかの購読者の`Pending`を落とす。v0.3.0から同じ。`runEffect`の`checkDirty`を`batchDepth`で囲む案がある（scratchでだけ確認）。
- **Fast Refreshで、Hookの依存配列の長さを変える編集をするとエラーになる。** 長さを`useRef`に持っていて、Fast Refreshがそれを保持する。開発時だけで、v0.3.0から同じ。

## 直していない指摘

- バインドしたcomputedがエラーの間に親が再レンダーされると、renderからthrowする（`docs/guides/jsx-bindings.md`の「Error Boundaryは関与しない」と合わない）。
- `ref(null)`で解除する古い方式でrefを合成するwrapperの下では、バインドがアンマウント後も解除されない。
- 購読者なしで一度読んだcomputedは、購読時にgetterを再実行しないので、getterの中で作るeffectが購読中に存在しない。
- 実行中のcomputedをattachする循環（getter Aの中のeffectが、Aに依存するBを読む）で、古い値とリンクが残る。
- `className`のsignalが`null`のとき`class=""`が残る（Reactは属性を消す）。
- `/utils`の`ForCollection`がガイドにない。ガイドのシグネチャに出る`PlainRoot<T>`はexportしていない。

## docs

- サイズの値を`pnpm size`の現在値に直した（release notes、migration guide、JSXのガイド、website）。signal-only 4.47、deep 10.42、deep-collections 13.36、main entry 15.83、Full JSX 11.21、Lite 5.51 kB（このあとのコアの重複の整理、全scenarioで約0.07 kB減、を含む）。
- websiteの`deepSignal`の説明（collectionを追跡すると書いていた）、診断の表（RFGS010の追加、RFGS004の文面）、async関数の説明を直した。
- release notesのFixedに、styleのbooleanと`""`でのクリア、生成するHook importの名前（Fast Refresh）、`/rollup`の型を足した。
- 日本語版に欠けていた、`docs/guides/hooks.ja.md`のcapture scopeの段落と、plugin READMEのaliasの行を足した。
- `examples/react-router/vite.config.ts`のコメントを、現在の出力（`try/finally`なし）と`ActivityRow.tsx`の実装に合わせた。

## ゲート

lint、fmt:check、typecheck、runtime vitest（`--maxWorkers=2`、46ファイル・982件）、transform（12ファイル・2119件）、build、size（予算内、signal-onlyが+0.01 kB）、consumerが通った。`test:browser`とベンチはローカルでは実行していない。
