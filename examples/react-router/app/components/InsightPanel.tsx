import { Suspense, use, useRef } from "react";
import type { TaskStore } from "../lib/task-store.js";

const INSIGHT_DELAY_MS = 150;

/**
 * Simulates a brief async computation (e.g. an aggregation call) before
 * <Insight> below can render. Cached in a ref, not module scope, so a
 * concurrent request during streaming SSR never shares this promise with
 * another -- the same per-request lifetime useTaskStore's useRef gives the
 * store itself.
 *
 * It must be called from <InsightPanel>, *outside* the Suspense boundary,
 * never from <Insight> itself: a component that suspends before it has ever
 * committed has its hook state thrown away, so a promise created during
 * <Insight>'s own render is a brand-new one on every retry. That never
 * settles from React's point of view -- each retry suspends again on a fresh
 * promise -- so the boundary stays on its fallback and <Insight> re-renders
 * every INSIGHT_DELAY_MS forever. <InsightPanel> commits (its subtree is what
 * suspends, not it), so its ref survives and every retry `use()`s the same
 * promise.
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
function Insight({ store, delay }: { store: TaskStore; delay: Promise<void> }) {
  use(delay);
  return <p className="insight">記録された操作: {store.state.value.activity.length}件</p>;
}

/** Its own Suspense boundary so the rest of the route ships in the initial
 * shell while only this panel streams in once its "computation" is ready. */
export function InsightPanel({ store }: { store: TaskStore }) {
  const delay = useSimulatedDelay(INSIGHT_DELAY_MS);

  return (
    <Suspense fallback={<p className="insight insight-loading">集計中…</p>}>
      <Insight store={store} delay={delay} />
    </Suspense>
  );
}
