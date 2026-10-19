# JSX signal children and host bindings

[English](./jsx-bindings.md) | [日本語](./jsx-bindings.ja.md)

## Setup

The runtime is opt-in, and opting in is a matter of pointing the automatic JSX transform at it. That can be done per file or per project.

Per file, with a pragma on the first line. Every other file keeps React's JSX runtime, which makes this the right form when only part of an app needs the direct bindings:

```tsx
/** @jsxImportSource react-fine-grained-signals */
```

Project-wide, in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals"
  }
}
```

For apps that need **Signal children only**, the package also provides an explicit Lite runtime. It keeps normal React JSX behavior and makes Signal children reactive, while omitting direct host-attribute and form bindings:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals/lite"
  }
}
```

Use the default `react-fine-grained-signals` source when you need `bindValue`, `bindChecked`, or Signal-valued host props. Lite rejects those props in TypeScript and reports them at runtime when passed through JavaScript or a spread. The choice is explicit per project or file; the default runtime and its behavior are unchanged.

Lite reduces transfer size only when the Full runtime is absent from the same eagerly loaded chunks. In M18.17's small production Consumer, Lite was 6,029 gzip bytes smaller than Full and 477 bytes larger than React JSX plus `useSignalValue`. In a larger M18.18 Vite Consumer, synchronously importing both runtimes added 543 gzip bytes over Full alone; a lazy Full import kept its implementation in a 7,055-byte gzip chunk loaded after the user action. These are fixture-specific measurements, not fixed package-size guarantees.

Vite reads both of those from `tsconfig.json` — with its default transform and with `@vitejs/plugin-react` alike — so `vite.config.ts` needs no JSX configuration of its own, which is what [`tests/fixtures/consumer-vite`](../../tests/fixtures/consumer-vite) relies on.

Babel never reads `tsconfig.json`. A build that hands JSX to Babel — `babel-loader` under webpack being the usual case — names the runtime on the preset instead:

```js
// babel.config.js
export default {
  presets: [
    [
      "@babel/preset-react",
      { runtime: "automatic", importSource: "react-fine-grained-signals" },
    ],
  ],
};
```

Either way both entry points are used: `jsx-runtime` in production builds and `jsx-dev-runtime` in development, and this package ships both. For the one shape the automatic runtime cannot express — a `key` written after a prop spread, `<div {...props} key="k" />` — TypeScript, Babel, and Oxc fall back to importing `createElement` from the package root, which this package also exports with the same signal bindings.

The two forms select the same runtime; the pragma only narrows where it applies. [`examples/react-router`](../../examples/react-router) sets `jsx` but not `jsxImportSource` in its `tsconfig.json`, and opts two of its components in by pragma.

This is the most fine-grained render optimization the runtime offers, but it covers only native elements' signal children and the props listed below. Signals passed to React component props or component children are not unwrapped.

## Signal children

A signal used as a native host child, including SVG text content, becomes a local reactive leaf, so it can update without rerendering its parent.

```tsx
const title = signal("Initial title");

export function Heading() {
  return <h1>{title}</h1>;
}
```

This covers ordinary child positions, where React renders children as DOM nodes. It does not cover host elements whose children React handles in an element-specific way, including `<title>`, `<textarea>`, and `<style>`. A signal child there becomes a React element where React expects text, so React warns, the element ends up empty, or `[object Object]` is rendered, including during SSR. For those elements, read the value in a tracked component (`<title>{title.value}</title>`) or use `bindValue` for a text field. For `<option>`, give the option an explicit `value` prop (`<option value={id}>{label}</option>`): without one, React logs "Cannot infer the option value of complex children" for a signal child, and server rendering does not mark that option selected. A signal as the option's *text* alone is not a supported way to supply its value.

## Bound host props

The same runtime supports direct bindings only for these native HTML props:

- `title`, `id`, `className`, `hidden`, and `disabled`
- `style`, bound as a whole object (`style={signal}`) or with signal-valued entries such as `style={{ color: colorSignal, width: 12 }}`
- `bindValue` on text-like `input` elements, `textarea`, and single or multiple `select` elements; `bindChecked` on checkbox inputs
- `value` and `checked` retain React's standard semantics when used without an explicit binding
- `data-*` and `aria-*` attributes

`bindValue` radios with the same native form owner and `name` must share one writable signal. The browser unchecks a radio sibling without dispatching an input event to that sibling; binding those peers to separate signals would leave one signal stale. RFSG rejects that configuration when both bindings belong to the same runtime copy. Radios with different form owners or different names remain independent, and a shared signal can span React roots when the radios still belong to the same native group.

```tsx
const title = signal("Initial title");
const disabled = signal(false);
const boxStyle = signal({ color: "crimson" });
const newTitle = signal("");
const enabled = signal(false);
const selected = signal("a");
const selectedMany = signal<string[]>(["a"]);

export function Field() {
  return (
    <>
      <button title={title} disabled={disabled} style={boxStyle}>
        {title}
      </button>
      <input bindValue={newTitle} />
      <input type="checkbox" bindChecked={enabled} />
    </>
  );
}
```

For a bound `title` or `id`, writing `null` or `undefined` removes the attribute, matching React DOM.

## style

A number bound to a CSS property is written with a `px` suffix unless the property is one of the small set (`opacity`, `zIndex`, `flexGrow`, and similar) that React also treats as unitless. A key starting with `--` is written as a CSS custom property via `setProperty`. A key present in a previous style object but absent from the next one is cleared, not left stale. That includes keys React wrote from the value the element rendered with, when the signal drops them before the binding attaches, for example while an `<Activity>` or Suspense boundary hides the element.

Individual style values may also be signals. The JSX runtime subscribes to those entries when the host ref commits, so a change updates the affected CSS property without re-rendering the owning component. Plain entries in the same object remain fixed until the component renders again. Replacing the style object across renders re-diffs the binding and clears properties removed from the new shape. This applies to HTML hosts, like the whole-object style binding.

## Form bindings

`value` and `checked` retain React's standard semantics. Use plain values and update state in `onChange` for React-controlled inputs. RFSG's `bindValue` and `bindChecked` props are separate direct bindings and require writable signals:

```tsx
const name = signal("");
const amount = signal("12.5");
const enabled = signal(false);

<input bindValue={name} />
<input type="number" step="any" bindValue={amount} />
<textarea bindValue={name} />
<input type="checkbox" bindChecked={enabled} />
<select bindValue={selected}>
  <option value="a">A</option>
  <option value="b">B</option>
</select>
<input type="radio" name="plan" value="basic" bindValue={plan} />
<input type="radio" name="plan" value="pro" bindValue={plan} />
<input type="checkbox" name="features" value="search" bindValue={features} />
<input type="checkbox" name="features" value="export" bindValue={features} />
<select multiple bindValue={selectedMany}>
  <option value="a">A</option>
  <option value="b">B</option>
</select>
```

`bindValue` supports text-like input types (`text`, `search`, `tel`, `url`, `password`, `email`) and `type="number"`, each with `FormBindableSignal<string>`, plus `textarea`, single selects with `FormBindableSignal<string>`, and `multiple` selects with `FormBindableSignal<string[]>`. Radio inputs with the same form owner and `name` can share a `FormBindableSignal<string>`; each option needs a string `value`. Every bound radio in that native group must use the same signal. The runtime rejects different sources when it can see both bindings in the same RFSG runtime copy. Do not mix `bindValue` radios with React `checked`/`defaultChecked` radios or with bindings from another RFSG runtime copy in the same native group; those peers cannot be diagnosed across ownership boundaries. Checkbox inputs with the same form owner and `name` can share a `FormBindableSignal<string[]>`; each checkbox needs a string `value`. `bindChecked` remains available for one independent checkbox and requires `FormBindableSignal<boolean>`. The `multiple` attribute must be a literal `true` for the select array form; the types reject a dynamic boolean, so a dynamic `multiple` needs a cast, after which the runtime checks it against the current signal value. Multiple-select changes are read from `selectedOptions` in option document order. Options inserted or removed later, and a kept option whose `value` attribute or text changes, are observed and the current signal selection is reapplied.

For `type="number"`, `bindValue` stores the DOM `.value` as a string. An empty field is `""`; RFSG does not convert through `valueAsNumber`, clamp to `min`/`max`, or round to `step`. The browser owns number-input sanitization and constraint validation: for example, `rangeUnderflow`, `rangeOverflow`, `stepMismatch`, `valueMissing`, and sometimes `badInput` are exposed through `input.validity`. Invalid or incomplete keystrokes may be sanitized by the browser to an empty `.value`; the binding does not promise to preserve text the browser does not expose as `.value`.

`type="range"` also uses `FormBindableSignal<string>` and the DOM `.value` string. RFSG does not parse `valueAsNumber` or add min/max/step correction; the browser applies its native range-control behavior when users interact with the control or when its value is assigned. Keep numeric parsing explicit when your application needs a number.

```tsx
const amount = signal("");
const parsedAmount = computed(() => amount.value === "" ? null : Number(amount.value));

<input type="number" min="0" max="100" step="0.25" bindValue={amount} />
```

Guard the empty string before parsing because `Number("")` is `0`. If a user must preserve arbitrary partial text such as `-` or `1.`, use a text input and validate/parse it separately. Numeric-looking identifiers such as postal codes should also use a text input so leading zeroes and formatting are retained. A programmatic call to `stepUp()`/`stepDown()` changes the native control value but does not itself notify the signal; dispatch/use the corresponding input event when an application changes a bound control programmatically.

Checkbox-group arrays retain their existing order and duplicates when another option is selected; a newly selected value is appended once. Unchecking a value removes all of its occurrences.

The binding types require the package capability `FormBindableSignal<T>`. `signal()`, `useSignal()`, and writable `computed({ get, set })` return this type. Keep it in reusable form props instead of widening the value to `Signal<T>`:

```tsx
import type { FormBindableSignal } from "react-fine-grained-signals";

type TextFieldProps<TMeta> = {
  value: FormBindableSignal<string>;
  label: string;
  metadata?: TMeta;
};

function TextField<TMeta>({ value, label }: TextFieldProps<TMeta>) {
  return <label>{label}<input bindValue={value} /></label>;
}
```

The capability is a TypeScript-only opaque marker; it is not a JavaScript property. Runtime binding validates the package's private signal brand and writable value descriptor. A value annotated as plain `Signal<T>` no longer carries enough type information for JSX binding. Getter-only computed values remain rejected.

An explicit binding owns that DOM state: do not combine `bindValue` with `value` or `defaultValue` (radio and checkbox-group options still take their string `value`), or `bindChecked` with `checked` or `defaultChecked`. A prop explicitly set to `undefined` counts as absent, so `bindValue={enabled ? field : undefined}` renders an unbound field. The runtime rejects those combinations, and the RFSG JSX types reject statically visible conflicts. Standard React-controlled selects remain available with `value={selected.value}` and an `onChange` handler. With `bindValue`, the native change listener updates the signal before React's `onChange` runs, so no signal assignment is needed in that handler unless it normalizes the value.

The binding subscribes after the host ref attaches, initializes from the signal, and writes signal changes to the DOM without rerendering the owner. Native `input` events write text into the signal; `change` events write select values (an array for a multiple select). `bindChecked` and radio and checkbox groups update from the target's native `click` before React's delegated click handler, so that handler and the `onChange` React synthesizes from the click observe the current signal. A click canceled with `preventDefault()` restores the previous signal value after the event, unless a handler wrote another value meanwhile. Group correction is deferred until the event has bubbled, preserving React's synthetic `onChange`. `onChange` and `onInput` props are forwarded unchanged. For text inputs, the target-level native input listener calls the binding setter synchronously and defers any corrective DOM write until the event has bubbled, so React handlers observe the entered text. An `onChange` handler can perform additional work or write a normalized value. Ignoring an edit in `onChange` does not reject it because the native binding already called the setter.

For writable computed bindings, the getter is the source of truth. After the input event has fully propagated, the binding reads the getter in the next task and corrects the DOM only if it still contains that event's attempted value and differs from the getter. Deferring to a task also accounts for browsers that run microtasks between native listeners, before React's delegated handler. This handles rejected input and normalization, while avoiding stale writes if a newer edit or React handler has already changed the DOM. During IME composition, correction waits until composition ends.

For text controls and selects, equal-value writes are skipped. When an external text write changes a focused field, the binding restores its selection range, clamped to the new string length; input types without a selection API use the browser's normal caret behavior. During IME composition, external text writes are deferred until `compositionend`, so composition is not interrupted; the latest pending signal value is applied then. Form reset restores the latest signal value for both single and multiple selects. A canceled reset leaves the DOM and signal untouched. Select option changes update both current selection and reset defaults, so a later-added matching option is selected and retained through reset.

On the server, the initial signal value is rendered as the corresponding default value. Server and client initial values must match. Hydration attaches the binding to the existing host node; an edit made before hydration may be replaced by the initial signal value.

These props are recognized only by the RFSG JSX runtime (`jsxImportSource: "react-fine-grained-signals"`) and are removed before props reach the DOM. A signal passed as `value` or `checked` is rejected with a migration error: use `bindValue`/`bindChecked` for direct binding, or pass `signal.value` to keep React-controlled semantics.


## Constraints

- No event handlers, SVG props, or other host props outside the allowlist above are direct-bound.
- Direct-binding writes happen outside the React scheduler and remain an experimental optimization.
- Binding props can switch between writable signals across renders. The element keeps its type and children keep their state; only the binding is attached or detached. Keep `value`/`checked` for ordinary React-controlled behavior.
- Bindings are attached through a ref on the host element itself. A ref you pass is still called with the element exactly as React would call it. As long as it is stable, a re-render does not re-invoke it unless the bindings changed: a binding switched to another signal or to a plain value, or a bound prop or `style` now renders a different value than the previous render did (after a write between the two renders). Then the ref is detached and attached again within the same commit.
- A `deepSignal` is not accepted as a signal child or a bound prop. Those positions follow root replacement only, so nested mutations would never show; TypeScript rejects them. Read deep state inside a tracked component, or select a primitive with [`useDeepSignalValue`](./hooks.md#usedeepsignalvalue).
- For SSR and hydration, ensure the initial signal values are identical on server and client. Do not place request-specific signals in shared module scope; create them per request.
- Writable signals are required; read-only computed signals cannot be used with `bindValue` or `bindChecked`.
- If a bound computed signal's getter throws, the DOM write for that cycle is skipped and the error is logged with `console.error`, once per consecutive failure episode rather than once per write. The message is `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` with `{ cause: error }`. Direct bindings bypass React's render cycle, so no Error Boundary catches the error; use [`useSignalValue`](./hooks.md#usesignalvalue) when a failing computed needs Error Boundary semantics.
- A `computed({ get, set })` or writable `useComputed({ get, set })` can be bound when its value type matches the field. User input calls its setter; updates to dependencies are reflected through its getter. If the setter rejects or normalizes a value, the getter remains authoritative and the DOM is corrected after React's event handlers run. Getter-only computed values remain read-only.

See also: [rendering optimization](./rendering-optimization.md), [JSX control-flow utilities](./control-flow.md).
