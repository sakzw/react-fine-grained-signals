# Computedが等値へ再評価された場合の余分な同期再render

状態: 調査のみ。実装は見送り。

## 挙動

concurrent renderがyieldしている間に書き込みがあり、その書き込みで再評価された`computed`が等値の結果になる場合でも、render終了時のconsistency checkはそのrenderを「変化あり」と扱い、同期再renderを1回行う。commitは1回で、混在表示や誤った値は出ない。M19.4の「残る制約」に記載した挙動と同じ。

`tests/react-concurrent-commit-consistency.test.tsx`の「a computed that re-evaluates to an equal value costs one extra render, not a commit」（cold/warm）で固定した。値が変わる場合に再renderすることは同ファイルの対照テストで確認している。

## 原因

`isRenderAttemptCurrent`が`false`を返すのは、attemptが持つspeculativeなentryの依存元（上の例では`count`）のrevisionが動いたため。revisionの比較ではComputedの結果が等しいかを知る手段がなく、確認するにはgetterを再評価する必要がある。

## 見送りの理由

等値判定を入れるには次が必要になる。

- `isRenderAttemptCurrent`（ReactのgetSnapshot経由）の中でユーザーのgetterを再評価する。例外、effectを作るgetter、別コピーのforeign computedを扱う必要がある。
- 等値だった場合、attemptのentryと依存revisionを新しい評価結果へ差し替える。差し替えないとcommit時の`promoteComputed`がrevision不一致で失敗し、commit後に再通知してしまう。
- M19.4で修正したばかりのconsistency checkの経路を変更する。

得られるのはrender途中のwriteでComputedの結果が変わらなかった場合の再render 1回の削減だけで、正確性には影響しない。リスクに見合わないため、現行の挙動を特性テストで固定するに留める。実アプリのprofileで問題が確認された場合に再検討する。
