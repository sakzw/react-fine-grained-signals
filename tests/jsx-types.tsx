/** @jsxImportSource react-alien-signals */

import { signal } from "../src/index.js";

const text = signal("value");
const enabled = signal(false);
const boxStyle = signal({ color: "red" });

function Custom({ value, children }: { value: typeof text; children: typeof text }) {
  return <output>{value === children ? "same" : "different"}</output>;
}

// HTML direct bindings and signal children are supported.
const html = (
  <button disabled={enabled} aria-label={text} data-state={text}>
    {text}
  </button>
);

// `style` accepts the coarse whole-object form.
const styled = <div style={boxStyle} />;

// `value` and `checked` are direct-bindable on the controlled-input tags.
const controlledInput = <input value={text} checked={enabled} onChange={() => {}} />;
const controlledTextarea = <textarea value={text} onChange={() => {}} />;
const controlledSelect = (
  <select value={text} onChange={() => {}}>
    <option value="value">value</option>
  </select>
);

// Signal children work for every native host, including non-HTML hosts.
const svgChild = <svg>{text}</svg>;

// Direct signal bindings are intentionally constrained to HTML hosts.
// @ts-expect-error `div` does not support the `disabled` property.
const unsupportedHtmlBinding = <div disabled={enabled} />;
// @ts-expect-error SVG properties do not support direct signal bindings.
const unsupportedSvgBinding = <svg title={text} />;
// @ts-expect-error SVG does not support the `style` direct binding either.
const unsupportedSvgStyle = <svg style={boxStyle} />;

// Component props and children remain fully transparent.
const component = <Custom value={text}>{text}</Custom>;

void [
  html,
  styled,
  controlledInput,
  controlledTextarea,
  controlledSelect,
  svgChild,
  unsupportedHtmlBinding,
  unsupportedSvgBinding,
  unsupportedSvgStyle,
  component,
];
