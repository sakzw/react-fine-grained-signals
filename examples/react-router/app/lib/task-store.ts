import { useRef } from "react";
import { batch, computed, deepSignal } from "react-fine-grained-signals";

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export interface ActivityEntry {
  id: string;
  message: string;
}

export type Filter = "all" | "active" | "done";

interface StoreState {
  tasks: Task[];
  activity: ActivityEntry[];
}

// Comfortably above LogSettingsForm's maxVisible upper bound (10) so that
// control actually has room to show fewer than everything once enough
// actions have happened.
const MAX_ACTIVITY_ENTRIES = 20;

/** Fixed, deterministic seed: SSR and the client's first render must match. */
function seedState(): StoreState {
  return {
    tasks: [
      { id: "seed-1", title: "Read the README", done: true },
      { id: "seed-2", title: "Try the browser PoC", done: true },
      { id: "seed-3", title: "Try this React Router PoC", done: false },
    ],
    activity: [{ id: "seed-activity-1", message: "ボードを開きました" }],
  };
}

/**
 * A raw deepSignal + computed combined into one store, built without the
 * useDeepSignal/useComputed hooks. Those hooks each manage exactly one
 * signal; this is the pattern for bundling several core primitives into a
 * custom store of your own.
 */
export function createTaskStore() {
  const state = deepSignal(seedState());
  const remaining = computed(
    () => state.value.tasks.filter((task) => !task.done).length,
  );
  return { state, remaining };
}

export type TaskStore = ReturnType<typeof createTaskStore>;

/**
 * Same useRef-based stability useSignal/useDeepSignal use internally,
 * applied to the composite store above so it survives re-renders but is
 * still created fresh per request/mount (never at module scope).
 */
export function useTaskStore(): TaskStore {
  const storeRef = useRef<TaskStore | undefined>(undefined);
  if (storeRef.current === undefined) {
    storeRef.current = createTaskStore();
  }
  return storeRef.current;
}

function pushActivity(store: TaskStore, message: string): void {
  store.state.value.activity.unshift({
    id: crypto.randomUUID(),
    message,
  });
  if (store.state.value.activity.length > MAX_ACTIVITY_ENTRIES) {
    store.state.value.activity.length = MAX_ACTIVITY_ENTRIES;
  }
}

// batch() groups the multi-write actions below into one notification each.
// Single-write actions (like changing the filter) don't need it.

export function addTask(store: TaskStore, title: string): void {
  const trimmed = title.trim();
  if (trimmed === "") return;

  batch(() => {
    store.state.value.tasks.push({
      id: crypto.randomUUID(),
      title: trimmed,
      done: false,
    });
    pushActivity(store, `追加: ${trimmed}`);
  });
}

export function toggleTask(store: TaskStore, id: string): void {
  batch(() => {
    const task = store.state.value.tasks.find((candidate) => candidate.id === id);
    if (!task) return;
    task.done = !task.done;
    pushActivity(store, `${task.done ? "完了" : "未完了に戻す"}: ${task.title}`);
  });
}

export function markAllDone(store: TaskStore): void {
  batch(() => {
    let changed = 0;
    for (const task of store.state.value.tasks) {
      if (!task.done) {
        task.done = true;
        changed += 1;
      }
    }
    if (changed > 0) pushActivity(store, `${changed}件をすべて完了にしました`);
  });
}

export function clearCompleted(store: TaskStore): void {
  batch(() => {
    const before = store.state.value.tasks.length;
    store.state.value.tasks = store.state.value.tasks.filter((task) => !task.done);
    const removed = before - store.state.value.tasks.length;
    if (removed > 0) pushActivity(store, `完了済み${removed}件をクリアしました`);
  });
}
