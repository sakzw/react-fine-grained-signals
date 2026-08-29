/** @jsxImportSource react-fine-grained-signals */
import { useEffect } from "react";
import {
  effect,
  isSignal,
  untracked,
  useDeepSignalValue,
  useSignal,
  useSignalValue,
  type ReadonlySignal,
  type Signal,
} from "react-fine-grained-signals";
import type { Filter, TaskStore } from "../lib/task-store.js";

const FILTER_LABEL: Record<Filter, string> = {
  all: "すべて",
  active: "未完了",
  done: "完了済み",
};

/** Mirrors the browser PoC's CustomSignalConsumer: shows whether the value
 * it received is actually a signal, via isSignal(). */
function RawSignalProbe({
  label,
  source,
}: {
  label: string;
  source: ReadonlySignal<unknown>;
}) {
  return (
    <p>
      {label}: <code>isSignal = {String(isSignal(source))}</code>
    </p>
  );
}

export function DevPanel({
  store,
  filter,
}: {
  store: TaskStore;
  filter: Signal<Filter>;
}) {
  // A low-level explicit leaf subscription, distinct from the useComputed
  // booleans that drive the filter tabs' Switch/Match below.
  const currentFilter = useSignalValue(filter);

  // A selective read off the deep store: total count, as opposed to
  // store.remaining (not-done count) shown in the nav badge.
  const totalTasks = useDeepSignalValue(store.state, (value) => value.tasks.length, []);

  const verbose = useSignal(false);

  useEffect(() => {
    // A raw effect(), not useSignalEffect(): started once on mount and
    // disposed on unmount, independent of any component render.
    return effect(() => {
      const entries = store.state.value.activity;
      // .length/[0] must be read here for this to depend on the array's
      // contents — see the "list computeds must traverse the array" note.
      const latest = entries.length > 0 ? entries[0] : undefined;
      if (!latest) return;

      // untracked() reads the verbose flag WITHOUT depending on it: toggling
      // the checkbox alone must not re-run this effect, only new activity
      // entries should.
      if (untracked(() => verbose.value)) {
        console.log("[react-fine-grained-signals] activity:", latest.message);
      }
    });
  }, [store, verbose]);

  return (
    <section className="dev-panel">
      <h2>開発者パネル</h2>
      <p>現在のフィルタ: {FILTER_LABEL[currentFilter]}</p>
      <p>総タスク数: {totalTasks}</p>
      <RawSignalProbe label="store.remaining" source={store.remaining} />
      {/* checked={verbose} direct-binds the write direction (signal -> DOM),
          same as home.tsx's newTitle input value={}; reading the user's
          toggle back into the signal is still the ordinary onChange, which
          direct binding does not automate away — see docs/jsx-bindings.md. */}
      <label>
        <input
          type="checkbox"
          checked={verbose}
          onChange={(event) => {
            verbose.value = event.target.checked;
          }}
        />
        詳細ログ(アクティビティ追加時のみconsoleに出力。このチェックボックス自体の
        切り替えでは再実行されない)
      </label>
    </section>
  );
}
