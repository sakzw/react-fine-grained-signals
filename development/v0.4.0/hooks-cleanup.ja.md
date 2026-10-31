# v0.4.0 hooksの整理（structural fallbackの削除、依存配列の長さエラーの統一）

- 基準: `67fef04`
- 対象: `src/react/hooks.ts`、`src/core/readable-subscription.ts`、`src/runtime/jsx.ts`

## `useSignalValue`のstructural fallbackを削除した（実行時のbreaking change）

`useSignalValue`は、`subscribeLocalReadable`が`undefined`を返す値（本パッケージのreadableでない値）を、effectで購読するfallbackで受け付けていた。`Signal`/`ReadonlySignal`が名目的な型になり（M7）、別コピーとの相互運用もなくなった（M1）ため、型の合った呼び出しはこのfallbackに届かない。

- render中に`TypeError("useSignalValue expects a signal or computed created by react-fine-grained-signals")`をthrowするようにした。素のJavaScriptで`{ value }`や数値を渡した場合が対象。subscribeの中ではなくrender中に投げるので、Error Boundaryで捕まえられ、SSRでも同じように失敗する。別コピーのsignalは、これまでどおり`isSignal`が「Multiple copies」をthrowする。
- `deepSignal`のルートは、実行時には受け付けたままにした。`DeepSignalImpl`は`delegateSubscription`で内部sourceに購読を委譲するため、ルートの置き換えは追える（ネストした変更は追わない）。型では`NotDeepSignal`で拒否している。throwにしなかった理由は次のとおり。
  - JSXのsignal子要素（`SignalValue`）が`useSignalValue`を使っており、deep signalの子要素もこの経路を通る。ここでthrowすると、`useSignalValue`を呼んでいない子要素でも`useSignalValue`の名前が出るエラーになる。
  - bindingするhost propのdeep signalも同じ委譲で購読しており、挙動をそろえられる。
  - deep signalの検出をrender中に足す必要がない。
- `subscribeLocalReadable`は、ローカルでないreadableに`undefined`を返す代わりに`TypeError`をthrowするようにした。呼び出し側はどちらも`isSignal`で確認済みの値だけを渡すため、内部の不変条件の違反として扱う。
- JSX bindingの`createBindingSubscription`にも、同じ死んだfallback（`detachedEffect(update)`）があった。binding sourceは`isWritableSignal`、`isReactiveHostProp`、style entryの`isSignal`のどれかを通っているので届かない。削除した。plain valueのpropはbindingにならないため、挙動は変わらない。lite JSX runtimeは`subscribeLocalReadable`を直接呼ばず、`normalizeChild`経由で`useSignalValue`を使うだけなので、変更はない。
- `createEffectBackedStoreSubscription`はdeep selector store専用として残し、コメントを直した。

テスト（`tests/react-hooks.test.tsx`）: structural readableの購読とError Boundaryへのエラー転送の2件を削除し、`{ value, peek }`、文字列、`null`がrender中に`TypeError`になるテストと、deep signalのルートが実行時に置き換えだけを追うテストを追加した。`tests/effect-lifecycle.test.ts`は`undefined`を返すテストをthrowのテストに替え、deep signalのルートの委譲購読のテストを追加した。

## 依存配列の長さのエラーを統一した（メッセージ文のみのbreaking change）

`useDeepSignalValue`と`useSignalEffect`が、`useComputed`と`useWritableComputed`の使う`useFixedDependencyLength`と同じ確認をinlineで持っていた。`useDeepSignalValue`はメッセージも長く、別の文面だった。4つとも`useFixedDependencyLength`を使うようにした。

- メッセージ: `<hook>: dependencies length changed from N to M; keep the array the same length on every render.`
  - 旧文面の「matching useMemo's rules」は入れなかった。`useSignalEffect`は`useEffect`、ほかは`useMemo`に渡すため、1つの文面では言い当てられない。
- `error.name`はhookごとのまま（`UseComputedDependencyLengthChangeError`、`UseWritableComputedDependencyLengthChangeError`、`UseDeepSignalValueDependencyLengthChangeError`、`UseSignalEffectDependencyLengthChangeError`）。
- hookの呼び出し順は変わらない（`useRef`のあとに`useMemo`/`useEffect`）。

## サイズ（gzip）

| entry            | 変更前   | 変更後   |
| ---------------- | -------- | -------- |
| core+hooks       | 7.20 kB  | 7.17 kB  |
| deep             | 9.87 kB  | 9.83 kB  |
| deep-collections | 13.19 kB | 13.15 kB |
| index-full       | 15.84 kB | 15.76 kB |
| jsx-runtime      | 11.29 kB | 11.27 kB |
| full-jsx-child   | 11.21 kB | 11.19 kB |
| lite-jsx-child   | 5.23 kB  | 5.21 kB  |

`signal-only`、`core`、`utils`は変わらない。すべて予算内。
