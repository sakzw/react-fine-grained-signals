import { Suspense, use, useRef } from "react";
import type { TaskStore } from "../lib/task-store.js";

const INSIGHT_DELAY_MS = 2500; // TEMP for manual verification screenshot

/**
 * Simulates a brief async computation (e.g. an aggregation call) before
 * <Insight> below can render. Cached in a ref, not module scope, so a
 * concurrent request during streaming SSR never shares this promise with
 * another -- the same per-request lifetime useTaskStore's useRef gives the
 * store itself.
 */
function useSimulatedDelay(ms: number): Promise<void> {
  const delayRef = useRef<Promise<void> | undefined>(undefined);
  if (delayRef.current === undefined) {
    delayRef.current = new Promise((resolve) => setTimeout(resolve, ms));
  }
  return delayRef.current;
}

/**
 * What this proves: the activity count below is read only after `use()`
 * resumes this component, so whatever the deferred segment actually streams
 * reflects the value at that moment -- never whatever it was when the
 * promise above was created, before this component first suspended. React
 * re-invokes a suspended component from scratch on resume, so a signal read
 * placed after (never cached in a variable before) `use()` gets this for
 * free -- mirroring the regression this repo's tests/ssr.test.tsx guards
 * (search it for renderToPipeableStream).
 */
function Insight({ store }: { store: TaskStore }) {
  use(useSimulatedDelay(INSIGHT_DELAY_MS));
  return <p className="insight">記録された操作: {store.state.value.activity.length}件</p>;
}

/** Its own Suspense boundary so the rest of the route ships in the initial
 * shell while only this panel streams in once its "computation" is ready. */
export function InsightPanel({ store }: { store: TaskStore }) {
  return (
    <Suspense fallback={<p className="insight insight-loading">集計中…</p>}>
      <Insight store={store} />
    </Suspense>
  );
}
