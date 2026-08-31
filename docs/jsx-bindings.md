# JSX signal children and host bindings

[English](jsx-bindings.md) | [日本語](jsx-bindings.ja.md)

## Setup

Configure TypeScript to use the supplied automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals"
  }
}
```

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

`value` and `checked` are two-way bound, so they take a different strategy than the rest of the allowlist: the JSX runtime substitutes `defaultValue`/`defaultChecked` for the controlled prop, seeded from `.peek()`, so React only applies it once at mount and never re-applies it on a later re-render — the direct-binding effect owns the DOM property from then on, `onChange` is untouched, and each write is skipped when the DOM already holds that exact value so an unrelated re-render or a same-value echo from `onChange` does not disturb an in-progress edit.

- A *derived* value bound to `value` (for example a signal that trims or upper-cases what the user typed) can still move the caret when the derived string differs from what was typed. That part is not solved here.
- `value`/`checked` on other elements (`<li value>`, `<option value>`, `<meter value>`, ...) are plain write-only attributes, not two-way bound, so they use the same direct-attribute binding as `title`/`disabled`.

## Constraints

- No event handlers, SVG props, or other host props outside the allowlist above are direct-bound.
- Direct-binding writes happen outside the React scheduler and remain an experimental optimization.
- Keep whether a host prop is bound fixed for the element lifetime. Switching between a plain value and a signal changes the wrapper type and remounts the DOM subtree.
- For SSR and hydration, ensure the initial signal values are identical on server and client. Do not place request-specific signals in shared module scope; create them per request.
- A computed signal whose getter throws after binding will skip DOM writes for that cycle and log the error via `console.error` — once per contiguous failure episode, not per write. The error message is `"react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value."` with `{ cause: error }`. Direct bindings bypass React's render cycle, so there is no Error Boundary to catch thrown errors; use [`useSignalValue`](hooks.md#usesignalvalue) if you need Error Boundary semantics for a failing computed.
- Two things about `value`/`checked`/`style` are still open — see [the direct-binding design note](design/direct-binding-value-checked-style.md) for the current state: caret preservation for a *derived* `value`, and fine-grained per-property `style` tracking (`style={{ color: signal }}`).

See also: [rendering optimization](rendering-optimization.md), [JSX control-flow utilities](control-flow.md).
