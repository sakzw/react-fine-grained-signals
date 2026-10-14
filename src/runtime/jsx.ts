import { isSignal, untracked } from "../core/index.js";
import { detachedEffect } from "../core/base.js";
import { subscribeReadableV1 } from "../core/readable-subscription.js";
import { notifyListener } from "../core/render-tracking.js";
import type { ReadonlySignal, Signal } from "../core/index.js";
import type { NotDeepSignal } from "../core/deep-signal.js";
import { useSignalValue } from "../react/hooks.js";
import { createElement, Fragment } from "react";
import type * as React from "react";

/** The small set of DOM properties that support direct signal bindings. */
const REACTIVE_PROP_NAMES = new Set([
  "title",
  "id",
  "className",
  "hidden",
  "disabled",
  "style",
  "value",
  "checked",
]);

function domBindingProp(name: string): string {
  return name === "bindValue" ? "value" : name === "bindChecked" ? "checked" : name;
}

/**
 * The concrete strategy a direct binding is mounted with. Resolved once, in
 * `findHostBindings`, from the JSX tag string that is already on hand at
 * element-creation time — `"select"` needs `bindSelectValue`'s MutationObserver
 * workaround, `"input"`/`"textarea"` need `bindTextValue`'s IME handling, and
 * `<input checked>` is the only other two-way case — so `mountBinding` later
 * only has to dispatch on this already-known value instead of re-deriving the
 * same facts from the mounted DOM node's `tagName`. It is also half of a
 * binding's identity for `NodeBinder`'s re-attach diff.
 */
type BindingKind = "style" | "style-properties" | "select-value" | "text-value" | "checked" | "prop";

function resolveBindingKind(tagName: string, name: string): BindingKind {
  if (name === "bindValue") return "text-value";
  if (name === "bindChecked") return "checked";
  if (name === "style") return "style";
  if (name === "value" && tagName === "select") return "select-value";
  return "prop";
}

function isTwoWayBindingKind(kind: BindingKind): boolean {
  return kind === "select-value" || kind === "text-value" || kind === "checked";
}

function isStylePropertyBinding(source: BindingSource): source is StylePropertyBinding {
  return !isSignal(source) && "entries" in source;
}

function sameBindingSource(a: BindingSource, b: BindingSource): boolean {
  if (a === b) return true;
  if (!isStylePropertyBinding(a) || !isStylePropertyBinding(b) || a.entries.length !== b.entries.length) return false;
  return a.entries.every(([key, value], index) => {
    const other = b.entries[index];
    return other !== undefined && key === other[0] && Object.is(value, other[1]);
  });
}

// The uncontrolled counterpart React reads only at mount, used in place of the
// controlled prop so React's own input reconciliation never re-asserts a stale
// signal snapshot over what the direct-binding subscription just wrote.
const UNCONTROLLED_PROP_NAMES: Record<string, string> = {
  value: "defaultValue",
  checked: "defaultChecked",
  bindValue: "defaultValue",
  bindChecked: "defaultChecked",
};

// CSS properties React also treats as unitless: a bound number is written as-is
// instead of getting a "px" suffix. Not exhaustive (SVG-only properties are
// omitted since style binding is HTML-host-only), but covers the common cases.
const UNITLESS_CSS_PROPERTIES = new Set([
  "animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice",
  "borderImageWidth", "boxFlex", "boxFlexGroup", "boxOrdinalGroup", "columnCount",
  "columns", "flex", "flexGrow", "flexPositive", "flexShrink", "flexNegative",
  "flexOrder", "gridArea", "gridColumn", "gridColumnEnd", "gridColumnSpan",
  "gridColumnStart", "gridRow", "gridRowEnd", "gridRowSpan", "gridRowStart",
  "fontWeight", "lineClamp", "lineHeight", "opacity", "order", "orphans",
  "scale", "tabSize", "WebkitLineClamp", "widows", "zIndex", "zoom",
]);

// SVG has a different property model (for example, className is an SVGAnimatedString).
// Keeping it out of the host fast path makes the supported surface explicit.
const SVG_ELEMENTS = [
  "svg", "animate", "animateMotion", "animateTransform", "circle", "clipPath",
  "defs", "desc", "ellipse", "feBlend", "feColorMatrix", "feComponentTransfer",
  "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
  "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG",
  "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology",
  "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile",
  "feTurbulence", "filter", "foreignObject", "g", "image", "line", "linearGradient",
  "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon", "polyline",
  "radialGradient", "rect", "set", "stop", "switch", "symbol", "text", "textPath",
  "tspan", "use", "view",
] as const;

type SvgElement = (typeof SVG_ELEMENTS)[number];

// MathML properties do not share the HTML DOM property model either.  React
// currently types only SVG separately, but custom JSX factories can still
// receive these host tags at runtime.
const MATHML_ELEMENTS = [
  "annotation", "annotation-xml", "maction", "math", "merror", "mfrac",
  "mi", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom",
  "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle",
  "msub", "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder",
  "munderover", "semantics",
] as const;

type MathMlElement = (typeof MATHML_ELEMENTS)[number];
type NonHtmlHostElement = SvgElement | MathMlElement;
// Built without array spread: a bundler has to assume spreading may run an
// iterator with side effects, which kept this module's tag lists in every
// bundle that imports the package root (it re-exports `createElement` from
// here) even when nothing from this module is used.
const NON_HTML_HOST_ELEMENTS: ReadonlySet<string> = /* @__PURE__ */ (() => {
  const tags = new Set<string>(SVG_ELEMENTS);
  for (const tag of MATHML_ELEMENTS) tags.add(tag);
  return tags;
})();

// A deep signal is excluded from every position here: a child or host prop
// observes root replacement only, so nested mutations would never show.
type SignalChild = React.ReactNode | (ReadonlySignal<SignalChild> & NotDeepSignal) | readonly SignalChild[];
type HostProps = Record<string, unknown>;
type StylePropertyBinding = { readonly entries: readonly (readonly [string, unknown])[] };
type BindingSource = ReadonlySignal<unknown> | StylePropertyBinding;
// `snapshot` is the value React itself was handed for the prop at render (see
// `transformHostProps`); a binding hands the node back to it on detach.
type Binding = readonly [name: string, source: BindingSource, kind: BindingKind, snapshot: unknown];
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/**
 * A leaf that lets React own reconciliation while its signal dependency stays
 * local to the leaf.  A signal resolving to another signal/array is normalized
 * again so nested reactive children also work.
 */
export function SignalValue({ source }: { source: ReadonlySignal<SignalChild> }): React.ReactNode {
  return normalizeChild(useSignalValue(source));
}

function normalizeChild(value: unknown): React.ReactNode {
  if (isSignal(value)) {
    return createElement(SignalValue, { source: value as ReadonlySignal<SignalChild> });
  }

  if (Array.isArray(value)) {
    return value.map(normalizeArrayItem);
  }

  return value as React.ReactNode;
}

/**
 * A signal inside an array child has no way to carry a key of its own, so the
 * leaf it becomes is keyed by position. That is the identity such an array
 * already has (a literal `[a, b]` never reorders), and it keeps React's
 * missing-key warning for genuinely dynamic element lists intact. The prefix
 * keeps these keys out of the way of keys on the array's other elements.
 */
function normalizeArrayItem(value: unknown, index: number): React.ReactNode {
  if (isSignal(value)) {
    return createElement(SignalValue, {
      source: value as ReadonlySignal<SignalChild>,
      key: `rfgs-signal:${index}`,
    });
  }
  return normalizeChild(value);
}

function isReactiveHostProp(name: string, value: unknown): value is ReadonlySignal<unknown> {
  if (!isSignal(value)) return false;
  return REACTIVE_PROP_NAMES.has(name) || name.startsWith("data-") || name.startsWith("aria-");
}

function isWritableSignal(value: unknown): value is Signal<unknown> {
  if (!isSignal(value)) return false;
  let target: object | null = value;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "value");
    if (descriptor !== undefined) return typeof descriptor.set === "function" || descriptor.writable === true;
    target = Object.getPrototypeOf(target) as object | null;
  }
  return false;
}

function getStylePropertyBinding(value: unknown): { source: StylePropertyBinding; snapshot: Record<string, unknown> } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isSignal(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.some(([, entry]) => isSignal(entry))) return undefined;
  const snapshot: Record<string, unknown> = {};
  for (const [key, entry] of entries) snapshot[key] = isSignal(entry) ? entry.peek() : entry;
  return { source: { entries }, snapshot };
}

function readInitialValue(source: ReadonlySignal<unknown>, kind: BindingKind): unknown {
  const value = source.peek();
  // React DOM freezes the style object it is given in development. The signal
  // keeps owning its object (a `deepSignal`'s raw state, for one), so React gets
  // a shallow copy rather than a reference it would freeze out from under it.
  if (kind === "style" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...value };
  }
  return value;
}

/**
 * Per-binding "already reported this episode" latch for `readBoundSignal`.
 * Owned by the same closure that already holds a binding's other local state
 * (`previousKeys`, `composing`, ...) — never module-level — so two bindings
 * failing independently each still get their own first-failure log instead of
 * one silencing the other.
 */
type FailureEpisode = { hasReported: boolean };

/**
 * Reads a signal on behalf of one of this module's direct DOM bindings (see
 * the module doc: these write straight to the DOM from a subscription mounted
 * alongside the element's ref, bypassing React's render, so the owning
 * component never re-renders). A `computed()` whose getter throws caches and
 * rethrows that error on every read (see `updateComputed` in
 * src/core/alien-derived-runtime-core.mts) —
 * if `source` is such a computed and it starts failing after the binding is
 * already mounted, an unguarded read here could throw from the subscription's
 * update callback while processing the write. The direct V1 watcher contains
 * computed dirty-check errors, but this binding read is a separate operation;
 * catching it here also keeps the structural-readable effect fallback local.
 *
 * Catching here keeps a failure local to this one binding: the DOM write for
 * this cycle is skipped (the DOM is left at its last successful value) and
 * the failure is reported with `console.error(message, { cause: error })` —
 * assert against `mock.calls[i][1].cause` in tests, the same shape used by
 * `effect()`'s failure report (`reportFailure` in
 * src/core/alien-derived-runtime-core.mts) and by `render-tracking.ts`. Reporting is intentional here too: a direct binding
 * has no Error Boundary or other surface to fall back on, and silence would
 * mean a binding that mysteriously stops updating with zero trace.
 *
 * Reported at most once per contiguous run of failures ("episode"): `episode`
 * latches after the first report and is cleared the moment a read next
 * succeeds, so a later, distinct failure episode logs again. This keeps a
 * `computed()` that fails on every keystroke from spamming one `console.error`
 * per keystroke.
 */
function readBoundSignal<T>(
  read: () => T,
  episode: FailureEpisode,
): { ok: true; value: T } | { ok: false } {
  try {
    const value = read();
    episode.hasReported = false;
    return { ok: true, value };
  } catch (error) {
    if (!episode.hasReported) {
      episode.hasReported = true;
      console.error(
        "react-fine-grained-signals: a direct signal binding's read threw; skipping this update and leaving the DOM at its last value.",
        { cause: error },
      );
    }
    return { ok: false };
  }
}

/**
 * Reads via `readBoundSignal` and, on success, hands the value to `apply`; a
 * failed read is already reported by `readBoundSignal`, so this just skips
 * the write. Shared by every read-and-apply call site below, including the
 * one that isn't itself a subscription callback — the MutationObserver-triggered
 * re-apply in `bindSelectValue`, which reads outside the reactive graph via
 * `.peek()`.
 */
function applyBoundSignal<T>(
  read: () => T,
  apply: (value: T) => void,
  episode: FailureEpisode,
): void {
  const result = readBoundSignal(read, episode);
  if (result.ok) apply(result.value);
}

/**
 * The common case built on `applyBoundSignal`: subscribe to a readable and
 * re-run `apply` whenever it changes. V1 readables use a direct protocol
 * subscription; structural readables retain the effect bridge. Centralizes
 * the pattern that used to be hand-rolled at each binding site — declare an
 * `episode`, then `effect(() => { const read = readBoundSignal(...); if
 * (!read.ok) return; <apply the value> })` — so the read-and-skip contract
 * can't drift between sites. An `episode` may be passed in to share a
 * failure latch with a sibling read site (see `bindSelectValue`); otherwise
 * each binding gets its own.
 */
/**
 * A live binding subscription; `refresh` re-applies the current value. A
 * `"style"` binding also takes the render snapshot it is re-attached for (see
 * `subscribeBinding`); every other kind ignores it.
 */
type BindingSubscription = { readonly dispose: () => void; readonly refresh: (snapshot?: unknown) => void };

function createBindingSubscription<T>(
  source: ReadonlySignal<T>,
  apply: (value: T) => void,
  episode: FailureEpisode = { hasReported: false },
): BindingSubscription {
  const update = () => applyBoundSignal(() => source.value, apply, episode);
  const refresh = () => untracked(update);
  const unsubscribe = subscribeReadableV1(source, update);
  if (unsubscribe !== undefined) {
    // Subscribe before the initial read/apply so setup cannot miss an update.
    untracked(() => notifyListener(update));
    return { dispose: unsubscribe, refresh };
  }
  return { dispose: detachedEffect(update), refresh };
}

function setAttribute(node: Element, name: string, value: unknown): void {
  if (value == null) {
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, String(value));
  }
}

function setDomProp(node: Element, name: string, value: unknown): void {
  // Tags such as `a`, `script`, `style`, and `title` exist in both HTML and
  // SVG. The JSX factory only sees the tag name, so defer the final namespace
  // decision until React gives us the actual DOM node.
  if (node.namespaceURI !== HTML_NAMESPACE) {
    setAttribute(node, name === "className" ? "class" : name, value);
    return;
  }

  switch (name) {
    case "title":
      if (value == null) node.removeAttribute(name);
      else (node as HTMLElement).title = String(value);
      return;
    case "id":
      if (value == null) node.removeAttribute(name);
      else (node as HTMLElement).id = String(value);
      return;
    case "className":
      (node as HTMLElement).className = value == null ? "" : String(value);
      return;
    case "hidden":
      // The `hidden` content attribute also accepts the DOM-native keyword
      // `"until-found"` (a collapsible, find-in-page-revealable hidden
      // state) — coercing every value through `Boolean(...)` and the
      // `.hidden` IDL property would turn that truthy string into a plain
      // `true`, downgrading it to a hard hide. Writing it as the attribute
      // directly instead preserves the keyword; every other value keeps
      // going through `.hidden` so `disabled`-style boolean semantics
      // (including the false/null/undefined-removes-the-attribute cases)
      // are unchanged.
      if (value === "until-found") setAttribute(node, "hidden", value);
      else (node as HTMLElement).hidden = Boolean(value);
      return;
    case "disabled":
      // Only controls expose this property, but the runtime remains safe when
      // JSX places it on another HTML element.
      if ("disabled" in node) (node as HTMLButtonElement).disabled = Boolean(value);
      else if (value == null || value === false) node.removeAttribute(name);
      else setAttribute(node, name, value);
      return;
    default:
      setAttribute(node, name, value);
  }
}

/**
 * Writes `value`/`checked` on a controlled-two-way element, skipping the DOM
 * write when it already holds the value being written. A binding update
 * follows signal writes, including keystrokes written by `onChange`, so without
 * this guard every keystroke would re-set a property the DOM already has,
 * moving the caret and disrupting IME composition for no reason.
 */
function setControlledProp(node: Element, name: string, value: unknown): void {
  if (name === "value") {
    const select = node as HTMLSelectElement;
    if (select.tagName === "SELECT") {
      setSelectValue(select, value);
      return;
    }
    const next = value == null ? "" : String(value);
    const input = node as HTMLInputElement | HTMLTextAreaElement;
    if (input.value !== next) {
      const active = input.ownerDocument.activeElement === input;
      let start: number | null = null;
      let end: number | null = null;
      let direction: "forward" | "backward" | "none" | null = null;
      if (active) {
        try {
          start = input.selectionStart;
          end = input.selectionEnd;
          direction = input.selectionDirection;
        } catch {
          // Some input types do not expose a text selection API.
        }
      }
      input.value = next;
      if (active && start !== null && end !== null) {
        const limit = next.length;
        try {
          input.setSelectionRange(Math.min(start, limit), Math.min(end, limit), direction ?? undefined);
        } catch {
          // Selection restoration is best-effort for text-like controls.
        }
      }
    }
    // The default is what a form reset restores (`form.reset()`, a reset
    // button, React 19's reset after a form action). Keeping it equal to the
    // bound value makes a reset land on the signal's value, as React does for a
    // controlled input by syncing its `value` attribute, instead of reverting to
    // the first render's value and leaving the DOM and the signal disagreeing.
    if (input.defaultValue !== next) input.defaultValue = next;
    return;
  }
  const next = Boolean(value);
  const input = node as HTMLInputElement;
  if (input.checked !== next) input.checked = next;
  if (input.defaultChecked !== next) input.defaultChecked = next;
}

function bindFormReset(node: HTMLInputElement | HTMLTextAreaElement, refresh: () => void): () => void {
  const form = node.form;
  if (form === null) return () => {};
  const onReset = (event: Event) => {
    // The browser applies native defaults after dispatching `reset`; React may
    // also restore its last rendered default during its delegated event pass.
    // Refresh in a microtask so the binding's current signal value wins only
    // after an accepted reset has completed.
    queueMicrotask(() => {
      if (!event.defaultPrevented) refresh();
    });
  };
  form.addEventListener("reset", onReset);
  return () => form.removeEventListener("reset", onReset);
}

/**
 * `<select multiple>` does not support assigning `.value` directly — the DOM
 * setter only ever selects a single option, silently corrupting the
 * selection instead of erroring. Its documented API for a multi-value select
 * is per-`<option>` `.selected`, so an array-valued signal (React's own
 * typing for a multi-select) is applied that way instead.
 */
function setSelectValue(select: HTMLSelectElement, value: unknown): void {
  const multiple = select.multiple;
  const values = new Set(
    Array.isArray(value) && multiple ? value.map(String) : value == null ? (multiple ? [] : [""]) : [String(value)],
  );
  // A single select keeps going through `.value`, which also handles a value
  // no option matches (nothing selected).
  if (!multiple) {
    const next = [...values][0]!;
    if (select.value !== next) select.value = next;
  }
  for (const option of select.options) {
    const selected = values.has(option.value);
    if (multiple && option.selected !== selected) option.selected = selected;
    // See `setControlledProp`: a form reset restores `defaultSelected`.
    if (option.defaultSelected !== selected) option.defaultSelected = selected;
  }
}

/**
 * A `<select>` whose matching `<option>` does not exist yet (for example when
 * the options themselves are rendered from a signal or other state, mounted
 * after this one) silently ends up with nothing selected: the DOM neither
 * errors nor retroactively applies `.value`/`.selected` once a matching
 * `<option>` is later added. The value subscription below only updates when
 * the bound signal itself changes, so it cannot see that the option list changed
 * out from under it. A MutationObserver on the select's subtree re-applies
 * the signal's current value whenever its `<option>` list changes, closing
 * that gap without requiring the signal to change too.
 */
function bindSelectValue(select: HTMLSelectElement, source: ReadonlySignal<unknown>, apply: (value: unknown) => void): BindingSubscription {
  // Shared by both read sites below: a subscription-triggered failure and a
  // MutationObserver-triggered failure are the same underlying computed
  // erroring, so they report as one episode, not two.
  const episode: FailureEpisode = { hasReported: false };
  const subscription = createBindingSubscription(source, apply, episode);
  const observer = new MutationObserver(() => {
    applyBoundSignal(() => source.peek(), apply, episode);
  });
  observer.observe(select, { childList: true, subtree: true });
  return {
    dispose() {
      subscription.dispose();
      observer.disconnect();
    },
    refresh: subscription.refresh,
  };
}

/**
 * Forcing a `value` write while an IME composition is in progress can abort
 * the composition outright, independent of whether the string being written
 * happens to match what was typed — the write-skip guard in
 * `setControlledProp` only protects the same-value echo case, not this one.
 * `compositionstart`/`compositionend` listeners on the node itself track
 * composition state directly, regardless of whether the component declares
 * its own composition handlers, and a write requested while composing is
 * deferred until composition ends instead of applied immediately.
 */
function bindTextValue(
  node: HTMLInputElement | HTMLTextAreaElement,
  source: Signal<unknown>,
  write: (value: unknown) => void,
): BindingSubscription {
  let composing = false;
  let hasPending = false;
  let pending: unknown;
  const episode: FailureEpisode = { hasReported: false };

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    if (hasPending) {
      hasPending = false;
      write(pending);
    }
  };
  const onInput = () => {
    source.value = node.value;
  };

  node.addEventListener("compositionstart", onCompositionStart);
  node.addEventListener("compositionend", onCompositionEnd);
  node.addEventListener("input", onInput);

  // A failed read must bail out before this touches `pending`/`hasPending` —
  // a stale or garbage value must never latch in. `createBindingSubscription`
  // already skips `apply` on a failed read, so that guard lives there once.
  const subscription = createBindingSubscription(source, (next) => {
    if (composing) {
      hasPending = true;
      pending = next;
      return;
    }
    write(next);
  }, episode);
  const disposeReset = bindFormReset(node, subscription.refresh);

  return {
    dispose() {
      subscription.dispose();
      disposeReset();
      node.removeEventListener("compositionstart", onCompositionStart);
      node.removeEventListener("compositionend", onCompositionEnd);
      node.removeEventListener("input", onInput);
    },
    refresh: subscription.refresh,
  };
}

function clearStyleProperty(style: CSSStyleDeclaration, key: string): void {
  if (key.startsWith("--")) style.removeProperty(key);
  else (style as unknown as Record<string, string>)[key] = "";
}

function setStyleProperty(style: CSSStyleDeclaration, key: string, value: unknown): void {
  if (value == null) {
    clearStyleProperty(style, key);
    return;
  }
  if (key.startsWith("--")) {
    style.setProperty(key, String(value));
    return;
  }
  const cssValue = typeof value === "number" && !UNITLESS_CSS_PROPERTIES.has(key)
    ? `${value}px`
    : String(value);
  (style as unknown as Record<string, string>)[key] = cssValue;
}

/**
 * Applies a whole style object to an element, clearing keys that were present
 * in a previous call but are absent from this one. Signal-valued entries are
 * aggregated by `bindStyleProperties` into this existing whole-style binding.
 */
function applyStyle(node: HTMLElement, value: unknown, previousKeys: readonly string[]): string[] {
  // A non-object value (an `any`-typed or otherwise unchecked caller passing
  // a string, for instance) would make `Object.keys` walk string indices
  // instead of CSS property names; treat anything that is not a plain object
  // as empty rather than writing garbage keys to the node's style.
  const nextStyle = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const nextKeys = Object.keys(nextStyle);
  const nextKeySet = new Set(nextKeys);

  for (const key of previousKeys) {
    if (!nextKeySet.has(key)) clearStyleProperty(node.style, key);
  }
  for (const key of nextKeys) {
    setStyleProperty(node.style, key, nextStyle[key]);
  }
  return nextKeys;
}

function subscribeStylePropertyEntries(
  node: Element,
  source: StylePropertyBinding,
  snapshot: unknown,
  initialStyleKeys: readonly string[] | undefined,
  binder: NodeBinder,
): Subscription {
  let previousKeys: readonly string[] = initialStyleKeys ?? getInitialStyleKeys(undefined, snapshot);
  let applied = typeof snapshot === "object" && snapshot !== null ? { ...(snapshot as HostProps) } : {};
  const whileAttached = (write: (value: unknown) => void) => (value: unknown) => {
    if (binder.attached) write(value);
  };
  const subscriptions: BindingSubscription[] = [];
  for (const [key, value] of source.entries) {
    if (!isSignal(value)) continue;
    const write = (next: unknown) => {
      setStyleProperty((node as HTMLElement).style, key, next);
      applied[key] = next;
    };
    subscriptions.push(createBindingSubscription(value as ReadonlySignal<unknown>, whileAttached(write)));
  }
  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
    },
    refresh(nextSnapshot) {
      previousKeys = getInitialStyleKeys(previousKeys, nextSnapshot);
      for (const subscription of subscriptions) subscription.refresh();
    },
    getStyleKeys: () => previousKeys,
    restore(nextSnapshot) {
      if (!isSameStyle(applied, nextSnapshot)) {
        previousKeys = applyStyle(node as HTMLElement, nextSnapshot, previousKeys);
        applied = typeof nextSnapshot === "object" && nextSnapshot !== null
          ? { ...(nextSnapshot as HostProps) }
          : {};
      }
    },
  };
}

type RefCleanup = void | (() => void);
type SupportedRef = React.Ref<Element> | undefined;

function applyRef(ref: SupportedRef, node: Element | null): RefCleanup {
  if (typeof ref === "function") return ref(node);
  if (ref != null) ref.current = node;
}

/**
 * One live binding: the tuple it was mounted from, its teardown, and — for a
 * `"style"` binding only — a live accessor for the CSS property keys it has
 * actually applied to the node so far. `undefined` for every other kind.
 *
 * This is a getter, not a one-time snapshot, because a style binding's own
 * `previousKeys` keeps changing across its lifetime as its subscription updates; a
 * rebuild reads it just before disposing the binding, so it sees whatever the
 * binding last actually wrote, not what it started with. See `NodeBinder`.
 */
type MountedBinding = {
  readonly binding: Binding;
  readonly dispose: () => void;
  readonly refresh: (snapshot?: unknown) => void;
  readonly getStyleKeys: (() => readonly string[]) | undefined;
  readonly restore: ((snapshot: unknown) => void) | undefined;
};

/** A binding's identity for the re-render diff: same name, source, and kind. */
// `b` is optional so callers can pass a positional lookup straight in: a
// missing counterpart is simply not the same binding.
function isSameBinding(a: Binding, b: Binding | undefined): b is Binding {
  return b !== undefined && a[0] === b[0] && sameBindingSource(a[1], b[1]) && a[2] === b[2];
}

/** Whether two style values set the same properties to the same values. */
function isSameStyle(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.is((a as HostProps)[key], (b as HostProps)[key]));
}

/**
 * Whether React was handed the same value for this binding's prop. A two-way
 * binding hands React an uncontrolled default that it reads only at mount, so
 * only `"prop"` and `"style"` snapshots count; a style snapshot is a fresh copy
 * every render (see `readInitialValue`), so it is compared by content.
 */
function hasSameSnapshot(a: Binding, b: Binding): boolean {
  return isTwoWayBindingKind(a[2]) || (a[2] === "style" || a[2] === "style-properties"
    ? isSameStyle(a[3], b[3])
    : Object.is(a[3], b[3]));
}

/** What `subscribeBinding` hands back to `mountBinding`. See `MountedBinding`. */
type Subscription = BindingSubscription & {
  readonly getStyleKeys: (() => readonly string[]) | undefined;
  readonly restore: ((snapshot: unknown) => void) | undefined;
};

/**
 * Subscribes a single binding to `node` and returns its teardown. Split out of
 * the ref callback so `NodeBinder` can rebuild one binding on
 * its own, without disturbing the siblings that did not change.
 *
 * `initialStyleKeys` seeds a `"style"` binding's own `previousKeys` (see
 * `getInitialStyleKeys`), so the fresh binding starts already knowing which
 * CSS properties may be on the node, instead of starting from an empty set
 * and never clearing them. Ignored for every other kind.
 */
function subscribeBinding(
  node: Element,
  name: string,
  source: BindingSource,
  kind: BindingKind,
  snapshot: unknown,
  initialStyleKeys: readonly string[] | undefined,
  binder: NodeBinder,
): Subscription {
  // Between a detach and its deferred teardown (see `NodeBinder`) the node is
  // no longer React's, so writes are held back; a re-attach refreshes instead.
  const whileAttached = <T,>(write: (value: T) => void) => (value: T) => {
    if (binder.attached) write(value);
  };
  switch (kind) {
    case "style": {
      if (isStylePropertyBinding(source)) throw new Error("Internal style binding kind mismatch");
      let previousKeys: readonly string[] = initialStyleKeys ?? [];
      let applied: unknown;
      const write = (value: unknown) => {
        applied = value;
        previousKeys = applyStyle(node as HTMLElement, value, previousKeys);
      };
      const subscription = createBindingSubscription(source, whileAttached(write));
      return {
        ...subscription,
        // Kept across a re-attach for a newer render: React's diff has just
        // written that render's snapshot, whose keys the detach's `restore`
        // did not know about. The signal may already have dropped some of
        // them (a write while detached is held back), so the refresh must be
        // able to clear them.
        refresh: (snapshot) => {
          previousKeys = getInitialStyleKeys(previousKeys, snapshot);
          subscription.refresh();
        },
        getStyleKeys: () => previousKeys,
        restore: (snapshot) => { if (!isSameStyle(applied, snapshot)) write(snapshot); },
      };
    }
    case "style-properties": {
      if (!isStylePropertyBinding(source)) throw new Error("Internal style property source mismatch");
      return subscribeStylePropertyEntries(node, source, snapshot, initialStyleKeys, binder);
    }
    case "select-value":
      return {
        ...bindSelectValue(node as HTMLSelectElement, source as ReadonlySignal<unknown>, whileAttached((value: unknown) => setControlledProp(node, "value", value))),
        getStyleKeys: undefined,
        restore: undefined,
      };
    case "text-value":
      return {
        ...bindTextValue(node as HTMLInputElement | HTMLTextAreaElement, source as Signal<unknown>, whileAttached((value: unknown) => setControlledProp(node, domBindingProp(name), value))),
        getStyleKeys: undefined,
        restore: undefined,
      };
    case "checked":
      if (name === "bindChecked") {
        const input = node as HTMLInputElement;
        const writableSource = source as Signal<unknown>;
        const onChange = () => { writableSource.value = input.checked; };
        input.addEventListener("change", onChange);
        const subscription = createBindingSubscription(source as ReadonlySignal<unknown>, whileAttached((value: unknown) => setControlledProp(node, domBindingProp(name), value)));
        const disposeReset = bindFormReset(input, subscription.refresh);
        return {
          ...subscription,
          dispose() {
            subscription.dispose();
            disposeReset();
            input.removeEventListener("change", onChange);
          },
          getStyleKeys: undefined,
          restore: undefined,
        };
      }
      return {
        ...createBindingSubscription(source as ReadonlySignal<unknown>, whileAttached((value: unknown) => setControlledProp(node, name, value))),
        getStyleKeys: undefined,
        restore: undefined,
      };
    case "prop": {
      let applied: unknown;
      const write = (value: unknown) => {
        applied = value;
        setDomProp(node, name, value);
      };
      return {
        ...createBindingSubscription(source as ReadonlySignal<unknown>, whileAttached(write)),
        getStyleKeys: undefined,
        restore: (snapshot) => { if (!Object.is(applied, snapshot)) write(snapshot); },
      };
    }
  }
}

/**
 * The CSS properties a new `"style"` binding may find on the node: React wrote
 * this binding's render-time snapshot, and a replaced binding (`staleKeys`) may
 * have written keys React never saw. The signal can drop any of them before the
 * binding attaches (a write between render and commit, an Activity or Suspense
 * reveal), so the first write must be able to clear all of them. A kept
 * binding re-attached for a newer render widens its own keys the same way.
 */
function getInitialStyleKeys(staleKeys: readonly string[] | undefined, snapshot: unknown): readonly string[] {
  const keys = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? Object.keys(snapshot) : [];
  if (staleKeys === undefined) return keys;
  for (const key of staleKeys) if (!keys.includes(key)) keys.push(key);
  return keys;
}

function mountBinding(node: Element, binding: Binding, binder: NodeBinder, staleStyleKeys?: readonly string[]): MountedBinding {
  const initialStyleKeys = binding[2] === "style" || binding[2] === "style-properties"
    ? getInitialStyleKeys(staleStyleKeys, binding[3])
    : undefined;
  const { dispose, refresh, getStyleKeys, restore } = subscribeBinding(
    node,
    binding[0],
    binding[1],
    binding[2],
    binding[3],
    initialStyleKeys,
    binder,
  );
  return { binding, dispose, refresh, getStyleKeys, restore };
}

/**
 * Owns the direct bindings mounted on one DOM node.
 *
 * Bindings are attached through a callback ref on the host element itself
 * rather than through a wrapper component. A wrapper would change the element
 * type whenever a prop switched between a signal and a plain value, and React
 * remounts a subtree whose element type changes, losing descendant state and
 * focus. With the ref, the element stays the same host type in both cases.
 *
 * The binder is keyed by the node, not by the ref callback, because React
 * replaces a callback ref whose identity changed by detaching the old one and
 * attaching the new one to the same node within a single commit. Tearing the
 * bindings down on that detach would recreate every subscription — and reset
 * `bindTextValue`'s in-flight IME composition state — on unrelated re-renders.
 * So a detach only schedules the teardown, and a re-attach of the same node in
 * the same commit reconciles the bindings in place instead (`syncBindings`
 * diffs by `(name, source, kind)`). A detach that is not followed by an attach
 * (unmount, a hidden Activity or Suspense boundary) tears down in a microtask.
 *
 * The user's own ref is forwarded synchronously on every attach and detach,
 * which is exactly what React would do with it directly; `getBindingRef` keeps
 * the callback's identity stable whenever the inputs are, so a stable user ref
 * is not churned.
 */
class NodeBinder {
  #node: Element;
  #mounted: MountedBinding[] = [];
  #token = 0;
  #detached = false;

  constructor(node: Element) {
    this.#node = node;
  }

  /** Whether React currently has this node attached through a binding ref. */
  get attached(): boolean {
    return !this.#detached;
  }

  attach(bindings: readonly Binding[], userRef: SupportedRef): () => void {
    const token = ++this.#token;
    const wasDetached = this.#detached;
    this.#detached = false;
    // Kept bindings may have skipped a write while detached. Each is handed the
    // snapshot React just committed for its prop (matched by name, which is
    // unique per element), so a style binding can clear that snapshot's keys.
    // Only a binding the new render keeps as the same binding refreshes: one it
    // removed, turned plain, or replaced lost the prop to React's diff (or to
    // its replacement), and a refresh would write its stale source over that
    // just before `#sync` disposes it, with nothing left to correct it.
    if (wasDetached) {
      for (const entry of this.#mounted) {
        const next = bindings.find((binding) => binding[0] === entry.binding[0]);
        if (isSameBinding(entry.binding, next)) entry.refresh(next[3]);
      }
    }
    this.#sync(bindings);
    let userCleanup: RefCleanup;
    try {
      userCleanup = applyRef(userRef, this.#node);
    } catch (error) {
      // React gets no cleanup from a ref that threw, and later only calls it
      // with `null`, which carries no node. Detach now so the bindings just
      // subscribed do not outlive the element; the error is React's to handle.
      this.#detach(token, bindings);
      throw error;
    }
    return () => {
      // A throwing user cleanup is still reported by React, but must not keep
      // the bindings subscribed to an element React is letting go of.
      try {
        if (typeof userCleanup === "function") userCleanup();
        else applyRef(userRef, null);
      } finally {
        this.#detach(token, bindings);
      }
    };
  }

  /**
   * Hands the node back to React for the attach identified by `token`: writes
   * are held back from now on, and the bindings are disposed in a microtask
   * unless the same node is attached again first (see the class doc).
   */
  #detach(token: number, bindings: readonly Binding[]): void {
    // React detaches the old ref before attaching the new one, so a newer
    // attach can only exist here if this detach is stale.
    if (token !== this.#token) return;
    this.#detached = true;
    // React detaches a host's ref right before it diffs the host's props, and
    // that diff starts from the snapshot it was handed, not from what the
    // bindings wrote since. Hand the node back to that snapshot, or a plain
    // value equal to it is skipped and the signal's last value stays in the
    // DOM. `#mounted` lines up with `bindings` (see `#sync`), and a snapshot
    // change gives the element a new ref (`getBindingRef`), so this is the
    // committed one. A re-attach in the same commit refreshes right after.
    this.#mounted.forEach((entry, index) => entry.restore?.(bindings[index]![3]));
    queueMicrotask(() => {
      if (this.#detached && token === this.#token) this.#dispose();
    });
  }

  #dispose(): void {
    const mounted = this.#mounted;
    this.#mounted = [];
    for (const binding of mounted) binding.dispose();
  }

  #sync(bindings: readonly Binding[]): void {
    const mounted = this.#mounted;
    // The common re-attach — a re-render that changed nothing about the
    // bindings — costs one walk and allocates nothing.
    if (
      mounted.length === bindings.length
      && mounted.every((entry, index) => isSameBinding(entry.binding, bindings[index]))
    ) {
      return;
    }

    // Keyed by prop name, which is unique per element: a binding whose source
    // or kind changed under the same name is a rebuild, not a reuse.
    const reusable = new Map<string, MountedBinding>();
    for (const entry of mounted) reusable.set(entry.binding[0], entry);

    const reused = bindings.map((binding) => {
      const candidate = reusable.get(binding[0]);
      if (candidate === undefined || !isSameBinding(candidate.binding, binding)) return undefined;
      reusable.delete(binding[0]);
      return candidate;
    });

    // A `"style"` binding being replaced under the same name is the only record
    // of which CSS properties it actually wrote to the node (an off-render
    // write may have applied keys React never saw). Its replacement starts from
    // that set, plus its own snapshot's keys, so its first write can still
    // clear them.
    const staleStyleKeys = new Map<string, readonly string[]>();
    for (const stale of reusable.values()) {
      if (stale.getStyleKeys !== undefined) staleStyleKeys.set(stale.binding[0], stale.getStyleKeys());
    }

    // Everything stale is disposed before anything replacing it is mounted, so
    // a rebuilt binding never briefly holds two live subscriptions on one node.
    for (const stale of reusable.values()) stale.dispose();
    const node = this.#node;
    this.#mounted = bindings.map(
      (binding, index) => reused[index] ?? mountBinding(node, binding, this, staleStyleKeys.get(binding[0])),
    );
  }
}

const nodeBinders = new WeakMap<Element, NodeBinder>();

function createBindingRef(bindings: readonly Binding[], userRef: SupportedRef): (node: Element | null) => RefCleanup {
  return (node) => {
    // React 19 detaches through the returned cleanup; a `null` call only comes
    // from a host that ignores cleanups, where the next attach reconciles.
    if (node == null) return;
    let binder = nodeBinders.get(node);
    if (binder === undefined) {
      binder = new NodeBinder(node);
      nodeBinders.set(node, binder);
    }
    return binder.attach(bindings, userRef);
  };
}

type BindingRefEntry = {
  readonly bindings: readonly Binding[];
  readonly userRef: SupportedRef;
  readonly ref: (node: Element | null) => RefCleanup;
};

// Recently created binding refs, so re-rendering an element with the same
// signals and the same user ref hands React the same callback and React does
// not detach and re-attach it at all. Keyed weakly by the user ref when there
// is one (so the cache lives exactly as long as that ref) and otherwise by the
// first bound signal, with a small bound per key so an element whose bindings
// keep changing cannot grow it.
const bindingRefs = new WeakMap<object, BindingRefEntry[]>();
const BINDING_REF_CACHE_LIMIT = 8;

// Also compares snapshots, so a ref is only ever attached for the exact values
// React was handed: the detach in `NodeBinder` restores to those.
function haveSameBindings(a: readonly Binding[], b: readonly Binding[]): boolean {
  return a.length === b.length
    && a.every((binding, index) => isSameBinding(binding, b[index]) && hasSameSnapshot(binding, b[index]!));
}

function getBindingRef(bindings: readonly Binding[], userRef: SupportedRef): (node: Element | null) => RefCleanup {
  // A user ref is an object or function, never one of the bound signals, so
  // the two kinds of key cannot collide in one map.
  const firstSource = bindings[0]![1];
  const styleSignal = isStylePropertyBinding(firstSource)
    ? firstSource.entries.find(([, value]) => isSignal(value))?.[1]
    : undefined;
  const cacheKey: object = userRef ?? styleSignal ?? firstSource;
  const cache = bindingRefs;
  let entries = cache.get(cacheKey);
  if (entries !== undefined) {
    for (const entry of entries) {
      if (entry.userRef === userRef && haveSameBindings(entry.bindings, bindings)) return entry.ref;
    }
  } else {
    entries = [];
    cache.set(cacheKey, entries);
  }
  const ref = createBindingRef(bindings, userRef);
  if (entries.length >= BINDING_REF_CACHE_LIMIT) entries.shift();
  entries.push({ bindings, userRef, ref });
  return ref;
}

type CreateElement = (type: React.ElementType, props: unknown, key?: React.Key) => React.ReactElement;

/**
 * Scans a native host element's props for anything reactive (see
 * `isReactiveHostProp`). Kept separate from building the transformed props
 * copy in `transformHostProps` so that function can decide whether a copy is
 * needed at all before ever allocating one.
 */
function findHostBindings(props: HostProps, tagName: string): Binding[] {
  const bindings: Binding[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (name === "bindValue" || name === "bindChecked") {
      if (!isWritableSignal(value)) {
        throw new TypeError(`react-fine-grained-signals: ${name} requires a writable signal.`);
      }
      if (name === "bindValue") {
        const inputType = String(props.type ?? "text").toLowerCase();
        const textInputTypes = new Set(["text", "search", "tel", "url", "password", "email"]);
        if (tagName !== "textarea" && (tagName !== "input" || !textInputTypes.has(inputType))) {
          throw new TypeError("react-fine-grained-signals: bindValue is supported on text-like <input> elements and <textarea> only.");
        }
      } else if (tagName !== "input" || String(props.type ?? "text").toLowerCase() !== "checkbox") {
        throw new TypeError("react-fine-grained-signals: bindChecked is supported on <input type=\"checkbox\"> only; radio groups need a shared selection value.");
      }
      const kind = resolveBindingKind(tagName, name);
      bindings.push([name, value, kind, readInitialValue(value, kind)]);
      continue;
    }
    if ((name === "value" || name === "checked") && isSignal(value)) {
      throw new TypeError(`react-fine-grained-signals: signal-valued ${name} props are no longer implicit bindings. Use ${name === "value" ? "bindValue" : "bindChecked"}={signal} for direct binding, or pass signal.value for React-controlled semantics.`);
    }
    if (isReactiveHostProp(name, value)) {
      const kind = resolveBindingKind(tagName, name);
      bindings.push([name, value, kind, readInitialValue(value, kind)]);
    }
  }
  return bindings;
}

/**
 * Transforms a native host element's (`<div>`, `<svg>`, ...) props: replaces
 * any directly-bound prop with its initial, non-reactive value (`bindings`
 * carries the reactive ones for the binding ref to mount later — see
 * `createJsxWrapper`) and normalizes a signal/array `children` the same way
 * `Fragment` does.
 *
 * The overwhelmingly common host element has neither. Scanning first and only
 * allocating a copy when something is actually found means a plain
 * `<div className="card">…</div>` costs one prop walk and zero extra
 * allocations — the original props object is returned as-is (see the
 * `bindings.length === 0 && !childrenNeedNormalization` branch below), and
 * `createJsxWrapper` passes it straight to `factory` unchanged.
 */
function transformHostProps(type: string, input: unknown): { props: HostProps; bindings: Binding[] } {
  const inputProps = (input ?? {}) as HostProps;
  const isHtmlHost = !NON_HTML_HOST_ELEMENTS.has(type);
  const styleProperties = isHtmlHost ? getStylePropertyBinding(inputProps.style) : undefined;
  const normalizedProps = styleProperties === undefined
    ? inputProps
    : { ...inputProps, style: styleProperties.snapshot };
  const bindings = isHtmlHost ? findHostBindings(normalizedProps, type) : [];
  if (styleProperties !== undefined) {
    bindings.push(["style", styleProperties.source, "style-properties", styleProperties.snapshot]);
  }

  const rawChildren = normalizedProps.children;
  const childrenNeedNormalization =
    "children" in normalizedProps && (isSignal(rawChildren) || Array.isArray(rawChildren));

  if (bindings.length === 0 && !childrenNeedNormalization) {
    return { props: normalizedProps, bindings };
  }

  // Something needs to change, so — and only so — a copy is made; the
  // original `inputProps` (and, transitively, whatever object the caller
  // passed as `input`) is never mutated.
  const props: HostProps = { ...normalizedProps };
  if (childrenNeedNormalization) {
    props.children = normalizeChild(rawChildren);
  }
  for (const [name, , kind, snapshot] of bindings) {
    // Only explicit `bindValue`/`bindChecked` bindings use two-way kinds, so
    // this lookup maps them to their React initialization props. Should a new
    // kind ever miss the table, keep the previous direct-prop behavior.
    const uncontrolledName = isTwoWayBindingKind(kind) ? UNCONTROLLED_PROP_NAMES[name] : undefined;
    if (uncontrolledName !== undefined) {
      // Leaving the controlled prop in place would keep the element
      // React-controlled, so an unrelated re-render of the owner would
      // re-diff and potentially re-write this prop — work relying on an
      // internal React guard (skipping a same-value write) rather than a
      // documented one. Substituting the uncontrolled prop instead means
      // React only ever reads it once, at mount, and never touches this
      // property again — see development/design/direct-binding-value-checked-style.md.
      delete props[name];
      props[uncontrolledName] = snapshot;
    } else {
      props[name] = snapshot;
    }
  }
  return { props, bindings };
}

/**
 * `Fragment`'s only prop worth transforming is `children`, and only when it
 * is itself a signal or array — `normalizeChild` is the identity for
 * anything else (see its definition) — so a plain `<>...</>` with ordinary
 * children is passed straight through, uncopied, the same way a custom
 * component is below.
 */
function transformFragmentProps(input: unknown): unknown {
  const props = input as HostProps | null;
  if (
    props == null
    || !("children" in props)
    || (!isSignal(props.children) && !Array.isArray(props.children))
  ) {
    return input;
  }
  return { ...props, children: normalizeChild(props.children) };
}

/**
 * A host element's final props: the transformed copy with the binding ref in
 * place of the user's own ref, which the binding ref forwards to. `props` is
 * always a fresh copy whenever there are bindings (see `transformHostProps`).
 */
function withBindingRef(props: HostProps, bindings: readonly Binding[]): HostProps {
  if (bindings.length > 0) props.ref = getBindingRef(bindings, props.ref as SupportedRef);
  return props;
}

/** Creates a JSX wrapper while letting each module supply React's JSX factory. */
export function createJsxWrapper(factory: CreateElement): CreateElement {
  return (type, input, key) => {
    if (typeof type === "string") {
      // The element keeps its own host type whether or not any prop is a
      // signal, and its key is passed straight through, so React reconciles it
      // exactly as it would the plain element.
      const { props, bindings } = transformHostProps(type, input);
      return factory(type, withBindingRef(props, bindings), key);
    }

    if (type === Fragment) {
      return factory(type, transformFragmentProps(input), key);
    }

    // Every other type — function/class components, `memo`, `forwardRef`,
    // Context.Provider/Consumer, Suspense, lazy, ... — receives its props
    // exactly as its caller passed them. None of these were ever touched by
    // children normalization or the reactive-prop scan above, even before
    // this fast path existed, so skipping the copy here changes nothing
    // observable and removes an allocation nothing downstream ever read.
    return factory(type, input, key);
  };
}

/**
 * The classic-runtime `createElement` that the automatic runtime falls back to
 * for `<div {...props} key="k" />` — TypeScript, Babel and Oxc all import it
 * from the package root of `jsxImportSource`. It applies the same host-prop
 * bindings and child normalization as `jsx`, and leaves `key` (and `ref`) in
 * the config for React's own `createElement` to extract.
 */
export function createSignalAwareElement(
  type: React.ElementType,
  config?: Record<string, unknown> | null,
  ...children: unknown[]
): React.ReactElement {
  if (typeof type !== "string" && type !== Fragment) {
    return createElement(type, config, ...(children as React.ReactNode[]));
  }
  const normalizedChildren = children.map((child) => normalizeChild(child)) as React.ReactNode[];
  if (typeof type !== "string") {
    return createElement(type, config, ...normalizedChildren);
  }
  const { props, bindings } = transformHostProps(type, config ?? {});
  return createElement(type, withBindingRef(props, bindings), ...normalizedChildren);
}

type Signalable<T> = T | (ReadonlySignal<T> & NotDeepSignal);
type SignalableStyleObject<T> = {
  [Name in keyof T]: T[Name] | (ReadonlySignal<T[Name]> & NotDeepSignal);
};
type DirectSignalPropName = "title" | "id" | "className" | "hidden" | "disabled" | "style";
type AriaPropName = `aria-${string}`;
type SignalableHtmlProp<Name extends PropertyKey, Value> = Signalable<
  Value | (Name extends "title" | "id" ? null : never)
> | (Name extends "style" ? SignalableStyleObject<NonNullable<Value>> : never);
type AddSignalChildren<P> = Omit<P, "children"> & {
  children?: SignalChild;
};
type SignalizeKnownHtmlProps<P> = {
  [Name in keyof P as Name extends DirectSignalPropName | AriaPropName ? Name : never]:
    SignalableHtmlProp<Name, P[Name]>;
};
type AddHtmlSignalProps<Tag extends keyof React.JSX.IntrinsicElements, P> = Omit<P, DirectSignalPropName | AriaPropName | "children"> & {
  [Name in keyof SignalizeKnownHtmlProps<P>]: SignalizeKnownHtmlProps<P>[Name];
} & {
  [name: `data-${string}`]: Signalable<string | number | boolean | undefined>;
} & (Tag extends "input" ? {
  bindValue?: Signal<string> & NotDeepSignal;
  bindChecked?: Signal<boolean> & NotDeepSignal;
} : Tag extends "textarea" ? {
  bindValue?: Signal<string> & NotDeepSignal;
} : {}) & AddSignalChildren<{}>;

/** Types exposed by `jsxImportSource: "react-fine-grained-signals"`. */
export namespace JSX {
  export type ElementType = React.JSX.ElementType;
  export interface Element extends React.JSX.Element {}
  export interface ElementClass extends React.JSX.ElementClass {}
  export interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  export interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
  export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  export interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  export interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  // An interface (rather than the mapped type itself) so consumers can merge
  // their own elements into it, as they can into React's. Elements added to
  // React's own `JSX.IntrinsicElements` flow through the mapped type as well.
  export interface IntrinsicElements extends SignalIntrinsicElements {}
}

type SignalIntrinsicElements = {
  [Tag in keyof React.JSX.IntrinsicElements]: Tag extends NonHtmlHostElement
    ? AddSignalChildren<React.JSX.IntrinsicElements[Tag]>
    : AddHtmlSignalProps<Tag, React.JSX.IntrinsicElements[Tag]>;
};
