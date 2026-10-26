# v0.4.0 開発ロードマップ

## 現在の状態

- 状態: **計画確定、M0〜M7完了、M8以降は未着手**。2026-10-25に調査結果からマイルストーンを起こし、同日にD1〜D10を決定した（D5は行わない、D10は推奨と別の案を採用、それ以外は推奨どおり）。設計・調査ゲートは残っていない。
- 統合ブランチ: `main`（topic branch・PRは作らない）
- 基準: v0.3.0（tag `v0.3.0` / `c826f45`、2026-10-25 npm公開）
- 方針: **破壊的変更を許可する**。v0.3で「破壊的なので見送り」とした整理と、公開面の分かりにくさを解消する。新機能の追加は目的にしない。

## テーマ

**互換のために残している部分を削り、公開契約を細く・軽くする。**

v0.3.0公開時点で利用者はほぼいない（npm週間DL 26、GitHub star/issue/依存パッケージ 0、2026-10-16〜22計測）。破壊的変更のコストがこれより低い時期は今後ない。構造的な問題はv0.4でまとめて直し、移行ガイドで一度に説明する。

## 調査で確認した前提（2026-10-25）

- `alien-signals`は3.2.1が最新。v4の兆候なし。repoは`alien-signals/system`だけを使う。追従作業なし。
- React `latest`は19.3.1。19.3で`<Activity>`が隠れている間のstore変更を`useSyncExternalStore`が見落とす不具合（facebook/react#36947）が直り、transitionが個別に描画されるようになった（#37290）。19.0〜19.2もbackportが続いている。
- `babel-plugin-react-compiler`は1.0.0のまま。
- Node.js: 22はmaintenance LTS（EOL 2027-04-30）、24はmaintenance、26は2026-10-28にactive LTS。transformのNode要件`^22.18.0 || >=24.11.0`はBabel 8由来で変えられない。
- `@preact/signals-react-transform` 0.8.3がBabel 8に対応した。

## マイルストーン

| Milestone | 内容 | 依存 | 完了条件 | 状態 |
|---|---|---|---|---|
| M0 | 非破壊の掃除 | なし | 死んだコードと古いdocsを削除し、全ゲートが通る | **完了**（[記録](./m0-cleanup.ja.md)） |
| M1 | cross-copy interopの削除と複数コピー検出 | M0、D1 | interop系コードを削除し、2コピーの混在が明確なエラーになる。サイズ予算を更新 | **完了**（[記録](./m1-interop-removal.ja.md)） |
| M2 | entry再編（`/jsx`、`/jsx/lite`、`/internal`） | M1、D2 | 新entryだけが公開され、例・website・テストが移行済み | **完了**（[記録](./m2-entry-reorg.ja.md)） |
| M3 | 追跡境界Hookの整理 | M2 | 利用者向けの境界APIが`useSignalTracking`だけになる | **完了**（[記録](./m3-tracking-boundary.ja.md)） |
| M4 | Hookの依存配列の統一と`useWritableComputed` | M3、D3 | 全Hookで「省略と`[]`は同じ」になり、writableが別Hookになる | **完了**（[記録](./m4-hook-dependencies.ja.md)） |
| M5 | React peerを`>=19.3`へ | D4 | peer更新、Activity/transition関連の回避策の棚卸し | **完了**（[記録](./m5-react-peer.ja.md)） |
| M6 | utilsの型整理（`Show`/`Match`） | M2 | truthy判定と型が一致する | **完了**（`MatchProps`削除は保留、[記録](./m6-utils-types.ja.md)） |
| M7 | `Signal`型の名目化と`FormBindableSignal`の統合 | M4、D7 | `Signal`/`ReadonlySignal`が名目的になり、`FormBindableSignal`が消える | **完了**（[記録](./m7-signal-type.ja.md)） |
| M8 | `deepSignal(...).peek()`の戻り値を深いreadonly型に | M1、D8 | `peek()`経由の書き込みがコンパイルエラーになる | 未着手 |
| M9 | 診断の既定エラー化 | — | D5で行わないと決定 | **見送り** |
| M11 | `deepSignal`（object/arrayだけ）と`deepCollectionSignal`の分離 | M8、D6、D9、D10 | object/arrayだけを使う場合にコレクション対応のコードが入らない | 未着手 |
| M10 | 移行ガイド・リリースノート・最終ゲート | M0〜M8、M11 | 英日migration guide、release notes、website、CI成功 | 未着手 |

M5はM0の後ならどこでも並行できる。M6はM2の後ならM3/M4と並行できる。それ以外は上から順に進める。公開（npm publish、tag、GitHub Release、Pages deploy）はこの計画に含めない。

## 決定事項

D1〜D10はすべて決定済み。実装担当はこの決定に従う。変更が必要だと思う事実を見つけた場合は、実装を止めてメンテナに確認する。

| ID | 論点 | 推奨 | 状態 |
|---|---|---|---|
| D1 | interopの扱い：完全削除か、opt-in entryか | **完全削除＋検出エラー**。opt-inはコアへの差し込み点が`updateComputed`などに散らばり、保守コストが現状以上になる | **決定**（2026-10-25、推奨どおり） |
| D1b | v0.1.x検出と`react-fine-grained-signals-v0.1` devDependency | 削除する。v0.1は2世代前で、M1の検出エラーで足りる | **決定**（2026-10-25、推奨どおり） |
| D2 | entry名：`/jsx`・`/jsx/lite`・`/internal`。`/utils`は改名するか | 左記の名前。`/utils`は**据え置き**。旧entryのaliasは残さない | **決定**（2026-10-25、推奨どおり） |
| D3 | 依存配列の統一ルール | 「省略と`[]`は同じ」に全Hookをそろえる（M4参照） | **決定**（2026-10-25、推奨どおり） |
| D4 | React peerを`>=19.3`に上げるか | 上げる。サポート範囲が狭まり、テストの前提が単純になる | **決定**（2026-10-25、推奨どおり） |
| D5 | 診断の既定エラー化を行うか | — | **決定：行わない**（2026-10-25）。M9は見送り |
| D6 | deepSignalからMap/Set等のコレクション対応を分け、object/arrayだけを扱う形を用意するか | 分ける | **決定**（2026-10-25） |
| D7 | `Signal`型の整理（M7） | `Signal`/`ReadonlySignal`を型専用brandで名目化し、bindingの能力を`Signal`へ統合する。`FormBindableSignal`は**aliasを残さず削除** | **決定**（2026-10-25、推奨どおり） |
| D8 | `deepSignal(...).peek()`の直し方（M8） | 実行時は生のオブジェクトを返すまま、戻り値の型を深いreadonlyにする | **決定**（2026-10-25、推奨どおり） |
| D9 | M11のAPIの形 | 別名の2関数。`deepSignal`はobject/arrayだけ、Map/Set対応は`deepCollectionSignal`。Hookは`useDeepCollectionSignal`を追加し、`useDeepSignalValue`は両方に使う | **決定**（2026-10-25、推奨どおり） |
| D10 | object/arrayだけの`deepSignal`にMap/Set/WeakMap/WeakSetが入ったときの扱い | **追跡しない値**として扱う（Dateやクラスのインスタンスと同じ。丸ごと差し替えたときだけ通知する）。throwしない | **決定**（2026-10-25。推奨はthrowだったが、メンテナ判断でこちらを採用） |

## 各マイルストーンの詳細

### M0 非破壊の掃除

公開APIは変えない。v0.3.1として別に公開はせず、v0.4.0に含める（2026-10-25決定）。

- `src/core/interop.ts`のうち、本体から呼ばれずテストからしか呼ばれない関数（`withInteropGraphCollector`、`publishInteropGraphRead`、`pushInteropRenderScope`など）を削除し、該当テストも消す。本体が使っているのは`deep-signal-engine.ts`と`render-tracking.ts`からの参照だけ。削除前に`grep`で本体からの参照がないことを確認する。
- `src/core/signal-brand.ts`の`LEGACY_SIGNAL_BRAND_V1`（参照ゼロ）を削除する。
- transformの`experimentalCapture`（`packages/unplugin-react-fine-grained-signals/src/internal/transform.ts`の宣言と1箇所の分岐）を削除する。`src/unplugin.ts`からは渡されず、本番では到達しない。使っているのは`packages/unplugin-react-fine-grained-signals/tests/`の`react-execution.test.ts`と`react-concurrent-capture.test.ts`にある実験テストだけなので、テストも消す。`synchronousScan`は他の箇所でも使うので残す。
- `development/design/react-compiler-compatibility.md`（英日）の、managed出力を`try/finally`として説明している箇所を、現行の`useSignalCapture()`＋closure方式に合わせる。

完了条件: 全ゲート（後述）が通る。公開型（`dist/*.d.ts`）に差分がない。

### M1 cross-copy interopの削除と複数コピー検出

**目的:** 別コピーのSignalを読む仕組み（`foreign-readable-v1`、ReadableInterop V1 protocol、foreign依存の更新処理）を削除する。コアのhot pathから分岐を減らす。

**計測済みの効果**（rolldown minify＋gzip -9の試作。`pnpm size`のVite計測とは絶対値が違う）:

| scenario | 削除前 | 削除後 | 差 |
|---|---:|---:|---:|
| signal-only | 8,064 | 6,952 | −1,112（−13.8%） |
| core+hooks | 8,725 | 7,472 | −1,253 |
| jsx-runtime | 14,633 | 13,386 | −1,247 |
| index-full | 22,241 | 20,705 | −1,536 |

試作スクリプトは`C:\Users\catro\AppData\Local\Temp\claude\c--Users-catro-Documents-Git-Github-react-alien-signals\32163f5a-e695-4858-bd6d-c8e3c28a329f\scratchpad\strip.mjs`と`measure.mjs`（セッション用の一時領域なので、消えていても問題ない）。

**手順:**

1. **先に特性テストを書く。** `subscribeReadableV1`（`src/core/readable-subscription.ts`）は、JSX binding（`src/runtime/jsx.ts`）と`useSignalValue`（`src/react/hooks.ts`）が**ローカルのSignalにも**使う購読経路。protocolを外すとeffectによるfallback経路に切り替わる。切り替え前に、ローカルSignalの購読・解除・エラー時の挙動（computedがthrowする場合にrender時の`getSnapshot`でError Boundaryへ届くこと、など）をテストで固定し、削除後も同じ結果になることを確認する。fallbackで等価にならない場合は、ローカル専用の軽い購読経路を残す。
2. 削除対象:
   - `src/core/foreign-readable-v1.mts`の、bridge node・`advance`・`observeForeignRevision`・`activateForeignNode`・`publishForeignReadable`。**ローカル登録簿（`readableNodes`、`getNodeForReadable`、`observeRevision`、`graphOwner`）は残す**。別ファイルへ移して名前から`foreign`を外すとよい。
   - `src/core/alien-derived-runtime-core.mts`のforeign関連（約110行）: `updateComputed`のfinally、`readComputed`、`isComputedClean`、`promoteComputed`、`runEffect`・`effect()`のforeign分岐、getterの`isForeignOwner`分岐、`update()`の`"external"`分岐。
   - `src/core/interop.ts`の残り、`render-runtime.mts`と`react-adapter.mts`の`isInteropProtocol`分岐、`base.ts`の`isSignal`のbrand fallback。
3. **検出:** `globalThis`で共有している`executionContext`と`runtimeToken`は残す。別コピーのownerやbrandに出会ったら、"Multiple copies of react-fine-grained-signals are loaded; install a single copy"のようなメッセージで**throwする**。確認箇所は次の2つ。
   - 既存の`isForeignOwner`分岐（fast pathの後ろなので追加コストはほぼない）
   - `isSignal`で、brandはあるのにローカルの登録簿にないSignal
   - ownerがない状態（effect外）で別コピーのSignalを単純に読むケースは検出できない。この制約はdocsに書く。
4. テスト:
   - 削除: `tests/interop-internals.test.ts`、`tests/cross-copy-smoke.mjs`と`fixtures/cross-copy-interop-entry.ts`、`tests/cross-copy-effects.test.ts`、`tests/phase4-duplicate-smoke.mjs`とfixture。
   - 置き換え: 「2コピーを同時に読み込むと、明確なエラーになる」smoke testを1本追加する（既存のcross-copy smokeの組み立て方を流用する）。
   - 大幅に修正: `tests/cross-instance.test.tsx`、`tests/reactive-runtime.test.ts`（foreign系 約89件）、`tests/render-tracking-internals.test.ts`、`tests/subscription-path.test.ts`、`tests/runtime-review-regressions.test.ts`、`tests/core-runtime-audit-regressions.test.tsx`。
   - 部分修正: `grep -rln foreign tests`で洗い出す。
   - D1bが「削除」なら、`tests/mixed-version-smoke.mjs`、`test:mixed-version`スクリプト、devDependencyの`react-fine-grained-signals-v0.1`も消す。
5. `scripts/size-budget.json`を`pnpm size:update`で更新し、新旧の値を記録に残す。
6. docs: `docs/guides/core-primitives.md`、`global-state.md`（英日）、`development/design/packaging.md`の複数コピーに関する記述を、「1コピーだけをinstallする必要があり、混在はエラーになる」に書き換える。`dedupe`の案内（pnpmの`dedupe-peer-dependents`、bundlerの`resolve.dedupe`）を添える。

**完了条件:** 全ゲートが通る。2コピーのsmoke testが期待どおりのエラーで落ちる。サイズが上の表と同程度に減っている（`pnpm size`で signal-only 約1 kB減が目安）。記録`m1-interop-removal.ja.md`に、削除した経路・残した経路・計測値を書く。

### M2 entry再編

**目的:** ルートがJSXの都合で`createElement`をexportしている状態をやめる。トランスフォーム専用の`/runtime`を内部扱いにする。

`jsxImportSource: X`は`X/jsx-runtime`と`X/jsx-dev-runtime`を解決し、classic fallbackでは`X`自身の`createElement`/`Fragment`を使う。そのため新しい構成は次のとおり。

| 新entry | 中身 | 旧entry |
|---|---|---|
| `.` | プリミティブ（`signal`、`computed`、`deepSignal`、`effect`、`batch`、`untracked`、`isSignal`）、Hook、型 | `.`（`createElement`を除く） |
| `./jsx` | Full版の`createElement`、`Fragment`、`JSX`型 | `.`の`createElement` |
| `./jsx/jsx-runtime`、`./jsx/jsx-dev-runtime` | Full版JSX runtime | `./jsx-runtime`、`./jsx-dev-runtime` |
| `./jsx/lite` | Lite版の`createElement`、`Fragment`、`JSX`型、`SignalChild`型 | `./lite` |
| `./jsx/lite/jsx-runtime`、`./jsx/lite/jsx-dev-runtime` | Lite版JSX runtime | `./lite/jsx-runtime`、`./lite/jsx-dev-runtime` |
| `./internal` | `useSignalCapture`と`SignalCaptureStore`型。**transformの出力専用で、semverの対象外**とdocsに明記する | `./runtime` |
| `./utils` | 変更なし（D2が据え置きの場合） | `./utils` |

- 旧entryは**aliasを残さず削除**する（利用者がいないため。解決エラーで気づける）。
- Full版とLite版で`SignalChild`型のexportをそろえる。
- `package.json`の`exports`、`tsdown.config.ts`、`scripts/check-size.mjs`のscenario、`scripts/size-budget.json`のキーを更新する。
- transform: `packages/unplugin-react-fine-grained-signals/src/internal/transform.ts`の`${options.importSource}/runtime`（3箇所）を`/internal`に変更する。READMEの「`importSource`のwrapperは`/runtime`を再exportする」という記述も更新する。plugin側のpeer rangeは`^0.4.0`にする。
- 移行が必要なもの: `examples/`、`playground/`、`website/`、`benchmarks/`、`tests/`のtsconfig・pragma・import。`grep -rn "react-fine-grained-signals/\(lite\|runtime\|jsx-runtime\|jsx-dev-runtime\)\|jsxImportSource"`で洗い出す。`development/`配下の過去記録は履歴なので書き換えない。

**完了条件:** 全ゲートが通る。`pnpm test:consumer`が新entryで成功する。旧entryのimportが解決エラーになることをconsumer smokeで確認する。

### M3 追跡境界Hookの整理

**現状:** 境界APIが3つあり、docsに「これはmanaged出力と同等ではない」といった補足が多い。

- `useSignalTracking()`（ルート）: best-effortの範囲で追跡する。手書きで使い、`transform: "inject"`の出力でもあり、managedでもDeep Signalのproxy読み取り向けの逃げ道として使う。
- `useSignalCapture()`（`/runtime`）: managed出力専用。
- `useManagedSignals()`（`/runtime`）: 手書きの`try/finally`で閉じる厳密な境界。**transformはもう出力しておらず**、既存の境界として認識するだけ（transform.ts:719、2387付近）。v0.2のmanaged modeの名残。

**変更:**

- `useManagedSignals`と`ManagedSignalsStore`を削除する。transform側の認識コード（`importedName`の型union、719・2387付近の判定）からも外す。
- `useSignalCapture`はM2で`/internal`へ移動済みにする。
- 利用者向けの境界APIは`useSignalTracking`だけになる。`docs/guides/hooks.md`（英日）の境界の節を書き直し、`useManagedSignals`を使っていた場合の移行先（plugin、または`useSignalValue`/`useComputed`）を書く。
- `development/design/use-signals-boundary-design.md`に、§7（bare APIの縮小）をv0.4で採用したことを追記する。

**やらないこと:** `useSignalTracking`の意味を変えること、`useSignalScope(() => jsx)`のような新しい厳密境界APIを足すこと。必要になったらv0.4後に別途設計する。

### M4 Hookの依存配列の統一と`useWritableComputed`

**現状の不一致**（`src/react/hooks.ts`）:

- `useSignalEffect`: 省略と`[]`が同じ意味。長さの変更はthrowする。
- `useComputed`と`useDeepSignalValue`: 省略を長さ`-1`の別モードとして扱う。省略から`[]`に変えるとthrowする。実際の意味（closureを固定し、Signalだけに依存する）は`[]`と変わらない。
- `useComputed`は、getterだけの形と`{ get, set }`の形 × 依存配列あり/なし で4通り。capability（readonly/writable）の切り替えも実行時エラーにしている。

**変更（D3が推奨どおりの場合）:**

- 全Hookで「依存配列の省略は`[]`と同じ」にする。省略と`[]`の切り替えはエラーにしない。長さの変更は引き続きthrowする。
- `useComputed({ get, set })`を`useWritableComputed({ get, set }, deps?)`に分ける。`useComputed`はgetterだけを受け付ける。capability切り替えのエラー（`CapabilityChangeError`の経路）は型で防げるので削除する。
- プリミティブの`computed({ get, set })`は変えない（Hookではないので、依存配列の問題がない）。
- JSDocとdocs（`docs/guides/hooks.md`英日）を更新する。

**完了条件:** 全ゲートが通る。M18.20でFast Refreshの検証に使ったスクリプト（`development/v0.3.0/m18.21-fast-refresh.mjs`）で、Hookの状態保持が変わらないことを確認する。

### M5 React peerを`>=19.3`へ

- `package.json`の`peerDependencies.react`を`>=19.3.0`に、devDependencyを`19.3.1`以上にする。plugin側に`react`のpeerがあれば合わせる。
- `grep -rn "Activity" src tests e2e`で、19.3で直った`useSyncExternalStore`の不具合（隠れたActivity内の変更の見落とし）への回避策やテストがないかを確認する。回避策があれば削除を検討し、テストは19.3の挙動で期待値が正しいかを見直す。
- transition関連のテスト（`tests/react-concurrent-commit-consistency.test.tsx`、`tests/core-runtime-audit-concurrent.test.tsx`、transform側の`react-concurrent-capture.test.ts`）が、19.3でtransitionが個別に描画されるようになった変更（#37290）を前提にしても妥当かを確認する。
- READMEとwebsiteの要件表記を更新する。

### M6 utilsの型整理

- `Show`と`Match`は、childrenに`NonNullable<T>`を渡しているが、実際の判定はtruthy。`0`、`""`、`false`は型では除外されない。`Truthy<T>`型（`Exclude<T, null | undefined | false | 0 | "" | 0n>`相当）を導入して合わせる（`src/utils.tsx`）。
- 使われていない`MatchProps`（ソース上も"legacy truthy matching"と書かれ、`Match`のoverloadが参照していない）を削除する。
- 型の期待を固定するテストを追加する。repoには`*.test-d.ts`がないので、既存のテストが型をどう検証しているか（`@ts-expect-error`と`pnpm typecheck`の組み合わせなど）を確認し、同じ方式に合わせる。

### M7 `Signal`型の名目化と`FormBindableSignal`の統合（D7）

**問題:** `signal()`は`FormBindableSignal<T>`を返し、`Signal<T>`に代入するとbindingの能力が型から消える。`Signal`/`ReadonlySignal`（`src/core/base.ts`）は構造的な型なので、ただの`{ value, peek }`が型を通るのに、実行時は`isSignal`がfalseになる。

**決定した仕様:**

- `ReadonlySignal<T>`に型専用のbrand（`declare const ...: unique symbol`、実行時には存在しない）を付けて名目化する。`T`については共変のまま（`ReadonlySignal<"a">`は`ReadonlySignal<string>`に代入できる）。
- `Signal<T>`に、いまの`FormBindableSignal`が持つ書き込み側のmarker（`(value: T) => void`）を移す。これで`Signal<T>`は不変（invariant）になり、`Signal<"a" | "b">`を`Signal<string>`に代入できなくなる。書き込み可能なSignalとしては正しい挙動。
- `FormBindableSignal`は**aliasを残さず削除**する。`bindValue`/`bindChecked`のprop型は`Signal<T>`を受け取る。
- 選択肢型のbinding（radio、select、checkbox group）で使う内部型`FormBindableChoiceSignal`は、狭いunionのSignalを受け付ける必要がある。`Signal<T>`が不変になるので、prop型を`Signal<U>`（`U extends T`）のように総称化して置き換える。
- 戻り値の型: `signal()`、`computed({ get, set })`、`useSignal()`、`useWritableComputed()`（M4）は`Signal<T>`、`computed(getter)`と`useComputed()`は`ReadonlySignal<T>`。
- `DeepSignal`はM8で`peek()`の型が変わるため、`Signal<T>`との関係はM8と合わせて決める（M8参照）。

**記録:** 型だけを先に変えた時点で`pnpm typecheck`（runtime、transform、`examples/`、`website/`）を回し、出た型エラーの件数と種類を`m7-signal-type.ja.md`に残す。件数が数十を超え、利用者に同じ書き換えを大量に求めることになりそうな場合は、実装を止めてメンテナに報告する。

**完了条件:** 全ゲートが通る。型の期待を固定するテスト（`@ts-expect-error`で、構造的な偽物の`{ value, peek }`が`Signal`として通らないこと、`Signal<"a">`が`Signal<string>`に代入できないこと、`ReadonlySignal`は共変のままであること）を追加する。

### M8 `deepSignal(...).peek()`の戻り値を深いreadonly型に（D8）

**問題:** `peek()`は生のルートオブジェクトを返す。そこへ書き込んでも通知されず、変更が黙って失われる（`docs/guides/core-primitives.md`、v0.3.0 release notesのKnown Limitations）。

**検討して外した案:** `peek()`がproxyを返すようにすると、そのproxy経由のネストした読み取りがeffect内で追跡されてしまう。追跡しない別のproxyを作ると、「同じ値には同じproxy」というidentity保証と衝突する。

**決定した仕様:**

- 実行時の挙動は変えない。`peek()`は引き続き生のオブジェクトを返す（`src/core/deep-signal-engine.ts`の`DeepSignalImpl.peek`）。
- 戻り値の型を`DeepReadonly<T>`にする。
  - plain objectのプロパティは再帰的に`readonly`
  - 配列は`ReadonlyArray`
  - `deepCollectionSignal`（M11）では`Map`→`ReadonlyMap`、`Set`→`ReadonlySet`。WeakMap/WeakSetには組み込みのreadonly型がないので、`set`/`add`/`delete`を除いた型を用意する。
  - Date、クラスのインスタンス、関数などの追跡しない値は、そのままにする。
- `DeepReadonly<T>`は配列やMapで`T`に代入できないため、`DeepSignal<T>`はもう`Signal<T>`を継承できない。`DeepSignal`の型を、`value`（getterとsetter）、`peek(): DeepReadonly<T>`、brandを持つ独立したinterfaceにする。`isSignal`の型ガード、`NotDeepSignal`、JSXのprop型、`useDeepSignalValue`が、`DeepSignal`を引き続き正しく受け付ける・拒否することを確認する。
- docsでは「`peek()`は追跡しない読み取り専用のスナップショット。変更は`.value`経由で行う」と説明する。

**完了条件:** 全ゲートが通る。`@ts-expect-error`で、`state.peek().count = 1`、`state.peek().items.push(x)`、（M11の後で）`collectionState.peek().get(k)`は通るが`.set()`は通らないこと、を固定する。

### M9 診断の既定エラー化（見送り）

D5で行わないと決定した（2026-10-25）。以下は検討時の内容で、v0.5以降に再検討する場合の参考として残す。実装しない。

- 前提作業: Vite・Rollup・webpack・rspackは、1モジュールにつき最初にエラー化した診断で止まる（esbuildは全件を報告する）。同じモジュール内でエラー化した診断を1つのerrorにまとめ、全件を表示する。これがないと、利用者はビルドのたびに1件ずつ直すことになる。
- 既定でエラーにする候補（読み取りが確実に追跡されないもの）: RFGS001、002、004、006。008は要検討。
- 003、005、009は警告のまま（誤検出があるか、正しい動作でも出るため）。007は、読み取りがある場合だけエラーにする。
- `diagnostics.errorOn: []`のように、明示的に既定を打ち消せるようにする。
- 同時に検討してよいもの: `reactCompiler: "auto"`は、Compilerを検出せず常に`"use no memo"`を付けるので、実態に合った名前（例: `"mark"`）にする。
- 記録`development/v0.3.0/m18.3-diagnostics.ja.md`の、診断の件数（この repo の310ファイルでRFGS005が234件など）を参照し、例とwebsiteで新しい既定のビルドが通ることを確認する。

### M11 `deepSignal`（object/arrayだけ）と`deepCollectionSignal`の分離（D6、D9、D10）

**目的:** object/arrayだけを使うアプリが、Map/Set/WeakMap/WeakSet対応のコードを読み込まないようにする。Reactのstateの大半はJSONに近いobject/arrayで、コレクションをstateに入れるのは少数派。

**計測済みの効果**（2026-10-25、rolldown minify＋gzip -9の試作。`pnpm size`のVite計測とは絶対値が違う）:

| scenario | 現行 | コレクション対応なし | 差 |
|---|---:|---:|---:|
| deep（`deepSignal`、`useDeepSignal`、`useDeepSignalValue`） | 15,567 | 12,938 | −2,629（−17%） |
| index-full | 22,241 | 19,584 | −2,657 |
| signal-only / core / core+hooks / jsx-runtime | — | — | 0（deepSignalを使わなければ今でも入らない） |

試作は`src/core/deep-signal-engine.ts`から、`reactiveCollectionProxy`、コレクション用のversion管理と掃除処理（約879〜1423行）、`ReactiveCollectionIterator`、`getNativeCollectionKind`の本体を外したもの。グラフ検証・コピーのコレクション分岐は残しているので、正式に分離すればもう少し減る見込み。deepSignal固有のコスト約6.8 kBのうち、4割近くがコレクション対応にあたる。

**interopとの違い:** コレクション対応は、ほぼ独立したかたまり。本体との接点は`wrap`（proxyで包む処理）、`getNativeCollectionKind`/`isStandardCollection`による判定、`assertDeepDataGraph`・`cloneReactiveGraph`・`matchesNormalizedGraph`のコレクション分岐、`inspectCollectionMetadata`程度。差し込み点が少ないので、分離の保守コストは低いと見ている。

**決定した仕様:**

- **`deepSignal(value)`**: plain objectとarrayだけを追跡する。
  - ルートにMap/Set/WeakMap/WeakSetを渡したら、`deepCollectionSignal`を案内するTypeErrorをthrowする（ルートは追跡しない値になれないため）。
  - ネストしたMap/Set/WeakMap/WeakSetは、**追跡しない値**として扱う（D10）。Date、クラスのインスタンスと同じで、proxyで包まず、identityをそのまま保つ。親プロパティへ別のインスタンスを代入したときだけ通知する。`state.value.tags.add(x)`のような中身の変更は通知されない。
- **`deepCollectionSignal(value)`**: v0.3の`deepSignal`と同じ挙動。ルートとネストしたMap/Set/WeakMap/WeakSetを追跡する。
- **Hook**: `useDeepSignal(initial)`はobject/arrayだけの版を作る。`useDeepCollectionSignal(initial)`を追加する。`useDeepSignalValue`は両方のSignalを受け付ける。
- **型**: `DeepCollectionSignal<T>`を`DeepSignal<T>`とは別の型として用意する。両者の違い（コレクションを追跡するか）が型から分かるようにする。
  - **追加の推奨（D10の落とし穴への対策）:** `deepSignal`の`.value`のgetter型では、ネストしたMap/Setを`ReadonlyMap`/`ReadonlySet`として見せ、`.set()`/`.add()`/`.delete()`/`.clear()`をコンパイルエラーにする。setter側は元の型`T`を受け付ける（TypeScriptはgetterとsetterで別の型を許す）。こうすると、実行時のコストなしで、黙って反映されない書き込みを型で防げる。型が成り立たない（推論が壊れる、利用側で大量の型エラーが出るなど）場合は、docsでの注意喚起だけにして、記録に理由を残す。
- **tree shaking**: コレクション対応のコード（`reactiveCollectionProxy`、コレクション用のversion管理と掃除処理、`ReactiveCollectionIterator`など）を別ファイルへ移し、`deepCollectionSignal`を経由したときだけ読み込まれるようにする。import時の副作用（グローバルへの登録など）には頼らない（`sideEffects: false`のため）。
- **エンジンの共有**: 実装は、deepSignalのエンジン（proxyのキャッシュとmetadata）を1つにし、コレクション対応だけを`deepCollectionSignal`の呼び出しで差し込む形を第一候補にする。エンジンを2つに分けると、同じ生オブジェクトに2つのproxyができてidentity保証が崩れるため。同じ生オブジェクトを`deepSignal`と`deepCollectionSignal`の両方から参照した場合の挙動は、実装時に決めて記録する。きれいに定義できない場合は、実装を止めてメンテナに相談する。
- **v0.3の判断との関係**: v0.3のM9（`development/v0.3.0/m9-api-performance-development.ja.md`）では、「コレクションは既定でリアクティブ、optionsは削除」として単純化した。今回はサイズを理由に、コレクション対応を別の関数に分ける。移行ガイドでは「v0.3でMap/Setを`deepSignal`に入れていた場合は、`deepCollectionSignal`に変える」と案内する。

**作業:**

- 既存のコレクション関連テストを`deepCollectionSignal`へ移す。`grep -rln "new Map\|new Set\|WeakMap\|WeakSet" tests`で洗い出す。
- `deepSignal`の新しい挙動のテストを追加する。
  - ネストしたMapをproxyで包まないこと（identityが保たれる）
  - 中身の変更が通知されないこと
  - 別インスタンスへの差し替えは通知されること
  - ルートのMapが案内付きでthrowすること
- `scripts/check-size.mjs`に`deep-collections`のscenarioを追加し、`deep`は`deepSignal`だけを測るようにする。予算を設定する（`deep`は試作で約2.6 kB減）。
- benchmark（`benchmarks/collection-sweep.mjs`、`collection-scaling.mjs`）を`deepCollectionSignal`に切り替える。
- docs（`docs/guides/core-primitives.md`、`global-state.md`、`hooks.md`の英日）を更新する。

**依存:** M1（interop削除で`deep-signal-engine.ts`の`shouldTrackDeepRead`周辺が変わる）とM8（同じファイルの`peek()`）の後に行い、同じファイルへの変更が重ならないようにする。

**完了条件:** 全ゲートが通る。`pnpm size`の`deep`が、試作と同程度に減っている。コレクション関連の既存テストが`deepCollectionSignal`ですべて通る。記録`m11-deep-collections.ja.md`に、エンジン共有の方式、両方から参照した場合の挙動、型による対策を採用できたかを書く。

### M10 移行ガイド・リリースノート・最終ゲート

- `docs/migration/v0.4.md`と`v0.4.ja.md`を作る。M1〜M8とM11の変更ごとに「変更前 → 変更後」の対応表を載せる。entryの対応表（M2）は必ず入れる。
- `docs/releases/v0.4.0.md`を作る。
- README（英日）、`docs/guides/*`、`website/`を新APIに合わせる。
- package versionを`0.4.0`に、plugin側のpeer rangeを`^0.4.0`にする。
- 全ゲートとGitHub CI（Test、E2E、Website CI）の成功を記録する。publishは別途指示があるまで行わない。

## 見送り（v0.4では扱わない）

| 項目 | 理由 |
|---|---|
| Liteを既定のJSX runtimeにする | v0.3の目玉の`bindValue`/`bindChecked`を使うフォーム利用者が全員壊れる。M2で両者を対等な名前で選べるようにすれば足りる |
| `transform: "inject"`の削除 | 削れるのは約40〜50行だけ。docsがDeep Signalのproxy読み取りの回避策として案内しており、M17.7では比較の基準にも使っている |
| `mode: "manual"` / `"all"`の削除 | 削れるコードがほぼない |
| effectの意味の変更（エラーをwriterへ伝播する、computed内effectの自動破棄をやめる） | Preactとの違いはdocsで説明すれば足り、変更の利益が小さい |
| `For`/`Index`の行memo化、deepSignalのobject snapshot、任意callbackの自動追跡 | v0.3で計測し、不採用にした（m18-feature-exploration.ja.md） |
| 等値に戻ったComputedによる余分な再render | 正確性に影響せず、破壊的変更とも関係しない（m19.5-computed-equality-rerender.ja.md） |
| transform解析の再帰の反復化 | 実コードで数百段のhelper連鎖が報告されるまで保留（m19.5-transform-stack-depth.ja.md） |
| 診断の既定エラー化（M9）、`reactCompiler: "auto"`の改名 | D5で見送り。前提として、1モジュール内の診断をまとめて報告する改修が必要になる |
| Node要件の引き上げ | runtimeの`>=22`は2027-04まで妥当。transformはBabel 8の要件に従う |

## 実装担当への共通ルール

- **作業の進め方:** マイルストーンごとに`main`へ直接commitする。topic branch・PRは作らない。commitはマイルストーン内でも意味のある単位に分ける。マイルストーンが完了し、ローカルで全ゲートが通ったら`origin/main`へpushし、GitHub CI（Test、E2E、Website CI）の結果を記録に残す（2026-10-25にメンテナが許可）。CIが失敗した場合は、次のマイルストーンへ進む前に直す。force pushはしない。完了したら本書の表の「状態」と、マイルストーン記録（`development/v0.4.0/mN-*.ja.md`、日本語）を更新する。
- **判断に迷ったとき:** 決定事項どおりに実装できない事実（型が成り立たない、性能やサイズが大きく悪化する、など）や、本書と食い違う事実を見つけた場合は、実装を止めてメンテナに確認する。
- **改行コード:** repoのファイルはすべてLF。`.gitattributes`はない。PythonのテキストモードはCRLFで書き出すので使わない（使うなら`newline=""`を指定）。編集後は`git diff --stat`で、変更行数が不自然に多くないかを確認する。
- **公開しない:** npm publish、git tag、GitHub Release、Pages deployは行わない。
- **ゲート（各マイルストーンの完了時）:**
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm exec vitest run --maxWorkers=2`（runtime。既定の並列数ではこのマシンでworker起動がtimeoutする。完了時はファイル数・テスト数の合計が減っていないかを確認する）
  - `pnpm test:transform`
  - `pnpm build`
  - `pnpm size`
  - `pnpm test:consumer`
  - `pnpm test:browser`（PowerShellで、Voltaの実際のNode imageのディレクトリ（`$env:LOCALAPPDATA\Volta\tools\image\node\<devEnginesのversion>`）をPATHの先頭に置いてから実行する。Voltaのshim経由だとPlaywrightのwebServer起動が失敗する）
  - websiteに触れた場合は、websiteのbuild
- **サイズ予算:** `scripts/size-budget.json`は、削減した場合だけ`pnpm size:update`で下げる。増える変更では予算を上げず、理由を記録してメンテナに確認する。
