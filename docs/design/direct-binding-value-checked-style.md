# Direct binding for `value`, `checked`, and `style`

[English](direct-binding-value-checked-style.md) | [日本語](direct-binding-value-checked-style.ja.md)

**Status:** `value`/`checked` and coarse `style` binding are implemented and shipped. Two design questions remain genuinely open below, with no API or implementation decision made.

## Implemented (shipped)

The JSX runtime direct-binds a signal passed to an allowlisted native host prop: seed the DOM from `.peek()` at mount, then write later changes through a ref-installed `effect()` that bypasses React's re-render for that prop (`transformProps` / `ReactiveHost` in `src/runtime/jsx.ts`; see README's "JSX signal children and host bindings" for the full allowlist).

- **`value`/`checked`.** `isControlledTwoWayProp` + `setControlledProp` restrict two-way handling to the tags React itself treats as controlled — `value` on `input`/`textarea`/`select`, `checked` on `input`. The controlled prop is replaced with `defaultValue`/`defaultChecked` seeded from `.peek()`, so React never re-diffs it, and the DOM write is skipped when it already matches. `<select multiple>` goes through `setMultiSelectValue` (toggles each `<option>.selected`, not `String(value)`). Every other `value`/`checked` host (`<li value>`, `<option value>`, `<meter value>`, ...) keeps the ordinary peek-and-substitute path.
- **`style`, coarse whole-object form.** `applyStyle` assigns the resolved object, adds `px` to non-unitless numeric properties, writes `--custom-property` entries via `setProperty`, and clears keys dropped between renders. HTML hosts only.
- Tested in `tests/react.test.tsx`, `tests/ssr.test.tsx`, `tests/jsx-types.tsx`.

**Known gaps in the shipped code** (working, but not covered by a test — or in the first case, a known bug):

- A `<select>` whose matching `<option>` is rendered later from a signal, rather than present as a static child at mount, can get stuck showing no selection: the `value` effect only reruns when the bound signal changes, not when the DOM's `<option>` list changes. Not fixed.
- An IME composition sequence (`compositionstart` → `compositionupdate` → `compositionend`) surviving another subscriber of the same signal writing back mid-composition. jsdom has no native IME simulation, so this needs a real-browser test (`pnpm test:browser`) or a hand-rolled composition-event sequence.
- A `checked` direct binding on a `type="radio"` group backed by independent per-option `computed` signals correctly unchecking siblings. The reasoning holds (each `computed` just needs to derive to `false`), but no explicit test exists.
- React 19 Strict Mode's dev-mode double-invoke of the ref effect not losing focus, caret, or in-progress IME composition. No Strict-Mode-wrapped version of the `value`/`checked` tests exists yet.

## Not implemented — open design work

### Caret preservation for a *derived* `value`

The shipped write-skip guard (`if (input.value !== next) input.value = next`) only helps when the signal echoes back exactly the string the DOM already holds — the ordinary `onChange` round-trip. It does nothing for a *derived* value: a signal that trims, upper-cases, or otherwise transforms what the user typed. When the derived string differs from what was typed, the identity check fails, the write happens, and the caret can jump to the end of the field.

Every reactive UI library that direct-binds `value` runs into this. Right now it is a **documented, accepted limitation** — this project has not committed to fixing it, and no implementation has been attempted.

**Candidate fix, undecided:** before a forced write, capture `selectionStart`/`selectionEnd` and restore them afterward, only while the element is focused.

- Would extend caret preservation to the derived-value case the shipped guard cannot cover.
- `selectionStart`/`selectionEnd` do not exist on every input `type` (`number`, `date`, `color`, and others throw or return `null`) — needs a type-aware guard.
- Restoring a selection mid-IME-composition can itself corrupt the composition — this needs to compose *with* the existing write-skip check, not just run alongside it.
- No prototype exists. This is unscoped beyond the bullet points above.

**Until this ships:** extract the reactive prop into its own leaf component (the pattern `TaskRow` already demonstrates), so only that leaf re-renders.

### Fine-grained per-property `style` tracking

The shipped binding only handles `style={signal}` as a single whole-object write. It does not support `style={{ color: signal }}` — a style object whose individual entries are themselves signals. A consumer who wants only one CSS property to be reactive currently has to route the entire style object through a `computed`.

**Candidate approach, undecided:** detect signals as values inside the `style` object at the JSX-transform boundary (`transformProps` or a sibling helper), and bind each such entry as its own effect, leaving non-signal entries untouched.

- Would get closest to Solid-style ergonomics, and would not need the SVG/MathML exclusion the rest of `setDomProp` carries — `.style` exists uniformly across HTML, SVG, and MathML.
- `isReactiveHostProp` today only inspects top-level prop values; walking one level into an object literal is a different shape of transform, not yet designed.
- Needs its own tests for a style object mixing signal and non-signal entries.
- Needs a decision for what happens when the whole `style` prop is swapped for a differently-shaped object across renders — the existing "keep whether a host prop is bound fixed for the element lifetime" constraint has no defined equivalent yet for entries added to or removed from a style object between renders.
- No prototype exists. This is unscoped beyond the bullet points above.

**Until this ships:** route the whole style object through a `computed`, or fall back to the leaf-component pattern for single-property reactivity.

## Non-goals

- Reproducing every React controlled-input behavior (for example `defaultValue` fallback semantics) for a direct-bound element.
- Changing the leaf-component pattern (`TaskRow` demonstrates it) as the fallback answer for anything the above does not cover.
