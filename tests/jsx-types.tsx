/** @jsxImportSource react-fine-grained-signals */

import { computed, signal, useComputed, useSignal, type FormBindableSignal, type Signal } from "../src/index.js";

const text = signal("value");
const enabled = signal(false);
const selectedMany = signal<string[]>(["a"]);
const enabledReadOnly = computed(() => enabled.value);
const boxStyle = signal({ color: "red" });
const color = signal("blue");
const nullishText = signal<string | null | undefined>(null);
const writableText = computed({ get: () => text.value, set: (value) => { text.value = value; } });
const writableChecked = computed({ get: () => enabled.value, set: (value) => { enabled.value = value; } });
const writableSelection = computed({ get: () => text.value, set: (value) => { text.value = value; } });
const writableManySelection = computed({ get: () => selectedMany.value, set: (value) => { selectedMany.value = value; } });
const customWritableSignal: Signal<string> = {
  get value() { return text.value; },
  set value(value: string) { text.value = value; },
  peek: () => text.peek(),
};
const widenedSignal: Signal<string> = signal("annotated");

function GenericTextField<TLabel extends string>({ label, value }: {
  label: TLabel;
  value: FormBindableSignal<string>;
}) {
  return <label>{label}<input bindValue={value} /></label>;
}

function Custom({ value, children }: { value: typeof text; children: typeof text }) {
  return <output>{value === children ? "same" : "different"}</output>;
}

function HookCreatedBinding() {
  const hookSignal = useSignal("");
  return <input bindValue={hookSignal} />;
}

function HookWritableComputedBinding() {
  const hookComputed = useComputed({
    get: () => text.value,
    set: (value: string) => { text.value = value; },
  });
  const capability: FormBindableSignal<string> = hookComputed;
  return <input bindValue={capability} />;
}

function HookReadonlyComputedBinding() {
  const hookComputed = useComputed(() => text.value);
  // @ts-expect-error Getter-only useComputed results remain readonly.
  return <input bindValue={hookComputed} />;
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
// Widening a package signal to Signal<T> erases the direct-binding capability.
// @ts-expect-error Keep FormBindableSignal<T> when a value will be used by bindValue.
const widenedSignalBinding = <input bindValue={widenedSignal} />;
const genericTextField = <GenericTextField label="name" value={text} />;
const boundCheckbox = <input type="checkbox" bindChecked={enabled} />;
const writableComputedInput = <input bindValue={writableText} />;
// @ts-expect-error Structural writable signals remain assignable to Signal<T>, but JSX binding requires an RFSG-created source.
const unsupportedCustomBinding = <input bindValue={customWritableSignal} />;
const writableComputedCheckbox = <input type="checkbox" bindChecked={writableChecked} />;
const boundCheckboxWithFormValue = <input type="checkbox" name="permission" value="admin" bindChecked={enabled} />;
const boundCheckboxWithDefaultFormValue = <input type="checkbox" name="permission" defaultValue="admin" bindChecked={enabled} />;
const boundRadioOption = <input type="radio" name="choice" value="a" bindValue={text} />;
const boundCheckboxGroupOption = <input type="checkbox" name="features" value="a" bindValue={selectedMany} />;
// @ts-expect-error Checkbox form values remain ordinary React props, not signal bindings.
const checkboxImplicitValueBinding = <input type="checkbox" value={text} bindChecked={enabled} />;
const boundTextarea = <textarea bindValue={text} />;
const boundSingleSelect = <select bindValue={text}><option value="value">value</option></select>;
const boundComputedSingleSelect = <select bindValue={writableSelection}><option value="value">value</option></select>;
const boundMultipleSelect = <select multiple bindValue={selectedMany}><option value="a">A</option></select>;
const boundComputedMultipleSelect = <select multiple bindValue={writableManySelection}><option value="a">A</option></select>;
const controlledMultipleSelect = <select multiple value={selectedMany.value}><option value="a">A</option></select>;
// @ts-expect-error Single-select binding values must be strings.
const wrongSingleSelect = <select bindValue={selectedMany} />;
// @ts-expect-error Multiple-select binding values must be arrays of strings.
const wrongMultipleSelect = <select multiple bindValue={text} />;
// @ts-expect-error A dynamic multiple flag cannot prove the binding payload shape.
const dynamicMultipleSelect = <select multiple={enabled.value} bindValue={text} />;
// @ts-expect-error Explicit bindValue owns value/defaultValue.
const conflictingInputBinding = <input bindValue={text} value="value" />;
// @ts-expect-error Explicit bindValue owns value/defaultValue on textarea too.
const conflictingTextareaBinding = <textarea bindValue={text} defaultValue="value" />;
// @ts-expect-error Explicit bindValue owns value/defaultValue on select too.
const conflictingSelectBinding = <select bindValue={text} value="value" />;
// @ts-expect-error Explicit bindChecked owns checked/defaultChecked.
const conflictingCheckedBinding = <input type="checkbox" bindChecked={enabled} checked />;
// @ts-expect-error Explicit bindChecked owns checked/defaultChecked.
const conflictingDefaultCheckedBinding = <input type="checkbox" bindChecked={enabled} defaultChecked />;
// @ts-expect-error Implicit signal-valued `value` bindings are removed.
const implicitValueBinding = <input value={text} />;
// @ts-expect-error Computed/read-only signals cannot be written from an input.
const readOnlyBinding = <input bindValue={enabledReadOnly} />;
// @ts-expect-error Binding types are explicit about their payload.
const wrongCheckedBinding = <input type="checkbox" bindChecked={text} />;
// @ts-expect-error Radio binding requires a scalar string source.
const wrongRadioGroupValue = <input type="radio" name="choice" value="a" bindValue={selectedMany} />;
// @ts-expect-error Checkbox group binding requires an array of strings.
const wrongCheckboxGroupValue = <input type="checkbox" value="a" bindValue={text} />;
// @ts-expect-error Radio bindings require a group name.
const missingRadioGroupName = <input type="radio" value="a" bindValue={text} />;
// @ts-expect-error Group binding owns checked/defaultChecked state.
const conflictingRadioDefaultChecked = <input type="radio" name="choice" value="a" defaultChecked bindValue={text} />;
// @ts-expect-error Group binding cannot be combined with defaultValue.
const conflictingGroupDefaultValue = <input type="checkbox" value="a" defaultValue="a" bindValue={selectedMany} />;
// @ts-expect-error Getter-only computed values remain readonly and cannot be form bindings.
const readonlyComputedInput = <input bindValue={computed(() => text.value)} />;
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

const mode = signal<"a" | "b">("a");
// @ts-expect-error A text input can write any string, so a literal-union signal is rejected.
const literalTextBinding = <input bindValue={mode} />;
// @ts-expect-error A textarea can write any string, so a literal-union signal is rejected.
const literalTextareaBinding = <textarea bindValue={mode} />;
const literalRadioBinding = <input type="radio" name="mode" value="a" bindValue={mode} />;
const literalSelectBinding = <select bindValue={mode}><option value="a">A</option></select>;
const literalMany = signal<Array<"a" | "b">>([]);
const literalCheckboxGroupBinding = <input type="checkbox" name="modes" value="a" bindValue={literalMany} />;
void [
  literalTextBinding,
  literalTextareaBinding,
  literalRadioBinding,
  literalSelectBinding,
  literalCheckboxGroupBinding,
  html,
  styled,
  partiallyStyled,
  controlledInput,
  boundInput,
  widenedSignalBinding,
  genericTextField,
  boundCheckbox,
  writableComputedInput,
  unsupportedCustomBinding,
  writableComputedCheckbox,
  boundCheckboxWithFormValue,
  boundCheckboxWithDefaultFormValue,
  checkboxImplicitValueBinding,
  boundTextarea,
  boundSingleSelect,
  boundComputedSingleSelect,
  boundMultipleSelect,
  boundComputedMultipleSelect,
  controlledMultipleSelect,
  wrongSingleSelect,
  wrongMultipleSelect,
  dynamicMultipleSelect,
  conflictingInputBinding,
  conflictingTextareaBinding,
  conflictingSelectBinding,
  conflictingCheckedBinding,
  conflictingDefaultCheckedBinding,
  implicitValueBinding,
  readOnlyBinding,
  wrongCheckedBinding,
  readonlyComputedInput,
  nullishTitleAndId,
  controlledSelect,
  svgChild,
  unsupportedHtmlBinding,
  unsupportedSvgBinding,
  unsupportedSvgStyle,
  component,
  HookCreatedBinding,
  HookWritableComputedBinding,
  HookReadonlyComputedBinding,
  boundRadioOption,
  boundCheckboxGroupOption,
  wrongRadioGroupValue,
  wrongCheckboxGroupValue,
  missingRadioGroupName,
  conflictingRadioDefaultChecked,
  conflictingGroupDefaultValue,
];
