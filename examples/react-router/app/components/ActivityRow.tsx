import { useSignals } from "react-alien-signals";
import type { ActivityEntry } from "../lib/task-store.js";

/** Same reasoning as TaskRow: plain property access, no `.value` token, so
 * this row owns its subscription explicitly via useSignals(). */
export function ActivityRow({
  entry,
  slot,
}: {
  entry: () => ActivityEntry;
  slot: number;
}) {
  useSignals();

  return (
    <li className="activity-row">
      <span className="slot">#{slot}</span>
      <span>{entry().message}</span>
    </li>
  );
}
