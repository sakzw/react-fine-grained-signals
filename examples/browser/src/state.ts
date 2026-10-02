import { signal } from "react-fine-grained-signals";

export function createDemoState() {
  return {
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
