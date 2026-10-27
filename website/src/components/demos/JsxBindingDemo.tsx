/** @jsxImportSource react-fine-grained-signals/jsx */
"use client";

import { useComputed, useSignal } from "react-fine-grained-signals";
import { button, muted, row } from "./styles";

/**
 * The component never reads `.value` during render: the signals are handed to
 * native elements as children and props, and the JSX runtime updates those
 * DOM nodes directly. `peek()` shows the value the component's own last
 * render saw, which stays at 0 because the component never re-renders.
 */
export function JsxBindingDemo() {
  const clicks = useSignal(0);
  const hue = useComputed(() => (clicks.value * 47) % 360);
  const color = useComputed(() => `hsl(${hue.value} 70% 45%)`);
  const title = useComputed(() => `Clicked ${clicks.value} times`);
  const odd = useComputed(() => clicks.value % 2 === 1);

  return (
    <div data-demo="jsx" style={{ display: "grid", gap: "0.5rem" }}>
      <div style={row}>
        <button type="button" style={button} title={title} onClick={() => clicks.value++}>
          Clicks: {clicks}
        </button>
        <span
          data-testid="swatch"
          style={{ background: color, borderRadius: 4, display: "inline-block", height: 20, width: 40 }}
        />
        <span data-testid="hue">hue {hue}°</span>
        <span hidden={odd}>(even)</span>
      </div>
      <div style={muted}>
        Value seen by the component's last render: <span data-testid="rendered">{clicks.peek()}</span>
      </div>
    </div>
  );
}
