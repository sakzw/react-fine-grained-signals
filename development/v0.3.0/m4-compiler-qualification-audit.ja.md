# M4 — React Compiler qualification audit

## 既存実装と実測済み契約

2026-10-13の追加qualification: `react-compiler.test.ts` は24 passed。managed compile successを明示確認し、module-scope/props-held signalの複数回更新、条件分岐の切替後に旧dependencyを解除して新dependencyを追う挙動、suspended renderのretry後の追跡、user Hook順をruntimeで確認した。Compiler integrationを無効にする設定でもCompiler plugin自体を後段に実行し、managed codegenがcompileできる状態を直接測定した。これはBabel pipelineのqualificationであり、Vite/Babelのproduction統合全体や他bundlerの認定ではない。

Compiler対応は未着手ではなく、v0.2.1で設計・実装・専用テストがある。`reactCompiler: "auto"` が変換対象へ `"use no memo"` を加え、作者指定directiveは維持する。`"off"` はdirectiveを省略する。

- `inject` のmodule-scope signal readをCompilerがmemoizeすると、更新後にdependencyが失われてstaleになる回帰を専用テストで固定している。
- v0.3.0の`managed`はtop-level `useSignalCapture()`とper-read closureを生成する。Compilerはこの形をcompile可能だが、`reactCompiler: "off"`で`"use no memo"` directiveを省くとclosure/captured JSXをmemoizeしstaleになる可能性があるため、opt-out経路のruntime behaviorもgateに含める。
- signal value hookとJSX direct bindingのCompiler実行テストは存在する。
- ViteではCompilerがsignal transformより先だとstaleになるcontrolと、signal pluginの`order: "pre"`でplugin配列順に依存しないことを専用テストで確認している。Compiler stepはplugin-react形状を模す試験で、実際のBabel Compiler統合全体を認定するものではない。
- 専用suite: `pnpm --filter unplugin-react-fine-grained-signals test:react-compiler`。文書・README・rendering guideにも制約を記録済み。

## v0.3.0で必要な追加qualification

M3のtracking契約はper-read managed方式として実装中。本書はそのCompiler適合のqualification記録であり、v0.2.1のtry/finally bailout説明は歴史的事実で、現行managed codegenを説明しない。

1. Compiler compile/skipの両経路と、integration設定の影響をVite production buildでも確認する。Babel pipelineでは更新、stale control、branch switch、Suspense retry、Hook順まで実測済み。
2. `"use memo"`等の作者指定、bare `useSignalTracking()`、手書き`useManagedSignals`、custom Hook、module/import signal、props経由signalの境界を確認する。現suiteは手書きruntime import・custom Hook・module scope・props・JSX direct bindingを含むが、作者指定directiveのmanaged runtime matrixは未完了。
3. Vite順序回帰とBabel Compilerの実統合を区別して報告する。Rollup、Webpack/Rspack、Next.jsは明示的な対応対象にする場合だけ追加認定する。
4. CompilerのCompileErrorとtransform diagnosticを区別し、未追跡callback等が静かにstaleになる条件をM3/M5の診断契約へ接続する。
5. lockfileで固定されたCompilerは`babel-plugin-react-compiler@1.0.0`。依存更新時に専用suiteを必ず再実行する。

M4のCompiler/Babel correctness subgateは完了。作者指定directive matrix、実Vite/Babel production統合、diagnostics、対応bundler範囲の明示が残るため、マイルストーン全体は未完了。
