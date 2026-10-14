/** @jsxImportSource react-fine-grained-signals */

import { computed, signal } from "../src/index.js";

const text = signal("value");
const enabled = signal(false);
const enabledReadOnly = computed(() => enabled.value);
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

// React's value/checked props keep their standard value semantics; RFSG's
// explicit bindings require writable signals and the package JSX runtime.
const controlledInput = <input value={text.value} checked={enabled.value} onChange={() => {}} />;
const boundInput = <input bindValue={text} />;
const boundCheckbox = <input type="checkbox" bindChecked={enabled} />;
const boundTextarea = <textarea bindValue={text} />;
// @ts-expect-error Implicit signal-valued `value` bindings are removed.
const implicitValueBinding = <input value={text} />;
// @ts-expect-error Computed/read-only signals cannot be written from an input.
const readOnlyBinding = <input bindValue={enabledReadOnly} />;
// @ts-expect-error Binding types are explicit about their payload.
const wrongCheckedBinding = <input type="checkbox" bindChecked={text} />;
// `title` and `id` remove their attributes when a direct binding becomes nullish.
const nullishTitleAndId = <div title={nullishText} id={nullishText} />;
const controlledSelect = (
  <select value={text.value} onChange={() => {}}>
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
  boundInput,
  boundCheckbox,
  boundTextarea,
  implicitValueBinding,
  readOnlyBinding,
  wrongCheckedBinding,
  nullishTitleAndId,
  controlledSelect,
  svgChild,
  unsupportedHtmlBinding,
  unsupportedSvgBinding,
  unsupportedSvgStyle,
  component,
];
