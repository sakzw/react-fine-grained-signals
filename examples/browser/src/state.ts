import { signal } from "react-alien-signals";

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
  };
}

export type DemoState = ReturnType<typeof createDemoState>;
