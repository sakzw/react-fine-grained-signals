# M4 — React Compiler qualification audit

## 既存実装と実測済み契約

2026-10-13の追加runtime gate: `reactCompiler: "off"`でも、Compiler自体が後段で有効な構成を模してmanaged captureをcompileし、signalを2回書き換えた後も表示値が更新されることをfocused testで確認した。`react-compiler.test.ts` の対象ケースは1 passed / 19 skipped。これにより専用suiteは従来の71 passed / 3 skippedから、合計72 passed / 3 skipped相当になる。統合全体は次のM8 full runで再確認する。

Compiler対応は未着手ではなく、v0.2.1で設計・実装・専用テストがある。`reactCompiler: "auto"` が変換対象へ `"use no memo"` を加え、作者指定directiveは維持する。`"off"` はdirectiveを省略する。

- `inject` のmodule-scope signal readをCompilerがmemoizeすると、更新後にdependencyが失われてstaleになる回帰を専用テストで固定している。
- v0.3.0の`managed`はtop-level `useSignalCapture()`とper-read closureを生成する。Compilerはこの形をcompile可能だが、`reactCompiler: "off"`で`"use no memo"` directiveを省くとclosure/captured JSXをmemoizeしstaleになる可能性があるため、opt-out経路のruntime behaviorもgateに含める。
- signal value hookとJSX direct bindingのCompiler実行テストは存在する。
- ViteではCompilerがsignal transformより先だとstaleになるcontrolと、signal pluginの`order: "pre"`でplugin配列順に依存しないことを専用テストで確認している。Compiler stepはplugin-react形状を模す試験で、実際のBabel Compiler統合全体を認定するものではない。
- 専用suite: `pnpm --filter unplugin-react-fine-grained-signals test:react-compiler`。文書・README・rendering guideにも制約を記録済み。

## v0.3.0で必要な追加qualification

M3のtracking契約はper-read managed方式として実装中。本書はそのCompiler適合のqualification記録であり、v0.2.1のtry/finally bailout説明は歴史的事実で、現行managed codegenを説明しない。

1. Compiler compile/skipとintegration on/offそれぞれで、追跡値更新、stale render、retry/abandoned render、Hook順をM3の現行方式で確認する。特に`reactCompiler: "off"`を選んだ場合にCompiler自体が有効な利用者への挙動と制約を明示する。
2. `"use memo"`等の作者指定、bare `useSignalTracking()`、手書き`useManagedSignals`、custom Hook、module/import signal、props経由signalの境界を再確認する。
3. Vite順序回帰とBabel Compilerの実統合を区別して報告する。Rollup、Webpack/Rspack、Next.jsは明示的な対応対象にする場合だけ追加認定する。
4. CompilerのCompileErrorとtransform diagnosticを区別し、未追跡callback等が静かにstaleになる条件をM3/M5の診断契約へ接続する。
5. lockfileで固定されたCompilerの実バージョンを記録し、依存更新時に専用suiteを必ず再実行する。

M4の完了条件は、M3の最終方式で上記の正確性境界が有効・無効両方で固定され、対応を謳うbundler経路と未対応経路が文書化されること。現時点では既存方式の証拠はあるが、v0.3.0 qualificationは未完了。
