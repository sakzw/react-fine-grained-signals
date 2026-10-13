# M4 — React Compiler qualification audit

## 既存実装と実測済み契約

2026-10-14の追加qualificationでM4のcorrectness subgateを閉じた。作者指定`"use memo"`のmanaged componentは実Compiler pipelineで`CompileSuccess`となり、signal writeを2回続けてもDOMが更新される。作者指定`"use no memo"`は`CompileSkip`となり、同じく2回のwriteを追跡する。さらに実Vite production buildで`@rolldown/plugin-babel`から実際の`babel-plugin-react-compiler`を実行し、signals pluginの登録順を逆にしても`"use no memo"`によるskipとmount後の2回更新が維持されることを確認した。これはVite/Rolldown+Babel plugin pipelineの検証であり、`@vitejs/plugin-react`のexperimental OXC compiler pathは別物。

2026-10-13の追加qualification: `react-compiler.test.ts` は当時24 passed。managed compile successを明示確認し、module-scope/props-held signalの複数回更新、条件分岐の切替後に旧dependencyを解除して新dependencyを追う挙動、suspended renderのretry後の追跡、user Hook順をruntimeで確認した。Compiler integrationを無効にする設定でもCompiler plugin自体を後段に実行し、managed codegenがcompileできる状態を直接測定した。

Compiler対応は未着手ではなく、v0.2.1で設計・実装・専用テストがある。`reactCompiler: "auto"` が変換対象へ `"use no memo"` を加え、作者指定directiveは維持する。`"off"` はdirectiveを省略する。

- `inject` のmodule-scope signal readをCompilerがmemoizeすると、更新後にdependencyが失われてstaleになる回帰を専用テストで固定している。
- v0.3.0の`managed`はtop-level `useSignalCapture()`とper-read closureを生成する。`reactCompiler: "off"`で`"use no memo"`を省いた状態でも、実Compilerを走らせたruntime testでglobal signal readの複数回更新を確認した。
- signal value hookとJSX direct bindingのCompiler実行テストは存在する。
- ViteではCompilerがsignal transformより先だとstaleになるcontrolと、signal pluginの`order: "pre"`でplugin配列順に依存しないことを専用testで確認している。2026-10-14には実Vite production buildで`@rolldown/plugin-babel`からCompilerを実行し、両plugin登録順のskip/runtime updateを確認した。`@vitejs/plugin-react`のexperimental OXC compiler pathはoptional `oxc-transform-react`が環境にないため実行していない。
- 専用suite: `pnpm --filter unplugin-react-fine-grained-signals test:react-compiler`。文書・README・rendering guideにも制約を記録済み。

## v0.3.0で必要な追加qualification

M3のtracking契約はbounded per-read managed方式として確定。本書はそのCompiler適合のqualification記録であり、v0.2.1のtry/finally bailout説明は歴史的事実で、現行managed codegenを説明しない。

1. Compiler compile/skipの両経路とintegration設定をBabel pipelineおよび実Vite production buildで確認する。反復更新、branch switch、Suspense retry、Hook順まで実測済み。
2. `"use memo"`と`"use no memo"`の作者指定directiveを、compile/skip eventとmanaged runtimeの複数回更新で確認した。bare `useSignalTracking()`、手書き`useManagedSignals`、custom Hook、module/import signal、props経由signal、JSX direct bindingも引き続きsuiteで確認する。
3. Vite/Babel production integrationは完了。`@vitejs/plugin-react`のOXC compiler pathや他bundlerは、その構成を対応範囲として明示する場合に限り追加認定する。
4. CompilerのCompileErrorとtransform diagnosticを区別し、未追跡callback等の境界はM3/M5のdiagnostic契約とREADMEへ接続した。
5. lockfileで固定されたCompilerは`babel-plugin-react-compiler@1.0.0`。依存更新時に専用suiteを必ず再実行する。

M4 Compiler/Babel qualificationは完了。最後の検証時点は`react-compiler.test.ts` 27件、実Vite/Babel production build両登録順2件。React pluginのexperimental OXC compilerはoptional dependencyを導入していないため対応範囲外として区別する。
