import { useSignalTracking } from "react-fine-grained-signals";
import type { ActivityEntry } from "../lib/task-store.js";

/**
 * Same reasoning as TaskRow for *why* it needs its own subscription: plain
 * property access, no `.value` token. Unlike TaskRow, this file is excluded
 * from the build plugin's transform (see vite.config.ts) and calls the bare
 * useSignalTracking() boundary by hand. That boundary is best-effort, and with
 * React Compiler in the build the component must opt out of memoization.
 */
export function ActivityRow({ entry, slot }: { entry: () => ActivityEntry; slot: number }) {
  "use no memo";

  useSignalTracking();
  return (
    <li className="activity-row">
      <span className="slot">#{slot}</span>
      <span>{entry().message}</span>
    </li>
  );
}
