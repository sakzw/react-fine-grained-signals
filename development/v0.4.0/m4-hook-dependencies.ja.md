# M4 Hookの依存配列の統一と`useWritableComputed`

- 基準: M3完了時点（`a42757c`）

## 変更

- **ルール**: 全Hookで「依存配列の省略は`[]`と同じ」。省略と`[]`の切り替えはエラーにしない。長さの変更は引き続きthrowする。
  - `useSignalEffect`: 変更なし（もともとこの意味）。
  - `useComputed`: 省略を長さ`-1`の別モードとして扱う実装をやめ、`deps?.length ?? 0`の長さだけを固定する。
  - `useDeepSignalValue`: 同じ。`UseDeepSignalValueModeChangeError`の経路を削除。
- **`useWritableComputed({ get, set }, deps?)`を追加**し、`useComputed`はgetterだけを受け付ける。capability切り替えのエラー（`UseComputedCapabilityChangeError`）は型で防げるので削除した。戻り値は`FormBindableSignal<T>`（M7で`Signal<T>`に統合）。プリミティブの`computed({ get, set })`は変えていない。
- 長さの検査は共通の内部Hook `useFixedDependencyLength`にまとめた。エラー名は`UseComputedDependencyLengthChangeError`、`UseWritableComputedDependencyLengthChangeError`、`UseDeepSignalValueDependencyLengthChangeError`。
- `useComputed`/`useDeepSignalValue`の依存配列の扱いは、既存の挙動のうち「省略 → 空配列扱いのmemo」と同じ（実際の意味は変わらない）。変わるのは、省略⇔`[]`が例外にならなくなった点と、省略⇔非空が「mode変更」ではなく「長さ変更」の例外になった点（メッセージが変わる）。

## 移行したもの

`useComputed({ get ... })`の呼び出しを`useWritableComputed`に置き換えた: `tests/jsx-types.tsx`、`react-hooks.test.tsx`、`ssr.test.tsx`、`docs/guides/jsx-bindings.md`（英日）。examples・website・benchmarksに該当の呼び出しはなかった。docs（`hooks.md`英日、website `react-hooks.mdx`）を新ルールと`useWritableComputed`の節に更新。`website/src/pages/migration.mdx`はv0.2→v0.3の履歴なので変更していない。

## テスト

- 削除: mode切り替えのテスト（`useComputed`、`useDeepSignalValue`の省略⇔明示）、capability切り替えのテスト。
- 追加: 省略と`[]`が同じ（identityが保たれる、`useComputed`・`useWritableComputed`・`useDeepSignalValue`）、省略⇔非空の長さ変更でthrow、`useWritableComputed`の長さ変更でthrow、`tests/use-computed-types.ts`（`@ts-expect-error`で、`useComputed`がオプション形式を受けないこと、`useWritableComputed`がgetterを受けないこと、読み取り専用が書き込み可能に代入できないこと）。
- 件数: runtime 41ファイル・911件。

## Fast Refresh

`development/v0.3.0/m18.21-fast-refresh.mjs`を`development/v0.4.0/m4-fast-refresh.mjs`に複製し、writableの呼び出しを`useWritableComputed`に変えて実行した。スクリプト内のassertion（HMR後のcomputed再生成・local stateの保持・effectのcleanup・setterの実行）はすべて通り、例外なく完了した（Vite 8.3.4、React 19.3.0）。

## サイズ

`core+hooks` 8.34 → 8.21 kB、`deep` 12.92 → 12.82、`index-full` 16.37 → 16.17（mode判定の削除分）。予算を`pnpm size:update`で下げた。

## ゲート

lint、typecheck、runtime vitest（41ファイル・911件）、`pnpm size`、`test:consumer`、`test:browser`は通過した。transformは既知の不安定な2件（esbuild adapter、webpack RSC）が負荷時に落ちたが、単独実行では61件すべて成功。`test:browser`は1回目に3件、2回目に1件（Firefoxの`page.goto`が30秒でtimeout）が落ち、Firefox単独の再実行では14件すべて成功した（環境要因）。CIは push 後に確認する。
