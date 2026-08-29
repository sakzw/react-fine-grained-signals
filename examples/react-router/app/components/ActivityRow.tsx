import { useSignals } from "react-fine-grained-signals/runtime";
import type { ActivityEntry } from "../lib/task-store.js";

/**
 * Same reasoning as TaskRow for *why* it needs its own subscription: plain
 * property access, no `.value` token. Unlike TaskRow, this file is excluded
 * from the build plugin's transform (see vite.config.ts) and reaches for the
 * manual react-fine-grained-signals/runtime boundary directly instead -- the
 * documented exact-boundary alternative for a component you want correct
 * independent of build-tool configuration. useSignals() here returns a scope
 * handle that must be closed with f() in a finally, not the plugin-provided
 * convenience hook TaskRow uses.
 */
export function ActivityRow({
  entry,
  slot,
}: {
  entry: () => ActivityEntry;
  slot: number;
}) {
  const scope = useSignals();
  try {
    return (
      <li className="activity-row">
        <span className="slot">#{slot}</span>
        <span>{entry().message}</span>
      </li>
    );
  } finally {
    scope.f();
  }
}
