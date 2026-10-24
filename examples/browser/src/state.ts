import { signal } from "react-fine-grained-signals";

export function createDemoState() {
  return {
    count: signal(0),
    title: signal("initial title"),
    hidden: signal(false),
    disabled: signal(false),
    status: signal("idle"),
    customLabel: signal("custom initial"),
    boxStyle: signal<Record<string, string>>({
      width: "80px",
      height: "40px",
      background: "steelblue",
    }),
    imeText: signal("initial"),
    resetText: signal("reset initial"),
    resetChecked: signal(false),
    resetChoice: signal("a"),
    resetChoices: signal<string[]>(["a"]),
  };
}

export type DemoState = ReturnType<typeof createDemoState>;
