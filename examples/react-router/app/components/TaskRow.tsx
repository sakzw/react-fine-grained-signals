import { useSignals } from "react-alien-signals";
import type { Task } from "../lib/task-store.js";

/**
 * A deep-signal item read as plain property access (`task.done`, no `.value`
 * at this level) has no literal `.value` token in this file, so the
 * plugin's `mode: "auto"` transform cannot statically detect it and won't
 * wrap this component. Calling useSignals() explicitly is the documented
 * way to give this row its own tracking scope — otherwise toggling one task
 * would have nothing here to notify, and reading it inside <For>'s own
 * render instead would make every row rerender together.
 */
export function TaskRow({
  task,
  onToggle,
}: {
  task: Task;
  onToggle: (id: string) => void;
}) {
  useSignals();

  return (
    <li className={task.done ? "task-row done" : "task-row"}>
      <label>
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => onToggle(task.id)}
        />
        {task.title}
      </label>
    </li>
  );
}
