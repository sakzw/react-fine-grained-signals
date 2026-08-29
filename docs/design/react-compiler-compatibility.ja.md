# React Compilerとの互換性

[English](react-compiler-compatibility.md) | [日本語](react-compiler-compatibility.ja.md)

状態: `babel-plugin-react-compiler` 1.0.0 をdefault設定で計測済み。build pluginはmemoization opt-outを既定で出力するようになりました。未解決の項目は[未解決の論点](#未解決の論点)にまとめています。

## 背景

`useSignals()` はrender collector(`src/react/use-signals.ts`)を開き、そのrender中に行われた `signal.value` の読み取りをすべて記録することでcomponentをreactiveにします。commit時に `RenderStore.commit()` は記録した読み取りを前回commitの購読と差分比較し、今回のrenderで読まれ**なかった**依存をすべて解除します。つまり「componentが表示する値は毎回のrenderで読み直される」ことが前提の契約です。

React Compilerはこの契約を設計上破ります。componentのJSXをinstanceごとのmemo cacheへ保存し、reactiveな入力が変化した部分だけを再実行します。compilerがnon-reactiveと判定した対象への `signal.value` 読み取り — module scopeのbindingやimport、つまり多くのsignalライブラリが推奨する形 — は `Symbol.for("react.memo_cache_sentinel")` で守られたblockの中に置かれ、component instanceごとに一度しか実行されません。

両者のモデルは正面から衝突するため、compilerのdocsからの推論ではなく実測しました。

## 計測方法

`packages/unplugin-react-alien-signals/tests/react-compiler.test.ts` は、実アプリケーションと同じ順序でpipelineを実行します。

1. このpackageのBabel transform(`transformReactAlienSignals`)を対象モードで実行する。
2. `babel-plugin-react-compiler` 1.0.0 をdefault設定で実行し、`logger` eventを収集する。
3. automatic runtimeのJSX transformを実行する。
4. moduleをメモリ上でlinkし(importは実際のライブラリへ解決されるため、module scopeは本物です)、jsdomで評価する。

各caseはcompile後のcodeと実際の挙動の両方で検証します。挙動側はmountし、`act()` 内でsignalへ書き込み、DOMを読みます。実行は `pnpm --filter unplugin-react-alien-signals test:react-compiler`。CIでは `.github/workflows/test.yml` の独立したstepとして実行します。

fixtureは、今回の仮説そのものの形です。

```jsx
import { signal } from "react-alien-signals";

export const count = signal(0);

export function Counter() {
  return <output>{count.value}</output>;
}
```

## 計測結果

### opt-outなしの `transform: "inject"`: 最初の更新でcomponentが死ぬ

仮説どおりでした。`reactCompiler: "off"`(今回の変更前の挙動)では、compilerは次を出力します。

```jsx
import { c as _c } from "react/compiler-runtime";
import { signal } from "react-alien-signals";
import { useSignals as _useSignals } from "react-alien-signals";
export const count = signal(0);
export function Counter() {
  const $ = _c(1);
  _useSignals();
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <output>{count.value}</output>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
```

`count.value` はsentinel blockの内側にあるため、mount renderで一度読まれたきり二度と読まれません。jsdomで計測した実行時の帰結は次のとおりです。mountでは `0` が描画される。`count` への最初の書き込みは、mount renderが依存を記録済みなのでReactへ通知される。しかしその再renderはcacheされたelementを返すだけで何も読まないため、`commit()` は依存が空になったと判断して購読を解除する。以降の書き込みは何も起こさない。signalが `2` を保持していてもDOMは `0` のままです。componentは更新される瞬間まで正常に見えます。

ここで失敗しているのは `useSignals()` ではありません。毎回のrenderで呼ばれています。凍結されているのは読み取りだけでなくJSXそのものなので、runtime側で修復する余地はありません。collectorが購読を保持し続けたとしても、再renderはcacheされたelementを返すだけです。

### `transform: "managed"`: compilerに無視されるが、それは偶然

こちらは仮説どおりではなく、managedの出力はそのまま残ります。`try` / `finally` scopeはcompilerのIRへlowerできず、compileはerrorとして記録されたうえで中断されます。

```
CompileError: (BuildHIR::lowerStatement) Handle TryStatement without a catch clause
```

出力されるcodeはtransformの出力とbyte単位で同一で、runtime testも正しく更新されます。ただしこれは未対応構文によるbail-outであって互換性の保証ではありません。compilerが `catch` なしの `try` を拒否し続けることに依存しており、`panicThreshold: "all_errors"` では同じeventがfunctionのskipではなくbuildの失敗になります。したがってopt-out directiveはmanagedモードでも出力します。

### leaf hookはcompiler-safe

`useSignalValue(count)` はhook経由で値を返すため、compilerはこれをreactiveな入力として扱います。

```jsx
export function Counter() {
  const $ = _c(2);
  const value = useSignalValue(count);
  let t0;
  if ($[0] !== value) {
    t0 = <output>{value}</output>;
    $[0] = value;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  return t0;
}
```

cache keyがsignalの値そのものなので、値が変わったときだけJSXが再構築されます。この経路にopt-outは不要で、compilerのmemoizationもそのまま活かせます。独自JSX runtimeのhost直接binding(`<output>{count}</output>`)が安全なのは別の理由です。cacheされたelementはsignal自体を保持し、DOM leafはeffectが更新するため、elementがcacheされても影響がありません。どちらもruntime testで固定しています。

### 危険なのはcompilerがnon-reactiveと判定する読み取りだけ

propsを経由して渡されたsignalはreactiveな入力なので、compilerは読み取り自体をcache key(`$[0] !== counter.value`)として出力し、毎renderで実行します。危険なのはmodule scopeとimportされたsignalであり、それはこのライブラリのdocs自身が使っている形です。

## 対応

build pluginに `reactCompiler` optionを追加しました。値は `"auto"`(default)か `"off"` です。`"auto"` ではtransformしたすべてのfunctionにReact Compilerのopt-out directiveを付けるため、compilerはこのライブラリがreactiveにしたfunctionだけを正確にskipします。

```jsx
export function Counter() {
  "use no memo";

  _useSignals();
  return <output>{count.value}</output>;
}
```

compilerは該当functionに `CompileSkip` を記録し、codeを変更せずに出力します。runtime testはすべての書き込みで更新されます。同じdirectiveはmanagedの出力にも付き、`CompileError` によるbailを意図的なskipに変えます。transformが触るcustom hookにも付きます。hookのbodyもcomponentのbodyと同じ条件でmemoizeされるためです。

transformの既存の契約から導かれる詳細は次のとおりです。

- directiveを付けるのは、実際にtransformしたfunctionと、意図的に手を加えないcase 1つだけです。後者は `transform: "inject"` で、componentが最初の文として自分で `useSignals()` を呼んでおり、それが設定された `importSource` からのimportである場合です。挿入するものはありませんが、そのfunctionはrender trackingを行っているためdirectiveを付け、fileはtransform済みとして扱います。
- functionのbodyに既に自前のmemoization directive(`"use memo"`、`"use forget"`、`"use no memo"`、`"use no forget"`)がある場合は何も追加しません。作者の明示的な指定を優先します。
- transformは冪等のままです。再実行するとdirectiveが既にあることを検出し、何も変更せず、fileはtransformされなかったものとして報告します。
- `reactCompiler: "off"` は以前の出力を完全に復元します。これが妥当なのは、React Compilerをbuildに使っていない場合か、対象componentが上記の計測結果に照らして安全だと確認済みの場合だけです。

コストは実在します。memoizationをopt-outしたcomponentは、compilerが最適化しないcomponentです。それでもこれが正しいdefaultです。決して更新されないmemoized componentは最適化ではありません。両立させたい場合は、compilerが正しく扱えてpluginがtransformもしない、上記のleaf hookや直接bindingの経路を使えます。

## 推奨する `transform` のdefaultは変わるか

React Compilerを理由とするなら、変わりません。managedの出力がcompilerを生き延びるのは、compilerが `catch` なしの `try` をlowerできないという実装上の詳細のためであり、それは `panicThreshold: "all_errors"` ではbuildを壊すerrorにもなります。directiveを両モードで出力する以上、`"inject"` と `"managed"` はcompilerに対して等しく安全です。したがって両者の選択は[`useSignals()` 境界の設計検討docs](use-signals-boundary-design.ja.md)にある境界の厳密さの議論に依存し、このdocsが根拠になることはありません。なお別件として、`unplugin-react-alien-signals` は現在 `transform: "managed"` を既定にしています。これはこの境界の厳密さを理由とする変更であり、根拠はそちらのdocsにあります。このdocsの計測結果が根拠になっているわけではありません。

## 未解決の論点

- **bundler間での実行順序。** directiveが効くのは、このpackageのtransformがcompilerのBabel passより先に走る場合だけです。Viteでは構造的に成立します。pluginは `enforce: "pre"` を宣言しており、`@vitejs/plugin-react` は通常順のpluginとしてBabelを実行するためです。その間に走るVite自身のTypeScript passは、oxcとesbuildのどちらのtransformerでもdirectiveを保持します(JSXを保持したまま `.tsx` を入力にして直接確認しました)。Webpack、Rspack、Next.jsのpipelineは未計測です。
- **`transform: "managed"` と `panicThreshold: "all_errors"`。** directiveがあっても `TryStatement` のerror eventは記録され続けるため、全errorでpanicする設定のbuildはmanagedの出力で失敗すると考えられます。実際のbundlerでのend-to-end再現はしていません。
- **build pluginなしで手書きした `useSignals()`。** directiveを挿入するものが存在せず、失敗は無言です。該当componentには `"use no memo"` を手書きするか、`mode: "manual"` のpluginを使う必要があります(manualモードは今回の変更でdirectiveを付けます)。
- **`transform: "inject"` でapplication barrel経由でimportした `useSignals()`。** transformは呼び出しを認識してfunctionをskipし、skipしたままにするため、directiveは付きません。設定した `importSource` からの直接importか、`@useSignals` 注釈であれば対象になります。
- **compilerのversion。** 以上はすべて1.0.0のdefault設定での挙動です。`try` / `finally` に対応したversion、module scopeの読み取りの分類を変えたversion、`"use no memo"` の扱いを変えたversionが出た場合は、このdocsの計測をやり直す必要があります。testはその計測の実行可能な形です。
