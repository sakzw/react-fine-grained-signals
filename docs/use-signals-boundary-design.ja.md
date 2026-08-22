# 変換なしの `useSignals()` 境界に関する設計検討

[English](use-signals-boundary-design.md) | [日本語](use-signals-boundary-design.ja.md)

状態: 設計検討中。APIや実装方針はまだ決定していません。

## 背景

変換なしの `useSignals()` を呼ぶとrender collectorが開き、それ以降の同期的なsignal読み取りを記録します。runtimeは、次の `useSignals()` が呼ばれた時点、または現在のmicrotask終了時にcollectorを閉じます。この仕組みは、明示的でpluginを必要としないAPIを維持できます。一方、Reactは通常のfunction component呼び出しが終了した瞬間を通知するcallbackを公開していません。

そのため、先にrenderされたcomponentのcollectorが開いたまま、`useSignals()` を呼ばない兄弟や子孫componentがsignalを読む場合があります。その読み取りは誤ったcomponentに紐付く可能性があります。signalを更新するとcollectorの所有者だけが再レンダーされ、実際に値を表示したcomponentが古い表示のまま残り得ます。Suspenseで中断されたrender、render中のネストしたserver rendering、複数の並行rootでも、同種の所有権の曖昧さが発生します。

したがって、現行動作は厳密なcomponent境界ではなく、**best-effort**です。render中にsignalを読む各component自身が `useSignals()` を呼ぶ必要があります。build時の変換を許容できる場合、既存のmanaged transformは字句的に厳密な `try` / `finally` 境界を提供できます。

## 将来の判断で達成したいこと

- このライブラリを作る動機になった、先頭で `useSignals()` を呼ぶ書き味を維持する。
- signal読み取りが誤ったcomponentへ静かに紐付くことを防ぐ。
- React 19のStrict Mode、Suspense中断、SSR、hydration、並行rootで正しく動作する。
- Hookの呼び出し順を守り、render中のstate更新を避ける。
- 処理コストと必要なbuild integrationを明示する。

## 非目標

- Reactのcomponent treeやschedulerを置き換えること。
- effect、event handler、非同期callback内の読み取りをrender依存関係にすること。
- 任意のcomponent propsやchildrenを自動的にunwrapすること。
- 正確性と互換性のtestを用意する前に、このdocsだけで実装を決定すること。

## 評価する選択肢

### 1. 変換なしの `useSignals()` をbest-effortのまま維持する

現行runtimeと説明を維持し、厳密な動作にはmanaged transformを使います。

利点は、buildが不要でAPI変更もなく、明示的な呼び出しを残せることです。欠点は、`useSignals()` を呼ばないrender処理がsignalを読むと、誤った所有者へ紐付く可能性が残ることです。第三者componentや呼び忘れを文書だけで防ぐことはできません。

### 2. managed transformを推奨する厳密な経路にする

source上の `useSignals()` 呼び出しは維持しながら、opt-inしたcomponentを厳密な `try` / `finally` scopeへ変換します。危険性を理解した利用者向けに、best-effort動作を任意で残すこともできます。

利点は、source上の書き味を保ちながら字句的な所有権を得られることです。欠点は、build integrationが必要で、あらゆるcomponent形式を安全に処理しなければならず、transformの保守コストも増えることです。

### 3. 明示的なcomponent wrapperを導入する

`withSignals(Component)` のようなAPIを提供し、ライブラリが制御するwrapperからcomponent呼び出しの境界を所有します。

利点はcompilerが不要で、境界が明示的になることです。欠点は書き方が変わり、component identityや型に影響することです。ref、memo化、display name、server component、static propertyも検証する必要があります。

### 4. Reactが公式に提供する外部契約を利用する

変換やwrapperを使わずにcomponent単位のrender期間を取得できる、現在または将来のReact APIがあるか調査します。

利点は、独自の制御フローを減らしながら厳密な所有権を得られる可能性があることです。欠点は、React 19に適切な安定版の契約が現在見つかっていないことです。React internalsへの依存は採用しません。

### 5. 変換なしのAPIを限定または置換する

変換なしの `useSignals()` に対する厳密性の主張を廃止し、正確性が必要な利用者を、明示的なleaf購読、JSX host binding、またはmanaged transformへ案内します。

利点は、保証内容が正確になり、曖昧な仕組みを減らせることです。欠点は、ライブライブラリとしての体験を弱める大きなproduct/API判断になることです。

## 判断基準

採用する設計には、少なくとも次の実行可能なtestが必要です。

- 一方だけが `useSignals()` を呼ぶ隣接した兄弟component。
- opt-in状態が異なるnested componentとrender props。
- Strict Modeの再実行とcleanup。
- 完了前にsuspendまたはthrowするrender。
- render中にネストして呼ぶ `renderToString` / `renderToStaticMarkup`。
- 複数の並行rootと交互に発生する更新。
- SSR後のhydration。
- wrapperを使う場合のcomponent identity、ref、memo化。
- build時の管理を使う場合のtransform対象範囲と冪等性。

さらに、bundle size、renderごとのoverhead、source mapとdebugging品質、bundler対応範囲、migrationコストを比較します。静かな誤帰属を単に発生頻度の低い経路へ移すだけの解決策は採用しません。

## 現在の推奨

方針を決定するまでは、変換なしの `useSignals()` と `transform: "inject"` を、signalを読むすべてのcomponentがopt-inする同期render向けの、plugin不要なbest-effort機能として扱います。厳密なrender境界が必要な場合は `transform: "managed"` を使います。この説明は現在の制約を記録するものであり、設計課題を終了させたり、兄弟componentの誤帰属を正しい動作として再定義したりするものではありません。
