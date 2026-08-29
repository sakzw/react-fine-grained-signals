import { useOutletContext } from "react-router";
import { useComputed, useDeepSignal } from "react-fine-grained-signals";
import { Index } from "react-fine-grained-signals/utils";
import { ActivityRow } from "../components/ActivityRow.js";
import { InsightPanel } from "../components/InsightPanel.js";
import { LogSettingsForm } from "../components/LogSettingsForm.js";
import type { TaskStore } from "../lib/task-store.js";

export function meta() {
  return [{ title: "アクティビティ — react-fine-grained-signals React Router PoC" }];
}

export default function Activity() {
  const store = useOutletContext<TaskStore>();

  // Route-local display settings: a plain useDeepSignal, separate from the
  // shared useTaskStore composite above it in the tree. The controls that
  // read/write it live in LogSettingsForm.
  const settings = useDeepSignal(() => ({ maxVisible: 8, reverseOrder: false }));

  // `store` is captured (a non-signal, listed as a dependency); `settings`
  // is itself a signal, so reading settings.value here needs no dep entry.
  const visibleEntries = useComputed(() => {
    const entries = store.state.value.activity.slice();
    if (settings.value.reverseOrder) entries.reverse();
    return entries.slice(0, settings.value.maxVisible);
  }, [store]);

  return (
    <main className="activity-log">
      <h1>アクティビティログ</h1>
      <p className="hint">
        タスクボードでの操作(追加・切替・クリア)を記録します。ここでは行の
        <strong>同一性</strong>ではなく<strong>位置</strong>
        (スロット0=最新)に意味があるため、識別子キーが必須の <code>For</code>{" "}
        ではなく <code>Index</code> で描画しています。
      </p>

      <InsightPanel store={store} />
      <LogSettingsForm settings={settings} />

      <ol className="activity-list">
        <Index each={visibleEntries}>
          {(entry, index) => <ActivityRow entry={entry} slot={index} />}
        </Index>
      </ol>
    </main>
  );
}
