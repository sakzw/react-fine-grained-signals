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

`useSignal` と `useDeepSignal` は、コンポーネントの生存期間中に同じsignalを保持します。生成コストが高いディープ初期値には、`useDeepSignal(() => ({ items: [] }))` のように純粋なファクトリを渡してください。`useSignalEffect` はコミット後にeffectを開始し、アンマウント時（Strict Modeのリプレイ時を含む）に解除します。

`useComputed` には2つのモードがあります。

- 依存配列を省略する場合、getterはsignalだけを読む必要があります。最初のクロージャがコンポーネントの生存期間中保持されるため、props、React state、その他のsignalではない値を捕捉しないでください。
- getterがsignalではない値を捕捉する場合、その値をすべて依存配列に列挙します: `useComputed(() => count.value * step, [step])`。コンポーネントの生存期間中は、どちらか一方のモードを使い続けてください。

## 描画最適化

このライブラリには、目的の異なる二つの最適化経路があります。通常は**pluginなし**で始められます。`unplugin` は `useSignals()` の書き方を保ったまま自動挿入したい場合に追加し、厳密な追跡境界は必要なときだけ上級オプションで有効にします。

| 選択肢 | 更新時に起こること | 向いている場面 |
| --- | --- | --- |
| `useSignals()`（pluginなし） | 読んだsignalが変わったコンポーネントだけをReactが再レンダーする | 明示的でVueに近い書き味を保ちたい通常のコンポーネント |
| JSX signal子要素／許可済みhost prop（pluginなし） | 親を再レンダーせず、該当DOMリーフだけを書き換える | テキスト、`title`、`data-*` など頻繁に変わる小さな表示 |
| `unplugin-react-alien-signals` | 既定では `useSignals()` を自動挿入し、必要なら厳密なレンダー境界も使える | 大規模コードベースで手動呼び出しを減らす、Suspense境界を厳密にする場合 |

### Pluginなし: `useSignals()` によるコンポーネント単位の追跡

レンダー中にsignalの `.value` を読むコンポーネントで、最初のフックとして `useSignals()` を1回、無条件に呼び出してください。引数はなく、値も返しません。このフック以降の同期的なsignal読み取りが収集され、そのいずれかが変わったときだけ、そのコンポーネントをReactが再レンダーします。読まなかったsignalや、`deepSignal` の読まなかった隣接プロパティの変更では再レンダーしません。

これは `useSignalValue` を各値に置く方式ではなく、コンポーネントのレンダーで読んだ依存関係をまとめて追跡する、基本のライブライブラリ向けAPIです。`useSignalValue` は既存の小さなリーフを明示的に分離したい場合の低レベルAPIとして利用できます。プリミティブなselectorを明示したい場合は `useDeepSignalValue(state, value => value.user.name, [])` を使用します。依存配列は必須です。各レンダーで長さと順序を固定し、selectorがクロージャから参照するsignal以外の値をすべて列挙してください。変更可能なオブジェクトやProxyをselectorが返すことは意図的に拒否します。

変換なしの `useSignals()` は依存関係を収集する簡易的な境界です。追跡は次の `useSignals()` 呼び出し時、または現在のmicrotask終了後に閉じられます。同期的なrender読み取りだけに使えば、追加のビルドpluginなしで利用できます。Suspense中断や複数rootをまたぐ厳密な境界が必要な場合は、後述のpluginを使ってください。

### Pluginなし: JSXのsignal子要素とhost bindingによるDOMリーフ更新

提供される自動JSXランタイムを使うようにTypeScriptを設定します。これはbundler pluginを必要としません。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-alien-signals"
  }
}
```

SVGのテキスト内容を含め、ネイティブホスト要素の子としてsignalを使うと、その箇所が局所的なリアクティブリーフになります。signalが変わっても親コンポーネントは再レンダーされず、ランタイムがそのDOMノードだけを更新します。同じランタイムがDOMへ直接バインドできるネイティブHTML propsは次のものだけです。

- `title`、`id`、`className`、`hidden`、`disabled`
- `data-*` 属性と `aria-*` 属性

```tsx
const title = signal("Initial title");
const disabled = signal(false);

export function Field() {
  return <button title={title} disabled={disabled}>{title}</button>;
}
```

これは最も細かい描画最適化ですが、対応するのはネイティブ要素のsignal子要素と上記の許可済みpropsだけです。Reactコンポーネントのpropsや子要素にsignalを渡してもアンラップされません。

### Pluginあり: `useSignals()` の自動挿入

任意で導入できる汎用ビルドpluginは、Babel設定を利用者に要求せず、bundler向けのintegrationだけを設定します。既定では対象の関数を検出し、最初のフックとして通常の `useSignals()` を挿入するだけです。制御フローを書き換えず、手書きの `useSignals()` と同じbest-effortな追跡境界を使えます。JSXランタイムのネイティブリーフ更新はpluginと独立して動作します。

pluginは、signalの変化をReactの再レンダーなしにするものではありません。`useSignals()` で読んだ値の変化は引き続きコンポーネントの再レンダーを起こします。親の再レンダーまで避けたい小さな表示は、上のJSX signal子要素／host bindingを使います。pluginの既定の役割はモードに応じて `useSignals()` 呼び出しを挿入することで、厳密な追跡範囲は `transform: "managed"` を選んだときだけ使います。

```sh
# 将来のパッケージ名です。まだnpmには公開していません。
pnpm add -D unplugin-react-alien-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

同じパッケージは `/rollup`、`/webpack`、`/rspack`、`/esbuild` のentry pointも提供します。ESM-onlyのため、bundler設定ではCommonJSの `require()` ではなく `import` を使ってください。現在はprivateなworkspace packageであり、npmには公開していません。導入・設定例は将来の公開APIを示すものです。

`mode` でコンポーネントを追跡対象にする方法を選びます。

- `"manual"`: 先頭文にあるimport済みの `useSignals()`、または `@useSignals` を付けた名前付きコンポーネント／custom hookだけを変換します。明示的なライブライブラリの書き味を維持します。
- `"auto"`（既定）: さらに `.value` を読む名前付きJSXコンポーネントと、`.value` を読む名前付き `useX` custom hookを変換します。
- `"all"`: さらにすべての名前付きJSXコンポーネントを変換します。静的検出から隠れるrender propやgetterがある場合に使います。

`transform` で、対象にした関数の生成方法を選びます。

- `"inject"`（既定）: `react-alien-signals` から通常の `useSignals` をimportし、最初のフックとして呼び出しを挿入します。`try` / `finally` を出力せず、既存の制御フローも書き換えません。
- `"managed"`: `react-alien-signals/runtime` からimportし、厳密な `try` / `finally` スコープを出力します。Suspenseで中断されたレンダー、レンダー中のネストしたSSR、複数の並行rootをまたぐ正確な分離が必要な場合だけ選んでください。

```ts
// 厳密な管理境界が必要な箇所だけ、明示的に選びます。
signals({ mode: "auto", transform: "managed" });
```

`@noUseSignals` は常に変換を無効にします。自動モードは宣言形式、arrow形式、`memo` / `forwardRef` で包んだ名前付きコンポーネントを対象にします。class component、匿名default export、すでに変換済みのJSX、async/generator関数、namespace import、先頭以外または条件付きの `useSignals()` を持つコンポーネントは変更しません。`.value` 判定は意図的にheuristicなので、`mode: "auto"` はsignalではないオブジェクトにも無害な購読を追加する場合があります。

## JSX制御フローユーティリティ

`react-alien-signals/utils` は、Solidの `Show`、`Switch` / `Match`、`For` に着想を得た小さなReactコンポーネントを提供します。任意のサブパスであり、build pluginも独自JSXランタイムも必要ありません。条件または配列入力にsignalを渡すと、ユーティリティ自身がリアクティブ境界になるため、更新時に親コンポーネントを再レンダーしません。

```tsx
import { signal } from "react-alien-signals";
import { For, Index, Match, Show, Switch } from "react-alien-signals/utils";

const signedIn = signal(false);
const showList = signal(true);
const users = signal([{ id: "ada", name: "Ada" }]);
const labels = signal(new Map([["ada", "Ada"]]));

export function Panel() {
  return (
    <>
      <Show when={signedIn} fallback={<p>ログインしてください。</p>}>
        {(value) => <p>ログイン済み: {String(value)}</p>}
      </Show>

      <Switch fallback={<p>不明な画面です。</p>}>
        <Match when={showList}><p>ユーザー一覧</p></Match>
        <Match when={false}><p>表示されません</p></Match>
      </Switch>

      <For each={users} by={(user) => user.id} fallback={<p>ユーザーはいません。</p>}>
        {(user) => <p>{user.name}</p>}
      </For>

      <For each={labels} by={([id]) => id}>
        {([id, label]) => <p>{`${id}: ${label}`}</p>}
      </For>

      <Index each={users}>
        {(user, index) => <p>{`${index}: ${user().name}`}</p>}
      </Index>
    </>
  );
}
```

`Switch` はtruthyな最初の `Match` だけを描画します。`Match` は `Switch` の子としてのみ意味を持ちます。`For` は新しいレンダラではなく、局所的なReactのリスト境界です。配列、`Set`、`Map`（子には `[key, value]` エントリが渡ります）を扱い、安定したReact keyのために必ず `by` を指定します。`by` は純粋で、render中に生成するのではなくitem由来の値を返してください。意図的に位置をidentityにする配列では `Index` を使います。子にはレンダー中に読む `() => item` accessorと数値indexが渡ります。

`deepSignal` は配列を扱うため、配列操作とitem内部の読み取りをリアクティブにできます。一方で `Map` と `Set` は `deepSignal` にとって意図的に不透明です。`For` を更新するにはimmutable replacementを使います。つまりコピーを作り、変更してから新しいcollectionをsignalへ代入します（例: `const next = new Map(labels.value); next.set("bea", "Bea"); labels.value = next`）。render中にcollectionを変更しないでください。行コンポーネント内でsignalやdeep item propertyを読む場合は、その行で `useSignals()` を呼ぶかpluginを使い、行自身に購読を持たせてください。

## 実験的な制約

- React 19以降が必要です。JSXランタイムは、React 18では利用できないcallback refのクリーンアップを使用します。
- 変換なしの `useSignals()` とplugin既定の `transform: "inject"` は、管理されない簡易的な境界です。追跡は次の `useSignals()` 呼び出し時、または現在のmicrotask終了後に閉じられます。コンポーネントの最初のフックとして1回、無条件に呼び出し、そのレンダー中に同期的に行われるsignal読み取りだけを依存関係として利用してください。effect、イベントハンドラ、非同期callback、または所有コンポーネント自身が `useSignals()` を呼ばないrender props内の読み取りは、コンポーネントの依存関係としてサポートしません。Suspenseによって中断されたレンダー、レンダー中にネストして呼ぶ `renderToString` / `renderToStaticMarkup`、複数の並行rootをまたぐ厳密な分離はbest-effortです。厳密な `try` / `finally` レンダー境界には `unplugin-react-alien-signals` の `transform: "managed"` を使用してください。
- 直接バインディングは `value`、`checked`、`style`、イベントハンドラ、SVG props、および許可リスト外のホストpropsをサポートしません。
- 直接バインディングによる書き込みはReactスケジューラの外側で行われる、実験的な最適化です。
- Reactコンポーネントのpropsや子要素へ渡したsignalはアンラップされません。直接バインディングはネイティブHTML要素にのみ適用されます。ただし、JSXランタイムが処理するsignal子要素は例外です。
- ホストpropをバインドするかどうかは、その要素の生存期間中変えないでください。通常の値とsignalを切り替えるとラッパー要素の種類が変わり、DOMサブツリーが再マウントされる可能性があります。
- SSR（サーバーサイドレンダリング）とハイドレーションでは、サーバーとクライアントのsignal初期値を同一にしてください。リクエスト固有のsignalを共有モジュールスコープへ置かず、リクエストごとに作成してください。

## 開発

開発にはNode.js 22.18以降、pnpm 11、React 19以降が必要です。Node.jsの下限はビルドツールの `tsdown` によるもので、ビルド済みライブラリの実行環境要件を引き上げるものではありません。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

workspace aliasを使わないクリーンなVite consumerから、pack済みESM packageを検証するには次を実行します。

```sh
pnpm test:consumer
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
pnpm bench:transform
```

コアの結果では、生の `alien-signals`、このパッケージ、`@preact/signals-core` を比較します。数値は同じマシンとNode.jsバージョンでのみ比較してください。ホステッドCIの実行時間は変動が大きいため、信頼できる回帰しきい値には適しません。

`bench:transform` は最初にbuildを行い、配布済みVite adapterの小・大規模TSX moduleに対するparse、scope、書き換え、source map、code generationの経路を測定します。pass-throughの下限と、変換候補がないBabelケースを含むため、将来互換性のあるSWC/Oxc実装を同じcorpusで比較できます。
