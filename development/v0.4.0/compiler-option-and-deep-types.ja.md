# `reactCompiler: "auto"`の改名と、deep signalの型の修正

v0.4.0のマイルストーン後に行った、公開前に入れておく変更の記録。どちらも公開後に直すと破壊的変更になるため、v0.4.0に含めた（2026-10-27、メンテナ判断）。

## `reactCompiler: "auto"` → `"opt-out"`

### 変更前

pluginの`reactCompiler`は`"auto"`（既定）と`"off"`の2値だった。`"auto"`はReact Compilerを検出せず、変換したすべての関数に常に`"use no memo"`を付ける。名前が「検出して必要なときだけ付ける」と読めるため、ロードマップのM9の節で改名を候補にしていたが、M9（D5）と一緒に見送っていた。

### 変更後

- 値を`"opt-out"` | `"off"`にした。挙動と既定値は変えていない。名前はメンテナが`"opt-out"`・`"no-memo"`・`"mark"`から選んだ。
- **値の検証を追加した。** transformは`=== "opt-out"`で比較するため、改名前の`"auto"`や綴り間違いをそのまま受け付けると、ディレクティブが付かない`"off"`と同じ挙動になる。React Compilerと併用していると、エラーなしで更新が止まる。これを防ぐため、plugin作成時に`"opt-out"`と`"off"`以外をTypeErrorにした（`diagnostics.errorOn`の未知IDの検証と同じ場所・同じ形）。`"auto"`には改名を案内する一文を付ける。
- テスト: `tests/unplugin.test.ts`の`reactCompiler option`に、`"auto"`・未知の値がthrowすること、2つの正しい値が通ることを追加した。既存テストの`"auto"`は`"opt-out"`に置き換えた。
- docs: plugin README（英日）、`docs/guides/hooks.md`（英日）、website（`managed-transform.mdx`、`migration.mdx`）、設計メモ`react-compiler-compatibility`（英日。旧名を併記）、移行ガイド（英日。表・節・チェックリスト）、リリースノート（Breaking Changes）。`m0-cleanup.ja.md`などの過去の記録は書き換えていない。

## `DeepReadonly<unknown>`が`{}`になる

### 原因

`DeepReadonly<T>`は、leafでもcollectionでもない`T`をmapped typeで写す。`unknown`はどの分岐にも当たらないため、`{ readonly [K in keyof unknown]: ... }` = `{}`になる。`deepSignal<{ data: unknown }>(...).peek().data`が`{}`と型付けされ、`null`/`undefined`があり得ないかのように扱われていた（`any`は元から`any`のまま）。

### 修正

先頭に`unknown extends T ? T`を足し、`unknown`と`any`をそのまま返すようにした。分配（union）の挙動は、内側の条件型で従来どおり働く。

## `PlainRoot`に明示的なunion型引数を渡すとcollectionが通る

### 原因

`PlainRoot<T> = T & (T extends Collection ? never : unknown)`の条件型が`T`について分配される。`deepSignal<{ a: number } | Map<string, number>>(new Map())`では、`unknown | never` = `unknown`になり、型を通って実行時にTypeErrorになっていた。

### 修正

`[Extract<T, Collection>] extends [never] ? unknown : never`にして、unionの1要素でもcollectionなら拒否する。`any`（`deepSignal(x as any)`）を拒否しないよう、`unknown extends T ? unknown`のガードを先に置いた（ガードなしでは`Extract<any, ...>`が`any`になり、拒否されることを確認した）。

### 対応しないもの

`deepSignal<object>(new Map())`は通る。`Map`は`object`に代入できるため、構造的な型では区別できない。実行時の入口のTypeErrorで捕まる。

### テスト

`tests/deep-signal-peek-types.ts`（`unknown`のプロパティが`{}`にならない、`any`はそのまま）と`tests/deep-signal-collections-types.ts`（unionの型引数のMapは拒否、plain objectのunionと`any`は通る）に追加した。修正前の型では、追加した`@ts-expect-error`の2件が未使用エラーになることを確認した。

## 互換性

- `reactCompiler: "auto"`を明示的に書いていた設定は、plugin作成時にthrowする。既定値のままの利用者には影響がない。
- 型の2件は、どちらもv0.4で入った型（`DeepReadonly`、`PlainRoot`）の修正で、v0.3からの移行手順は変わらない。

## ゲート

すべて成功した（2026-10-27）。

- `pnpm lint`（既存の警告1件、`deep-signal-engine.ts`の`modeError`。今回は未変更）
- `pnpm typecheck`
- `pnpm exec vitest run --maxWorkers=2`: 43ファイル、934件
- `pnpm test:transform`: 8ファイル、734件
- `pnpm build`、`pnpm size`（型だけの変更とplugin側の変更なので、runtimeのサイズは変わらない）、`pnpm test:consumer`
- `pnpm test:browser`: 53件
- websiteのbuild
