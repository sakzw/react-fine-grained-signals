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

This covers ordinary child positions, where React renders children as DOM nodes. It does not cover host elements whose children React handles in an element-specific way, including `<title>`, `<textarea>`, and `<style>`. A signal child there becomes a React element where React expects text, so React warns, the element ends up empty, or `[object Object]` is rendered, including during SSR. For those elements, read the value in a tracked component (`<title>{title.value}</title>`) or use `bindValue` for a text field. `<option>{signal}</option>` works like an ordinary child.

## Bound host props

The same runtime supports direct bindings only for these native HTML props:

- `title`, `id`, `className`, `hidden`, and `disabled`
- `style`, bound as a whole object (`style={signal}`) or with signal-valued entries such as `style={{ color: colorSignal, width: 12 }}`
- `bindValue` on text-like `input` elements, `textarea`, and single or multiple `select` elements; `bindChecked` on checkbox inputs
- `value` and `checked` retain React's standard semantics when used without an explicit binding
- `data-*` and `aria-*` attributes

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
const enabled = signal(false);

<input bindValue={name} />
<textarea bindValue={name} />
<input type="checkbox" bindChecked={enabled} />
<select bindValue={selected}>
  <option value="a">A</option>
  <option value="b">B</option>
</select>
<select multiple bindValue={selectedMany}>
  <option value="a">A</option>
  <option value="b">B</option>
</select>
```

`bindValue` supports text-like input types (`text`, `search`, `tel`, `url`, `password`, `email`), `textarea`, single selects with `Signal<string>`, and `multiple` selects with `Signal<string[]>`. The `multiple` attribute must be a literal `true` for the array form; dynamic booleans are checked at runtime against the current signal value. Multiple-select changes are read from `selectedOptions` in option document order. Options inserted or removed later are observed and the current signal selection is reapplied. `bindChecked` supports checkbox inputs only. Radio groups are not supported by `bindChecked`; use React-controlled props.

An explicit binding owns that DOM state: do not combine `bindValue` with `value` or `defaultValue`, or `bindChecked` with `checked` or `defaultChecked`. The runtime rejects those combinations, and the RFSG JSX types reject statically visible conflicts. Standard React-controlled selects remain available with `value={selected.value}` and an `onChange` handler. With `bindValue`, the native change listener updates the signal before React's `onChange` runs, so no signal assignment is needed in that handler unless it normalizes the value.

The binding subscribes after the host ref attaches, initializes from the signal, and writes signal changes to the DOM without rerendering the owner. Native `input` events write text into the signal, and native `change` events write checkbox state or select values (an array for `multiple`). `onChange` and `onInput` props are forwarded unchanged and still run through React. The direct listener runs before React's bubbled handler, so an `onChange` handler may normalize the entered value by writing the signal again. An `onChange` handler that ignores an edit does not reject it: the native binding has already copied the DOM value to the signal.

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
- A `computed({ get, set })` is writable and can be bound when its value type matches the field. The native input/select change calls its setter; updates to dependencies are still reflected through its getter. The getter-only `computed(() => ...)` and `useComputed()` remain read-only.

See also: [rendering optimization](./rendering-optimization.md), [JSX control-flow utilities](./control-flow.md).
