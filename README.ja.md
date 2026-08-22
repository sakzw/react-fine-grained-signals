# react-alien-signals

[English](README.md) | [日本語](README.ja.md)

[alien-signals](https://www.npmjs.com/package/alien-signals) の実験的なReactバインディングです。小さなリアクティブプリミティブ、Reactフック、そして対象を意図的に絞ったDOMプロパティへの直接バインディング用JSXランタイムを提供します。このJSXランタイムは明示的に有効化した場合のみ使用されます。

## コアプリミティブ

```ts
import { batch, computed, effect, signal, untracked } from "react-alien-signals";

const count = signal(0);
const doubled = computed(() => count.value * 2);

const dispose = effect(() => {
  console.log(doubled.value);
});

batch(() => {
  count.value = 1;
  count.value = 2;
});

const current = untracked(() => count.value);
dispose();
```

`signal` は書き込み可能な `Signal<T>` を、`computed` は読み取り専用の `ReadonlySignal<T>` を作成します。どちらも `.value` と `.peek()` を公開します。書き込み時の同値判定には `Object.is` を使用します。effectは解除関数（disposer）を返し、effectが返したクリーンアップ関数は次回の実行前と解除時に呼び出されます。

### ディープシグナル

`deepSignal` はプレーンオブジェクトと配列にプロパティ単位の追跡を追加します。Proxyはアクセス時に遅延生成されてキャッシュされるため、別名参照や循環参照でも同一性が安定して維持されます。

```ts
import { computed, deepSignal } from "react-alien-signals";

const state = deepSignal({
  user: { profile: { name: "Alice" } },
  items: ["first"],
});
const name = computed(() => state.value.user.profile.name);

state.value.user.profile.name = "Bob";
state.value.items.push("second");
```

監視できるのは、`state.value` を経由した代入、削除、標準的な配列操作だけです。`state.peek()` は依存関係を収集せず、生のルート値を返すため、読み取り専用として扱ってください。ルートにはデータプロパティを持つ変更可能なプレーンオブジェクトまたは配列が必要です。v1では、アクセサプロパティ、プロパティ記述子やプロトタイプの変更、`freeze` / `seal` を拒否します。ネストしたプレーンオブジェクトと配列はリアクティブになりますが、クラスインスタンス、関数、`Date`、`Map`、`Set`、Promise、既存のsignalは不透明な値として扱い、`deepSignal` によるProxy化や追跡は行いません。拡張不可のオブジェクトは部分的にリアクティブにせず、拒否します。

## Reactフック

```tsx
import { useComputed, useSignal, useSignalEffect, useSignals } from "react-alien-signals";

function Counter({ step }: { step: number }) {
  useSignals();
  const count = useSignal(0);
  const scaled = useComputed(() => count.value * step, [step]);

  useSignalEffect(() => {
    console.log("count:", count.value);
  });

  return <button onClick={() => (count.value += step)}>{scaled.value}</button>;
}
```

レンダー中にsignalの `.value` を読むすべてのコンポーネントで、最初のフックとして `useSignals()` を1回、無条件に呼び出してください。引数はなく、値も返しません。このフック以降の同期的なsignal読み取りは自動収集され、そのいずれかが変わるとコンポーネントが再レンダーされます。

`useSignal` と `useDeepSignal` は、コンポーネントの生存期間中に同じsignalを保持します。生成コストが高いディープ初期値には、`useDeepSignal(() => ({ items: [] }))` のように純粋なファクトリを渡してください。`useSignals()` 以降に読んだディーププロパティは個別に追跡されるため、読んでいない隣接プロパティの変更ではコンポーネントを再レンダーしません。`useSignalValue` は低レベルな明示的リーフ購読として引き続き利用できます。プリミティブなselectorを明示したい場合は、`useDeepSignalValue(state, value => value.user.name, [])` を使用します。依存配列は必須です。各レンダーで長さと順序を固定し、selectorがクロージャから参照するsignal以外の値をすべて列挙してください。変更可能なオブジェクトやProxyをselectorが返すことは意図的に拒否します。`useSignalEffect` はコミット後にeffectを開始し、アンマウント時（Strict Modeのリプレイ時を含む）に解除します。

`useComputed` には2つのモードがあります。

- 依存配列を省略する場合、getterはsignalだけを読む必要があります。最初のクロージャがコンポーネントの生存期間中保持されるため、props、React state、その他のsignalではない値を捕捉しないでください。
- getterがsignalではない値を捕捉する場合、その値をすべて依存配列に列挙します: `useComputed(() => count.value * step, [step])`。コンポーネントの生存期間中は、どちらか一方のモードを使い続けてください。

## JSXのsignal子要素とホストバインディング

提供される自動JSXランタイムを使うようにTypeScriptを設定します。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-alien-signals"
  }
}
```

SVGのテキスト内容を含め、ネイティブホスト要素の子としてsignalを使うと、その箇所が局所的なリアクティブリーフになります。これにより親を再レンダーせずに更新できます。同じランタイムがDOMへ直接バインドできるネイティブHTML propsは次のものだけです。

- `title`、`id`、`className`、`hidden`、`disabled`
- `data-*` 属性と `aria-*` 属性

```tsx
const title = signal("Initial title");
const disabled = signal(false);

export function Field() {
  return <button title={title} disabled={disabled}>{title}</button>;
}
```

## 実験的な制約

- React 19以降が必要です。JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。
- 変換なしの `useSignals()` は管理されない簡易APIです。追跡は次の `useSignals()` 呼び出し時、または現在のmicrotask終了後に閉じられます。コンポーネントの最初のフックとして1回、無条件に呼び出し、そのレンダー中に同期的に行われるsignal読み取りだけを依存関係として利用してください。effect、イベントハンドラ、非同期callback、または所有コンポーネント自身が `useSignals()` を呼ばないrender props内の読み取りは、コンポーネントの依存関係としてサポートしません。このモードでは、Suspenseによって中断されたレンダー、レンダー中にネストして呼ぶ `renderToString` / `renderToStaticMarkup`、複数の並行rootをまたぐ厳密な分離はbest-effortです。将来ソース変換を追加することで、`try` / `finally` を使った厳密なレンダー終了境界を提供できます。
- 直接バインディングは `value`、`checked`、`style`、イベントハンドラ、SVG props、および許可リスト外のホストpropsをサポートしません。
- 直接バインディングによる書き込みはReactスケジューラの外側で行われる、実験的な最適化です。
- Reactコンポーネントのpropsや子要素へ渡したsignalはアンラップされません。直接バインディングはネイティブHTML要素にのみ適用されます。ただし、JSXランタイムが処理するsignal子要素は例外です。
- ホストpropをバインドするかどうかは、その要素の生存期間中変えないでください。通常の値とsignalを切り替えるとラッパー要素の種類が変わり、DOMサブツリーが再マウントされる可能性があります。
- SSR（サーバーサイドレンダリング）とハイドレーションでは、サーバーとクライアントのsignal初期値を同一にしてください。リクエスト固有のsignalを共有モジュールスコープへ置かず、リクエストごとに作成してください。

## 開発

Node.js 22.12以降、pnpm 11、React 19以降が必要です。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

ブラウザ向けの概念実証では、サーバーでアプリをレンダーし、React 19でハイドレーションを行い、Chromium上でsignalの直接バインディングを検証します。

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:browser
```

同じサンプルを `http://127.0.0.1:4173` で確認するには、`pnpm dev:browser` を実行してください。

## ベンチマーク

ベンチマークは手動診断用であり、CIのパフォーマンス基準ではありません。ビルド済みの出力を計測し、時間計測外で正しさを検証します。ウォームアップ後の中央値と四分位範囲を報告します。

```sh
pnpm bench
pnpm bench:deep
```

コアの結果では、生の `alien-signals`、このパッケージ、`@preact/signals-core` を比較します。数値は同じマシンとNode.jsバージョンでのみ比較してください。ホステッドCIの実行時間は変動が大きいため、信頼できる回帰しきい値には適しません。
