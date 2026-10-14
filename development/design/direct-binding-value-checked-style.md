# Direct binding for form values and `style`

[English](./direct-binding-value-checked-style.md) | [日本語](./direct-binding-value-checked-style.ja.md)

**Status:** Explicit `bindValue`/`bindChecked` bindings for text-like inputs, textareas, and checkboxes are implemented. React's ordinary `value`/`checked` semantics remain unchanged. Whole-object and per-property signal `style` binding are implemented.

## Implemented contract

The JSX runtime recognizes explicit writable-signal props `bindValue` and `bindChecked`. `bindValue` supports text-like inputs and textareas; `bindChecked` supports checkbox inputs. They initialize from the signal at mount and subscribe after the host ref attaches. Native `input` and `change` events write user edits back to the signal. Binding props are removed before reaching the DOM. Passing a signal to React's ordinary `value` or `checked` prop is rejected with migration guidance; pass `signal.value` to retain React-controlled behavior. See [JSX signal children and host bindings](../../docs/guides/jsx-bindings.md) for API details and edge cases.

Text bindings skip equal-value writes, preserve focused selection where the browser exposes a selection API, defer external writes during IME composition, and apply the latest value at `compositionend`. Form reset returns to the latest bound signal value. SSR emits the initial value as a default, and hydration expects matching server/client initial values; edits before hydration may be overwritten.

- **`style`, coarse whole-object form.** `applyStyle` assigns the resolved object, adds `px` to non-unitless numeric properties, writes `--custom-property` entries via `setProperty`, and clears keys dropped between renders. HTML hosts only.
- The form contract is covered by `tests/react-dom-binding.test.tsx`, `tests/ssr.test.tsx`, and `tests/jsx-types.tsx`.

### Fine-grained per-property `style` tracking

Implemented for HTML hosts. When a style object contains signal-valued entries, the JSX runtime takes a render snapshot for React and installs one direct subscription per signal entry when the host ref commits. Plain entries are retained as plain values. Subscriptions are not created during render, so an abandoned concurrent render cannot leave source dependencies behind. This keeps DOM updates outside the owning component's render path and reuses the existing style key cleanup, detach/reattach, exception, and SSR behavior.

Replacing the style object on a later render creates a new computed source. `NodeBinder` replaces the style binding and carries the old key set forward, so removed CSS properties are cleared. Adding/removing entries by mutating the same plain object without causing a React render is not observed; style object shape follows the host's render lifecycle. SVG/MathML property-level bindings remain unsupported, matching the whole-object direct binding boundary.

Qualification lives in `tests/react-dom-binding.test.tsx` and `tests/jsx-types.tsx`: mixed signal/plain entries, unit conversion through `applyStyle`, and no owner rerender on a signal entry write.

## Non-goals

- Reproducing every React controlled-input behavior for direct-bound elements.
- Changing the leaf-component pattern (`TaskRow` demonstrates it) as the fallback answer for anything the above does not cover.
