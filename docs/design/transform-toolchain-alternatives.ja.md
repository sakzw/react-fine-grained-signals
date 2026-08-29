# Transform toolchainの代替候補: oxcとswc

[English](transform-toolchain-alternatives.md) | [日本語](transform-toolchain-alternatives.ja.md)

状態: 設計検討中。APIや実装方針はまだ決定していません。

## 背景

`useSignals()` を自動挿入するtransformは、`packages/unplugin-react-fine-grained-signals/src/internal/transform.ts` にBabel pluginとして実装されています。これはbundler固有のBabel plugin設定として組み込まれているわけではありません。`transformReactFineGrainedSignals(code, id, options)` は単体のNode関数であり、任意のsource文字列に対して `@babel/core` の `transformSync()` を直接呼び出し、`{ code, map }`(fileの中にtransform対象が何もなかった場合は `null`)を返します。`unplugin` wrapper(`src/unplugin.ts`)は、この同じ関数を薄いadapter(`src/vite.ts`、`src/rollup.ts`、`src/webpack.ts`、`src/rspack.ts`、`src/esbuild.ts`)経由でVite、Rollup、Webpack、Rspack、esbuildへ均一に公開しています。esbuild adapterも例外ではなく、esbuild自体のGo製pipelineに組み込まれたplugin機構を経由するのではなく、unplugin自身の `onLoad`/`transform` hookの中からこのNode関数を呼び出しています。このbundlerに依存しない設計が成立しているのは、Babelが「文字列をparseし、自分のpluginを実行し、source map付きで文字列へprintし直す」という同期APIを、特定のbundlerのplugin hostから切り離された、素のNodeコードからこのprojectが呼び出せる形で公開しているからです。これはこのprojectがBabelをどう使っているかという性質であって、Babelのplugin modelだけが提供できる性質ではありません。代替toolchainを検討する際は、生のtransform速度だけでなく、この性質を維持できるかどうかも評価対象に含める必要があります。

plugin自体のロジックは単純ではなく、Babel固有の機能に複数依存しています。legacy decoratorを含むTS/TSX/JS/JSXのparsing。すべての `Function` nodeを歩きながら、自分自身の購読を持つnestしたcomponentやhookへ降りていくのを選択的な `path.skip()` で止めつつ、`.map()` のrender propのような通常のcallbackへは降り続けるという独自の走査制御フロー(`isNestedTrackingBoundary`、`inspectFunction`)。呼び出されている `useSignals` 識別子が、shadowされたlocal変数ではなく実際にimport specifierへ解決されることを確認するための、`functionPath.scope.getBinding(name)` による本物のscope/binding解決。これはrename import(`import { useSignals as x }`)やnamespace import(`import * as X; X.useSignals()`)経由でも機能します(`isNamedUseSignalsImport`、`isNamespaceUseSignalsImport`)。`export const Foo = ...` のようなwrapperを遡って、function自体ではなくexport宣言に付いたcommentまで見つけに行くleading comment照合(`@useSignals`、`@noUseSignals`、`hasOwnedLeadingComment`)。衝突を避けて生成したlocal名(`scope.generateUidIdentifier`)で重複のないimport specifierを挿入し、bodyを `try { ... } finally { store.f() }` で包み、visitor実行の残りの間scope情報を有効に保つためpass途中で `path.scope.crawl()` を呼ぶという、AST mutation。そしてtransform後のcodeに添えるsource mapの出力です。

`oxc` と `swc` はどちらも、JavaScriptとTypeScriptのparsing・transform・printingにおいてBabelより大幅に高速であるとされています。このdocsは、どちらか一方がこのplugin実装を置き換えられるかを検討します。`packages/unplugin-react-fine-grained-signals/benchmarks/transform.mjs`(`pnpm bench:transform` で実行)には、small/large両方のsource variantでtransform対象/非対象を比較する既存のmicro-benchmark harnessが既にあります。非対象sourceは `transform: "inject"` のみで計測し、対象sourceは `transform: "inject"` と `transform: "managed"` の両方で計測しています。今後toolchainを比較する際は、新しい手法を考案するのではなく、このharnessを拡張すべきです。

## 先行事例

このrepositoryが依存するVite 8(`^8.2.2`)は、esbuildとRollupのinternalsをRolldownへ置き換えましたが、RolldownのRust toolchainはswcベースではなくoxcベースです。したがって、swcはこのprojectの現在のtoolchainのどこにも暗黙には存在していません。むしろ、oxcの方が「もともと近い」toolchainであり、このprojectは `pnpm lint` のためにoxcのlinterである `oxlint` にも既に依存しています。ただし、どちらの近さも使えるtransform実装経路の存在を意味するわけではなく、それはまさに以下の2つの調査結果の主題です。

`@preact/signals-react-transform` は、このprojectのpluginに最も近い先行事例です。scopeを意識し、commentにも影響される、opt-inしたcomponentを `try`/`finally` のstore境界で包むBabel transformです。Preact teamによる公式なswcやoxcの相当品は存在せず、Babelがそこでの標準的な選択肢であり続けています。community projectである `@preact-signals/safe-react` は、2023年12月(issue #43)から同等のtransformをRust製のSWC pluginとして実現しようと取り組んでおり、その数年にわたる歴史の中でSWC経路特有のcorrectness bugが報告され、修正されてきています。例えばhookの誤動作に関する報告(issue #184)は2024年9月にcompletedとしてcloseされており、現時点でこのrepositoryに `swc` タグの付いたopen issueはありません。Valtioはcommunity製のSWC pluginを提供していますが、scopeを意識したcomponent検出を伴わない、かなり単純なtransform向けです。styled-components、emotion、Relayには公式のSWC pluginがあり、Next.js自身のtrackingでもこの作業は明確にportingと位置付けられています(例えば「Port babel-plugin-styled-components to SWC」)。`@swc/plugin-styled-components` も `babel-plugin-styled-components` の挙動に相当するSWC版として文書化されています。とはいえ、これらのplugin自体は機械的・自動変換ツールによる移植ではなく、あくまでゼロから書かれたRust実装であり、Vercel/Next.jsのengineering resource(`swc-project/plugins`)に支えられた、このprojectが動員できるresourceとは規模の異なる取り組みです。Preact Signals、MobX、Legend-State、Valtio、styled-components、emotionを確認した限り、これと同等のscope awareなBabel pluginがoxcへ移行した前例はどちらの方向にも見つかりませんでした。ただし、oxc自身の固定built-in pipeline(`oxc-transform`)は、styled-components自身のmaintainerとは無関係にoxcが独自にin-treeで再実装したstyled-components対応を既に備えているため、この「前例がない」という結論は見かけほど強いものではありません。

oxc自身は現在、このpluginに必要になるであろう水準の複雑さを持つprojectを1つ抱えています。`oxc-transform-react` は、React Compilerの自動memo化passに相当するもので(2026年8月出荷)、`babel-plugin-react-compiler` より10倍以上高速だと主張されています。oxc自身による2026年8月18日の発表によれば、その基盤となるRust実装はoxc発ではありません。React teamが最初に作り、oxcはそれを同期対象のfork(`forked-react-compiler`)として取り込み、その後 `oxc_react_compiler` としてin-treeへvendorし、forkの時点で未完成だった部分を仕上げ、性能もさらに改善しました。これは今もoxc内部にあるfirst-partyの実装であり、userlandのplugin実装経路ではないという点は変わらず、oxcがそれをin-treeで仕上げ最適化したこと自体は、oxcのRust層の走査・semantic analysis crateがこの水準のロジックを支えられるという証拠にはなります。ただし、architectureと実装の大部分はReact team由来であり、oxcがゼロから独自に設計したものではありません。community製のRustとnapiによるoxc向けReact Compiler移植である `eve0415/oxc-plugin-react-compiler` も別途存在しましたが、公式の(React team発でoxcがvendorした)移植が登場した後にarchiveされました。これはRust + napiによるpackaging経路の実在した前例ではあるものの、現在は保守されていません。

## 将来の判断で達成したいこと

- pluginの既存の挙動(scope/binding awareな `useSignals` 検出、nested boundaryのskipロジック、comment directiveの処理、`memo`/`forwardRef` のwrapper検出)に対する完全なcorrectness parityを維持する。
- bundlerに依存しないarchitectureを維持する。Vite、Rollup、Webpack、Rspack、esbuildのいずれからも、単一のNodeから呼べる関数を通じて同じtransform挙動へ到達できること。
- toolchainの一般的なbuilt-in transformに関するbenchmarkの主張ではなく、このplugin固有のロジックに対する再現可能でfairな性能比較に基づいてmigrationを判断する。
- 代替案を採用する前に、packaging・release・保守コストを明示する。

## 非目標

- このdocsで代替toolchainを選定すること。どちらの代替案についても実装は一切試みていません。
- oxcやswcが公表する一般的な「Babelよりn倍速い」という数値を、それらが測定していないこの独自でscope awareなtransformの根拠として採用すること。
- 測定された性能上の必要性以外の理由でtransformを書き直すこと。例えば、toolchainを採用すること自体を目的にすること。

## 評価する選択肢

### 1. Babelを維持する(現状維持)

既存の `@babel/core` ベースのpluginをそのまま動かし続けます。

利点は、書き直しのriskがないこと、pluginが現在直接依存しているBabelの成熟したscope/binding APIとcommentが紐付いたASTを引き続き利用できること、5つのbundler adapterで既にproductionで実績のあるbundlerに依存しない `transformSync` 設計を維持できることです。欠点は、Babelの生のparse/print性能がoxcやswcのbuilt-in transformより遅いことです。ただし、このprojectのtransform benchmark(`benchmarks/transform.mjs`)は、このprojectの典型的なfile sizeにおいて、その差がbundlerやdev server全体のoverheadと比べて実際に有意なのかをまだ確認していません。つまりこの欠点は、実証されたものではなく、現時点では未定量です。

### 2. Rustで実装するoxc integration

oxcのRust crate — 走査制御には `oxc_traverse`、scope/binding解決(`SymbolId`、`ReferenceId`、`Scoping`)には `oxc_semantic` — を使ってpluginのロジックを再実装し、`transformReactFineGrainedSignals(code, id, options) -> { code, map }` と同じNode関数signatureを公開するnapi addonとしてpackagingすることで、呼び出し側から見たbundlerに依存しないarchitectureを維持します。

利点は、oxcのbuilt-in transformの性能数値がこの独自visitorにも一般化するなら、生のtransform速度を大きく改善できる可能性があることです。napi addonは、swcのecosystemが使うWASM plugin hostingモデルとは異なり、bundlerに関係なくNodeから同じ方法で呼び出せます。欠点は、scope awareかつcomment駆動のロジックのすべてを、projectがこれまで経験のないRust APIに対して、移植ではなくゼロから再実装しなければならないことです。projectが現在保守していない、Windows/macOS/Linux・x64/arm64・musl込みのcross-platformなnapi build-and-releaseの体制も必要になります。`oxc-parser` のcomment処理はAST nodeに紐付かない生の `comments[]` 配列しか返さず、これはupstreamでoxc issue #19671として追跡されているgapであり、`@useSignals`/`@noUseSignals` というcomment directiveの仕組みに対する直接的かつ未解決のriskです。そして、`eve0415/oxc-plugin-react-compiler`(先行事例を参照)は、同等に洗練されたRust + napi pluginが実現可能であることを示していますが、この方法で出荷され、なおかつ現在も保守されている前例はありません。あの project がarchiveされたのは公式移植に取って代わられたためであり、実現不可能だったから放棄されたわけではありません。

### 3. Rustで実装するswc WASM plugin

`VisitMut` 実装として `wasm32-wasip1` へcompileし、pinしたversionの `@swc/core` をこのproject自身がself-hostしたうえで、compileしたWASM pluginのpathを `jsc.experimental.plugins` 経由で渡しながら `@swc/core` 自身の `transformSync()` を、5つのbundler adapterすべてがBabel経路で既に呼び出している、その同じ共有Node関数の中から呼び出します。識別子解決には、Babelの `scope.getBinding()` の代わりに `swc_ecma_transforms_base::resolver` の `SyntaxContext`/`Mark` hygieneモデルを使います。

利点は、`@swc/core.transformSync()` がBabelの `transformSync()` と同じ形の、素のNodeから呼び出せる関数だという点です。これはcommunity製のswc pluginが普段利用されている方法そのもので(例えば `swc-plugin-valtio` の公式なinstall/利用手順や、`@swc/jest` がNodeからpluginをhostしている例)、`transformReactFineGrainedSignals` 相当の共有関数の中からこれを呼び出す限り、swcと統合済みのtool(Next.jsのcompiler、`@vitejs/plugin-react-swc`、Rspackのswc-loader)を経由する必要はなく、esbuildが独自のswc plugin hookを持っているかどうかにも左右されません。そもそもesbuild adapterはesbuild自身のGo製pipelineの中で動いているわけではなく、Babelの場合と全く同じように、unplugin自身の `onLoad`/`transform` hookからこの共有Node関数を既に呼び出しています。したがって、swcを選んだからといってbundlerに依存しないarchitectureが構造的に失われるわけではありません。また、swcの `SyntaxContext`/`Mark` モデルは、より低levelなAPIではあるものの、pluginが現在Babelのscope objectから得ているrename importやnamespace importの解決保証と同等のことを表現できる、という点も利点です。欠点は、`@swc/core` のJS向け `Visitor` classがdeprecatedとされ削除が予定されている点です。swc自身のRFCは「JS visitorのsupportは現行roadmapに含まれない」と述べており、`@swc/core` 1.x は既にdeprecation警告を出しており、2.xではplugin設定optionと `@swc/core/visitor` の両方が削除される予定です。つまりRust製のWASM pluginは選択肢の一つではなく必須になります。これはscope awareかつcomment駆動のロジックのすべてを、`SyntaxContext`/`Mark` のsemanticsに対してゼロから再実装することを意味し、単なるJS実装からの移植では済みません。また、projectが現在保守していない `wasm32-wasip1` のbuild-and-releaseの体制も必要になります。さらに、pinした `@swc/core` をself-hostしても、version固定のriskは軽減されるだけで消えません。pluginのcompile時に固定した `swc_core` のversionは、このprojectが将来 `@swc/core` をupgradeするたびに、そのversionへ追随し続けなければならないからです。2025年11月4日に `@swc/core` >=1.15.0 / Next.js >=16.1.0 が獲得した後方互換なCBOR serializationも、field削除や型変更は明示的にcoverしておらず、`swc_core` のversion不一致による実際のcrash(`swc-project/swc` issue #8315)という文書化された歴史を伴います。つまり、将来の `@swc/core` upgradeは、範囲は以前より狭まったとはいえ、依然として現実のcompatibility riskとして残ります。そして、これと同等に洗練されたscope awareでcomment directive駆動の自動挿入pluginが、この経路で安定して出荷された実績はありません。最も近い先行事例である `@preact-signals/safe-react` も、数年にわたるcommunityの取り組みであり、SWC経路特有のcorrectness bugが報告され修正されてきた歴史はあっても、この経路が成熟しlow-riskであることを示す例ではありません。

### 4. ハイブリッド: parseはoxcやswcで高速化し、既存plugin logicにはBabel互換のASTブリッジを使う

より高速なparserの出力を、Babel互換のASTとscope graphへ変換できないかを調査し、既存のplugin logicをそのまま、より高速なfront endの上で動かせるようにします。

利点は、pluginの走査・scope解決・comment照合のロジックを再実装せずに、transformコストの大半を占めることが多いparsingとprintingだけを高速化できる可能性があることです。欠点は、現時点ではどちらのtoolchainについてもこの種のbridgeが存在するという事実は確認されておらず、BabelのASTとscopeモデルはoxcやswcのそれと十分に異なるため、忠実なbridgeを作ること自体が未実証で容易ではないengineering課題であることです。他の選択肢と比較評価できるようになる前に、prototype作成とcorrectness検証が必要です。また、ASTとscopeモデルの間で意味を保った変換を作り込むことまで考えると、ゼロからの再実装と比べて実質的にそれほど簡単ではない可能性もあります。

### 5. 現行transformが実際にbottleneckだと測定されるまで何もしない

`benchmarks/transform.mjs` を拡張するか、同等のharnessを新たに用意し、このprojectの典型的なfile sizeと利用形態のもとで実際のfile単位・project単位のtransform時間を確認し、それをdev serverやbuild全体の時間と比較したうえで、そもそもtoolchainの変更が正当化されるかを判断します。

利点は、最も低コストな選択肢であり、投機的な書き直しのコストを避けられ、他の選択肢を裏付けるために必要な根拠を生み出せることです。欠点は、問いに答えるのではなく先送りにすることです。これは他の選択肢と競合する最終形ではなく、他の選択肢と並行して行うべき前提条件として位置付けています。

## 判断基準

- 既存の `tests/transform.test.ts` 一式(mode: `manual`/`auto`/`all`、transform種別: `inject`/`managed`、comment annotation、nested boundaryのskipロジック、`memo`/`forwardRef` のwrapper検出、rename/namespace importの解決、TS+JSX+decoratorsのparsing)に対するcorrectness parityを、あるtoolchainをdrop-inの置き換えとみなす前に確認すること。
- 拡張した `benchmarks/transform.mjs` 相当のharnessを使い、small/large両方のfileとtransform対象/非対象両方のsourceを、同一hardware上で計測した、再現可能なbefore/after比較。
- bundlerに依存しないarchitecture(Vite、Rollup、Webpack、Rspack、esbuildのいずれからも単一のNode関数を通じて同じ挙動に到達できること)が維持されるか、それとも狭まるか。
- packagingとreleaseの負担。projectが現在保守していないnative/napi/WASMのbuild-and-publish pipelineを新たに必要とするか、必要ならどのplatform・architectureをcoverしなければならないか。
- projectの現在のskill set(TypeScriptによる実装)と、Rustによる実装経路とを比較した長期的な保守性。contributorにとって現実的なbus factorとonboardingコストを含む。
- ecosystemとversion固定の安定性。文書化されたswc WASM ABIの破壊的変更の歴史と、oxcのJS向けplugin surfaceの相対的な未成熟さを踏まえること。

## 現在の推奨

当面はBabelを維持します。oxcもswcも、現時点ではこのpluginのロジックをJS/TSで実装できる経路を提供していません。どちらもゼロからのRust再実装が必要になります。oxcには、任意のcustom transformロジックをNodeへ公開する仕組みが現状まったくありません。`oxc-parser` はscope/binding APIを公開しておらずcomment紐付けのgapも未解決であり、`oxc-transform` は固定のbuilt-in pipelineしか公開していません。swcのRust WASM経路は、pinしたversionをself-hostした `@swc/core.transformSync()` を、Babel経路が現在使っているのと同じ共有Node関数から呼び出すことで、bundlerに依存しないarchitectureを維持できます。しかしそれでも、`SyntaxContext`/`Mark` のsemanticsに対する全面的なRust再実装を強いる(JS向け `Visitor` APIはdeprecatedであり2.xで削除される予定)うえ、projectが現在保有していない `wasm32-wasip1` のbuild-and-release体制を要求し、2025年11月のABI安定性fixが狭めはしても取り除いてはいないversion固定riskを抱え続けます。このfixはfield削除や型変更をcoverしていないためです。どちらのRust経路にも、これほど洗練されたpluginを安定して出荷した実績はありません。oxc側の比較対象である `oxc-transform-react` は、userlandで実装できる形のpatternではなく、React team由来でoxcがin-treeにvendorした成果物ですし、swc側の最も近い先行事例である `@preact-signals/safe-react` も、依然として数年にわたるcommunityの取り組みにとどまっています。この判断を見直す前に、Babelのoverheadがこのprojectの典型的な利用状況におけるbuildとdev server全体の時間と比べて実際に有意かどうかを、(上記の選択肢5の通り)transformを測定して確認すべきです。この記述は現時点の調査結果を記録するものであり、設計上の論点を閉じるものでも、Babelを無期限に採用し続けることを確約するものでもありません。
