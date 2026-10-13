/** @jsxImportSource react-fine-grained-signals */

import { signal } from "../src/index.js";

const text = signal("value");
const enabled = signal(false);
const boxStyle = signal({ color: "red" });
const color = signal("blue");
const nullishText = signal<string | null | undefined>(null);

function Custom({ value, children }: { value: typeof text; children: typeof text }) {
  return <output>{value === children ? "same" : "different"}</output>;
}

// HTML direct bindings and signal children are supported.
const html = (
  <button disabled={enabled} aria-label={text} data-state={text}>
    {text}
  </button>
);

// `style` accepts whole-object and property-level signal bindings.
const styled = <div style={boxStyle} />;
const partiallyStyled = <div style={{ color, width: 12 }} />;

// `value` and `checked` are direct-bindable on the controlled-input tags.
const controlledInput = <input value={text} checked={enabled} onChange={() => {}} />;
const controlledTextarea = <textarea value={text} onChange={() => {}} />;
// `title` and `id` remove their attributes when a direct binding becomes nullish.
const nullishTitleAndId = <div title={nullishText} id={nullishText} />;
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
  partiallyStyled,
  controlledInput,
  controlledTextarea,
  nullishTitleAndId,
  controlledSelect,
  svgChild,
  unsupportedHtmlBinding,
  unsupportedSvgBinding,
  unsupportedSvgStyle,
  component,
];
