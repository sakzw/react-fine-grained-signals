/** @jsxImportSource react-fine-grained-signals */
import { useOutletContext } from "react-router";
import { useComputed, useSignal, useSignalEffect } from "react-fine-grained-signals";
import { For, Show, Switch, Match } from "react-fine-grained-signals/utils";
import { DevPanel } from "../components/DevPanel.js";
import { TaskRow } from "../components/TaskRow.js";
import {
  addTask,
  clearCompleted,
  markAllDone,
  toggleTask,
  type Filter,
  type TaskStore,
} from "../lib/task-store.js";

export function meta() {
  return [{ title: "タスクボード — react-fine-grained-signals React Router PoC" }];
}

export default function Home() {
  const store = useOutletContext<TaskStore>();
  const filter = useSignal<Filter>("all");
  const newTitle = useSignal("");

  // store is a plain object (not itself a signal), so it must be listed as
  // a dependency for a no-deps-mode getter to stay valid.
  const allTasks = useComputed(() => store.state.value.tasks.slice(), [store]);
  const taskList = useComputed(() => {
    switch (filter.value) {
      case "active":
        return allTasks.value.filter((task) => !task.done);
      case "done":
        return allTasks.value.filter((task) => task.done);
      default:
        return allTasks.value;
    }
  });
  const hasTasks = useComputed(() => taskList.value.length > 0);

  const isAll = useComputed(() => filter.value === "all");
  const isActive = useComputed(() => filter.value === "active");
  const isDone = useComputed(() => filter.value === "done");

  const hasCompleted = useComputed(() => allTasks.value.some((task) => task.done));
  const isClearDisabled = useComputed(() => !hasCompleted.value);

  useSignalEffect(() => {
    document.title = `タスク(残り${store.remaining.value}) — react-fine-grained-signals`;
  }, [store]);

  return (
    <main className="task-board">
      <h1>タスクボード</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          addTask(store, newTitle.value);
          newTitle.value = "";
        }}
      >
        <input
          type="text"
          placeholder="新しいタスク"
          value={newTitle}
          onChange={(event) => {
            newTitle.value = event.target.value;
          }}
        />
        <button type="submit">追加</button>
      </form>

      <div className="filter-tabs" role="tablist">
        <button type="button" onClick={() => (filter.value = "all")} data-status={isAll}>
          すべて
        </button>
        <button type="button" onClick={() => (filter.value = "active")} data-status={isActive}>
          未完了
        </button>
        <button type="button" onClick={() => (filter.value = "done")} data-status={isDone}>
          完了済み
        </button>
      </div>

      <Switch>
        <Match when={isAll}>
          <p className="filter-hint">すべてのタスクを表示中</p>
        </Match>
        <Match when={isActive}>
          <p className="filter-hint">未完了のタスクのみ表示中</p>
        </Match>
        <Match when={isDone}>
          <p className="filter-hint">完了済みのタスクのみ表示中</p>
        </Match>
      </Switch>

      <Show when={hasTasks} fallback={<p className="empty-state">タスクがありません。</p>}>
        <ul className="task-list">
          <For each={taskList} by={(task) => task.id}>
            {(task) => <TaskRow task={task} onToggle={(id) => toggleTask(store, id)} />}
          </For>
        </ul>
      </Show>

      <div className="bulk-actions">
        <button type="button" onClick={() => markAllDone(store)}>
          すべて完了にする
        </button>
        <button
          type="button"
          onClick={() => clearCompleted(store)}
          disabled={isClearDisabled}
        >
          完了済みをクリア
        </button>
      </div>

      <DevPanel store={store} filter={filter} />
    </main>
  );
}
