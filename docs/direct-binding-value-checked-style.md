# Direct binding for `value`, `checked`, and `style`

[English](direct-binding-value-checked-style.md) | [日本語](direct-binding-value-checked-style.ja.md)

Status: design investigation; no API or implementation decision has been made.

## Context

The JSX runtime currently direct-binds a signal passed to `title`, `id`, `className`, `hidden`, `disabled`, `data-*`, or `aria-*` on a native host element: `transformProps` pulls the signal out of the JSX props, seeds the initial DOM state from `.peek()`, and wraps the element in `ReactiveHost`, whose ref installs an `effect()` per bound prop that writes the DOM directly through `setDomProp`. React never re-renders the owning component when the signal changes; only the ref's effect runs.

`value`, `checked`, and `style` are explicitly excluded from that allowlist today. `value` is the concrete motivation for this investigation: before the `NewTaskForm` extraction, `examples/react-router/app/routes/home.tsx` read `newTitle.value` directly for a controlled `<input>`'s `value` prop, with no direct-binding escape hatch, so every keystroke re-rendered the whole owning component. `checked` has the same shape of read one file over, in `TaskRow`'s `checked={task.done}`. `style` is not used anywhere in this codebase today; it is in scope here because it shares the "excluded from the allowlist" line in README.md, not because of a concrete instance. The only currently supported answer for the `value` and `checked` cases is the pattern already used by `TaskRow` and `NewTaskForm`: extract the reactive prop into its own leaf component that owns a `useSignals()` scope, so only that leaf re-renders.

This document scopes what direct-binding support for `value`, `checked`, and `style` would require, so that "extract a leaf component" can be compared against "extend the allowlist" on equal footing.

## Why these three are harder than the current allowlist

Every prop the runtime already direct-binds is write-only from React's perspective: React does not compare against `title`, `id`, `className`, `hidden`, or `disabled` to decide whether the DOM already reflects the latest render, and the DOM never fires an event that must be reconciled against them on every keystroke. Writing them through an out-of-band `effect()` is safe because nothing else is racing to write the same DOM property.

`value` and `checked` break that assumption in two ways:

- They are two-way bound. `onChange` (already left untouched on `hostProps`, since it is not a signal) reads the DOM back into the signal, and the direct-binding effect writes the signal back into the DOM. Writing `node.value`/`node.checked` unconditionally on every effect run, even when the DOM already holds that exact value, is the sharp edge every fine-grained reactive UI library documents around controlled inputs: depending on the browser and input `type`, it can disturb `selectionStart`/`selectionEnd`, reformat the string (for `<input type="number">` and similar), and — the one failure mode that does not depend on whether the string ends up unchanged — abort an in-progress IME composition.
- `transformProps` does not remove a direct-bound prop from the element; it substitutes `.peek()` for it (`props[name] = readInitialValue(value)`), the same way it already does for `title`/`disabled`/etc. Applied to `value`/`checked` unchanged, this keeps the input React-controlled, with `value` frozen at whatever `.peek()` returned the last time the owning component actually re-rendered, while the ref's effect writes newer values straight to the DOM in between renders. Any later re-render of the owner for an unrelated reason hands React that same stale prop again, and React's controlled-input reconciliation — which tracks whether the DOM's live value diverged from what React last set, specifically so it can force the DOM back in sync — will overwrite whatever the direct-binding effect wrote. Supporting `value`/`checked` safely is therefore not just "add an effect that writes the DOM"; it needs a decision on how the element stops being reasserted as controlled by React at all (for example, genuinely omitting the prop and substituting `defaultValue`/`defaultChecked` for the initial paint), which is a different prop-handling strategy than the peek-and-substitute one `transformProps` uses for the rest of the allowlist today.

`style` is not two-way bound, so it does not have the caret problem, but it breaks the current model in a different way: every prop the runtime binds today is a scalar DOM property or a single `setAttribute` call. `style` is either a single object (which the current per-prop-name model can bind coarsely, the same way `className` is bound) or, more usefully, an object whose individual entries are themselves signals (`style={{ color: theme }}`), which needs sub-property tracking the current `isReactiveHostProp` check has no concept of. `style` also differs from `className`, `hidden`, and `disabled` in namespace behavior: SVG elements expose a standard `CSSStyleDeclaration` through `.style`, unlike `className` (`SVGAnimatedString`), so `style` may not need the SVG/MathML exclusion the rest of `setDomProp` carries.

## Prior art

Solid's compiled JSX distinguishes `prop:` (direct property assignment) from attribute binding, which is the same direct-write shape this project already uses for `title`/`disabled`/etc. Vue's `v-model` and Preact's signal bindings for controlled inputs both guard the write path by comparing the DOM's current value against the value about to be written, and skip the DOM write when they already match. That guard, arrived at independently in two different ecosystems, is the direct precedent for Option 1 below.

## Goals for a future decision

- Preserve caret/selection position and IME composition state when a signal round-trips back through the same `value` it just received from `onChange`.
- Give `checked` a binding at least as simple as the existing `disabled` binding for the common checkbox case, since it has no caret problem to solve.
- Support at least the coarse `style={signalOfStyleObject}` form with the same per-prop model used today; treat per-property signals inside a style object (`style={{ color: signal }}`) as a distinct, separately scoped extension rather than a requirement of the same change.
- Keep the SSR/hydration contract identical to the existing allowlist: the initial render uses `.peek()`, and the direct write takes over after the ref mounts.
- Make it impossible for a `value`/`checked` element to have two writers fighting. As described in the section above, today's peek-and-substitute prop handling (used for the rest of the allowlist) would leave the element React-controlled with a value frozen at the owner's last actual render while the direct-binding effect writes past it, so this goal likely needs a different prop-handling strategy for these two props specifically, not just discipline about not binding both at once.

## Non-goals

- Solving caret preservation for a *derived* value bound to `value` (for example a signal that trims or upper-cases what the user typed). Every reactive UI library that direct-binds `value` faces this; this document treats it as a documented limitation to describe precisely, not a bug to eliminate.
- Reproducing every React controlled-input behavior (for example `defaultValue` fallback semantics) for a direct-bound element.
- Deciding the final shape of nested `style` object signal tracking (`style={{ color: signal }}`) in this pass; see the `style` options below for why it is scoped separately.
- Changing the recommended leaf-component pattern (`TaskRow`, `NewTaskForm`) as the answer for anything not covered by whatever ships from this investigation.

## Options to evaluate

### 1. `value`/`checked`: skip the DOM write when it already matches

Before writing, compare the DOM node's current live value (`node.value` / `node.checked`) against the signal's value, and only call the setter when they differ, mirroring the Preact/Vue guard described in Prior art.

Advantages: solves the common case — a keystroke updates the signal, the effect re-fires with the exact string the DOM already holds, and the write is skipped, so the caret never moves. No new public API. Disadvantages: does not help a *derived* value bound to `value` (the Non-goals case above); needs an explicit test for IME composition, where the DOM's transient composed text and the signal's committed value can legitimately differ mid-composition without that being a signal worth writing back; and, on its own, does not address the separate problem raised in "Why these three are harder" — an unrelated re-render of the owner still hands React the stale peeked prop, and React's own controlled-input reconciliation, not this effect, is what forces the DOM back to it. That needs a change to how `transformProps` handles the prop itself (see Goals), independent of this write-skip guard.

### 2. `value`: preserve selection across a forced write

When option 1 cannot avoid a write (the derived-value case), capture `selectionStart`/`selectionEnd` before the write and restore them after, only while the element is focused.

Advantages: extends caret preservation to the derived-value case that option 1 leaves unsolved. Disadvantages: `selectionStart`/`selectionEnd` do not exist on every input `type` (`number`, `date`, `color`, and others throw or return `null`), so the implementation needs a type-aware guard; restoring a selection mid-IME-composition can itself corrupt the composition, so this needs to compose with (not just sit next to) option 1's identity check.

### 3. `checked`: bind directly with the same model as `disabled`

Add `checked` to the existing per-prop-name allowlist with no caret-style guard, since checkboxes and radios have no selection state to lose.

Advantages: mechanically identical to the existing `disabled` binding; the interesting failure mode (a radio group backed by independent per-option `computed` signals, where selecting one option must uncheck the others) already resolves correctly as long as each `computed` correctly derives to `false`, which is a modeling concern for the app, not new runtime work. Disadvantages: still two-way bound like `value` — needs the same guarantee that a `checked` prop is never left both React-controlled and direct-bound on the same element, and needs its own test rather than inheriting `value`'s.

### 4. `style`, coarse form: bind the whole object like `className`

Treat `style={signal}` as one binding whose effect assigns the resolved object to the node (`Object.assign(node.style, value)` or an equivalent), reusing the existing per-prop-name model unchanged.

Advantages: no new tracking model, no caret problem, ships independently of the `value`/`checked` decisions above. Needs its own coercion pass (numeric values need a unit for non-unitless CSS properties, `--custom-property` entries need `setProperty` rather than direct assignment, and stale properties from a previous object need to be cleared, not just overwritten) but that is self-contained. Disadvantages: does not give the more ergonomic `style={{ color: signal }}` per-property form; a consumer who wants only one CSS property to be reactive still has to route the whole style object through a `computed`.

### 5. `style`, fine-grained form: track signals nested inside the style object

Detect signals as values inside the `style` object at the JSX-transform boundary (`transformProps` or a sibling helper) and bind each such entry as its own effect, leaving plain (non-signal) entries as ordinary object properties untouched by any effect.

Advantages: closest to the ergonomics Solid-style APIs offer, and — per the Context section — does not need the SVG/MathML exclusion the rest of `setDomProp` carries, since `.style` exists uniformly across HTML, SVG, and MathML elements. Disadvantages: `isReactiveHostProp` today only inspects top-level prop values; walking one level into an object literal is a different shape of transform, needs its own tests for a style object that mixes signal and non-signal entries, and needs a decision on what happens when the whole `style` prop is swapped for a differently-shaped object across renders (the existing "keep whether a host prop is bound fixed for the element lifetime" constraint would need an equivalent for entries added to or removed from a style object between renders).

### 6. Ship `checked` and coarse `style` first; leave `value` and fine-grained `style` open

Land options 3 and 4 as their own change, since neither has the caret/composition risk that `value` carries or the transform-shape change that fine-grained `style` needs, and revisit `value` (options 1/2) and fine-grained `style` (option 5) as separately scoped follow-ups.

Advantages: delivers the lower-risk half of the exclusion list without gating it on the harder half, and gives real usage of the `checked` and `style` bindings before committing to a caret-preservation strategy for `value`. Disadvantages: leaves the motivating case from this investigation — a text `<input>`'s `value` — still requiring the leaf-component pattern until a later decision.

### 7. Keep `value`, `checked`, and `style` excluded; document the leaf-component pattern as the answer

Make no runtime change. Document extracting the reactive prop into its own component (as `TaskRow` and `NewTaskForm` already do) as the supported way to keep a fast-changing signal from re-rendering its parent.

Advantages: no new caret, composition, or controlled/uncontrolled edge cases to test; the pattern is already proven in this repository's own example. Disadvantages: leaves an ergonomic gap the rest of the direct-binding surface does not have — a consumer has to know to reach for component extraction specifically for `value`/`checked`/`style`, with no runtime signal toward that from the JSX types.

## Decision criteria

Any selected option must have executable tests for:

- typing into a direct-bound `<input value={signal} onChange={...} />` does not move the caret, for both a same-value echo and (if option 2 is adopted) a derived/normalized value;
- an IME composition sequence (`compositionstart` → `compositionupdate` → `compositionend`) completes uncorrupted when another subscriber of the same signal writes back mid-composition;
- a direct write to `value`/`checked` never itself dispatches a native `input`/`change` event (no feedback loop through `onChange`);
- an unrelated re-render of the owning component — which recreates `ReactiveHost`'s ref callback and tears down/rebuilds the bound effects, since that callback is a new closure on every render — does not let React's controlled-input reconciliation snap a focused, direct-bound `value`/`checked` element back to the stale value captured at that render, and does not itself visibly disturb an in-progress edit or IME composition;
- a `checked` direct binding on a `type="radio"` group backed by independent per-option `computed` signals unchecks siblings correctly;
- SSR-rendered `value`/`checked`/`style` (from `.peek()`) matches the client's first-paint DOM state exactly, checked by reading the live DOM property after hydration rather than by asserting the absence of a console warning — React does not emit hydration-mismatch warnings for controlled `value`/`checked` by design, so an assertion on that warning would pass vacuously;
- React 19 Strict Mode's dev-mode double-invoke of the ref effect does not lose focus, caret, or in-progress IME composition, beyond whatever the ordinary re-render case above already covers;
- `style` coercion: a unitless-vs-unit-required numeric CSS property, a `--custom-property` entry, and a property present in a previous style object but absent from the current one (must be cleared, not left stale);
- if fine-grained `style` tracking ships: a style object mixing signal and non-signal entries updates only the entries whose signal changed, leaving sibling properties untouched.

## Current recommendation

Until a decision is made, `value`, `checked`, and `style` remain outside direct binding, and the supported way to isolate a fast-changing signal from its parent's render is the leaf-component pattern already used by `TaskRow` and `NewTaskForm`. This document records what each prop would require; it does not select an option or set an implementation timeline.
