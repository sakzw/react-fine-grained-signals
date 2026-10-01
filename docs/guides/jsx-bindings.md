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

## Bound host props

The same runtime supports direct bindings only for these native HTML props:

- `title`, `id`, `className`, `hidden`, and `disabled`
- `style`, bound as a whole object (`style={signal}`); a style object with per-property signals inside it, e.g. `style={{ color: signal }}`, is not supported
- `value` on `input`, `textarea`, and `select`, and `checked` on `input`
- `data-*` and `aria-*` attributes

```tsx
const title = signal("Initial title");
const disabled = signal(false);
const boxStyle = signal({ color: "crimson" });
const newTitle = signal("");

export function Field() {
  return (
    <>
      <button title={title} disabled={disabled} style={boxStyle}>
        {title}
      </button>
      <input value={newTitle} onChange={(e) => { newTitle.value = e.target.value; }} />
    </>
  );
}
```

## style

A number bound to a CSS property is written with a `px` suffix unless the property is one of the small set (`opacity`, `zIndex`, `flexGrow`, and similar) that React also treats as unitless. A key starting with `--` is written as a CSS custom property via `setProperty`. A key present in a previous style object but absent from the next one is cleared, not left stale.

## value and checked

`value` and `checked` are two-way bound, so they take a different strategy than the rest of the allowlist: the JSX runtime substitutes `defaultValue`/`defaultChecked` for the controlled prop, seeded from `.peek()`, so React only applies it once at mount and never re-applies it on a later re-render — the direct-binding subscription owns the DOM property from then on, `onChange` is untouched, and each write is skipped when the DOM already holds that exact value so an unrelated re-render or a same-value echo from `onChange` does not disturb an in-progress edit.

- A *derived* value bound to `value` (for example a signal that trims or upper-cases what the user typed) can still move the caret when the derived string differs from what was typed. That part is not solved here.
- `value`/`checked` on other elements (`<li value>`, `<option value>`, `<meter value>`, ...) are plain write-only attributes, not two-way bound, so they use the same direct-attribute binding as `title`/`disabled`.
- A form reset restores the element's default (`defaultValue`, `defaultChecked`, an option's `defaultSelected`). Every signal write the binding applies sets that default to the written value too, so after a write — in a `<form action>`, in an `onReset` handler, or anywhere else — `form.reset()`, a reset button, and React 19's automatic reset after a `<form action>` restore the signal's value. That does not hold after the user edits the field: React's own handling of the change event sets the default back to the value the owner last rendered, even when `onChange` writes the signal, so a reset then restores that rendered value and the field and the signal disagree. To decide what a reset shows, write the signal when it resets, for example in the action or in `onReset`.

## Constraints

- No event handlers, SVG props, or other host props outside the allowlist above are direct-bound.
- Direct-binding writes happen outside the React scheduler and remain an experimental optimization.
- A host prop can switch between a plain value and a signal across renders. The element keeps its type and its children keep their state; only the binding is attached or detached. (Switching `value`/`checked` between a signal and a plain value still switches the input between React's uncontrolled and controlled modes, with React's usual warning.)
- Bindings are attached through a ref on the host element itself. A ref you pass is still called with the element exactly as React would call it. As long as it is stable, a re-render does not re-invoke it unless the bindings changed: a binding switched to another signal or to a plain value, or a bound prop or `style` now renders a different value than the previous render did (after a write between the two renders). Then the ref is detached and attached again within the same commit.
- A `deepSignal` is not accepted as a signal child or a bound prop. Those positions follow root replacement only, so nested mutations would never show; TypeScript rejects them. Read deep state inside a tracked component, or select a primitive with [`useDeepSignalValue`](./hooks.md#usedeepsignalvalue).
- For SSR and hydration, ensure the initial signal values are identical on server and client. Do not place request-specific signals in shared module scope; create them per request.
- A computed signal whose getter throws after binding will skip DOM writes for that cycle and log the error via `console.error` — once per contiguous failure episode, not per write. The error message is `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` with `{ cause: error }`. Direct bindings bypass React's render cycle, so there is no Error Boundary to catch thrown errors; use [`useSignalValue`](./hooks.md#usesignalvalue) if you need Error Boundary semantics for a failing computed.
- Two things about `value`/`checked`/`style` are still open — see [the direct-binding design note](../../development/design/direct-binding-value-checked-style.md) for the current state: caret preservation for a *derived* `value`, and fine-grained per-property `style` tracking (`style={{ color: signal }}`).

See also: [rendering optimization](./rendering-optimization.md), [JSX control-flow utilities](./control-flow.md).
