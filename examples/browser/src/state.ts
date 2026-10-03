import { computed, signal } from "react-fine-grained-signals";

/** Counts how often a tracked reader's computed is re-evaluated (client only). */
function countedComputed(source: { readonly value: number }, name: string) {
  return computed(() => {
    if (typeof document !== "undefined") {
      const counts = ((globalThis as { rfgsEvaluations?: Record<string, number> }).rfgsEvaluations ??= {});
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return source.value;
  });
}

export function createDemoState() {
  const hiddenTrackedSource = signal(0);
  return {
    reattachStyle: signal<Record<string, string>>({ width: "80px", height: "40px" }),
    hiddenTrackedSource,
    hiddenBare: countedComputed(hiddenTrackedSource, "bare"),
    hiddenManaged: countedComputed(hiddenTrackedSource, "managed"),
    count: signal(0),
    title: signal("initial title"),
    hidden: signal(false),
    disabled: signal(false),
    status: signal("idle"),
    customLabel: signal("custom initial"),
    lifecycleTitle: signal("lifecycle initial"),
    boxStyle: signal<Record<string, string>>({
      width: "80px",
      height: "40px",
      background: "steelblue",
    }),
    imeText: signal("initial"),
    refErrorTitle: signal("ref initial"),
    activityStyle: signal<Record<string, string>>({
      width: "80px",
      height: "40px",
      outline: "3px solid crimson",
    }),
    suspenseStyle: signal<Record<string, string>>({
      display: "flex",
      color: "rgb(0, 0, 255)",
    }),
  };
}

export type DemoState = ReturnType<typeof createDemoState>;
