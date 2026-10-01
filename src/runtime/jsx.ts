import { isSignal, untracked } from "../core/index.js";
import { detachedEffect } from "../core/base.js";
import { subscribeReadableV1 } from "../core/readable-subscription.js";
import { notifyListener } from "../core/render-tracking.js";
import type { ReadonlySignal } from "../core/index.js";
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

// `value`/`checked` are two-way bound only on these tags — the ones where React
// itself treats them as a controlled/uncontrolled input. Elsewhere (`<li value>`,
// `<option value>`, `<meter value>`, ...) they are plain, write-only attributes,
// so those keep the same peek-and-substitute treatment as `title`/`disabled`/etc.
function isControlledTwoWayProp(tagName: string, name: string): boolean {
  if (name === "value") return tagName === "input" || tagName === "textarea" || tagName === "select";
  if (name === "checked") return tagName === "input";
  return false;
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
type BindingKind = "style" | "select-value" | "text-value" | "checked" | "prop";

function resolveBindingKind(tagName: string, name: string): BindingKind {
  if (name === "style") return "style";
  if (isControlledTwoWayProp(tagName, name)) {
    if (name === "value") return tagName === "select" ? "select-value" : "text-value";
    return "checked";
  }
  return "prop";
}

function isTwoWayBindingKind(kind: BindingKind): boolean {
  return kind === "select-value" || kind === "text-value" || kind === "checked";
}

// The uncontrolled counterpart React reads only at mount, used in place of the
// controlled prop so React's own input reconciliation never re-asserts a stale
// signal snapshot over what the direct-binding subscription just wrote.
const UNCONTROLLED_PROP_NAMES: Record<string, string> = {
  value: "defaultValue",
  checked: "defaultChecked",
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
type Binding = readonly [name: string, source: ReadonlySignal<unknown>, kind: BindingKind];
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
/** A live binding subscription; `refresh` re-applies the current value. */
type BindingSubscription = { readonly dispose: () => void; readonly refresh: () => void };

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
      (node as HTMLElement).title = value == null ? "" : String(value);
      return;
    case "id":
      (node as HTMLElement).id = value == null ? "" : String(value);
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
    if (input.value !== next) input.value = next;
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
  source: ReadonlySignal<unknown>,
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

  node.addEventListener("compositionstart", onCompositionStart);
  node.addEventListener("compositionend", onCompositionEnd);

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

  return {
    dispose() {
      subscription.dispose();
      node.removeEventListener("compositionstart", onCompositionStart);
      node.removeEventListener("compositionend", onCompositionEnd);
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
 * in a previous call but are absent from this one. Only the coarse
 * `style={signal}` form is bound this way — an object whose individual entries
 * are themselves signals is out of scope (see development/design/direct-binding-value-checked-style.md).
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
  readonly refresh: () => void;
  readonly getStyleKeys: (() => readonly string[]) | undefined;
};

/** A binding's identity for the re-render diff: same name, source, and kind. */
// `b` is optional so callers can pass a positional lookup straight in: a
// missing counterpart is simply not the same binding.
function isSameBinding(a: Binding, b: Binding | undefined): boolean {
  return b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** What `subscribeBinding` hands back to `mountBinding`. See `MountedBinding`. */
type Subscription = BindingSubscription & { readonly getStyleKeys: (() => readonly string[]) | undefined };

/**
 * Subscribes a single binding to `node` and returns its teardown. Split out of
 * the ref callback so `NodeBinder` can rebuild one binding on
 * its own, without disturbing the siblings that did not change.
 *
 * `initialStyleKeys` seeds a `"style"` binding's own `previousKeys` — passed
 * by `syncBindings` when this binding is replacing a disposed style binding,
 * so the fresh one starts already knowing which CSS properties are actually
 * on the node, instead of starting from an empty set and never clearing them.
 * Ignored for every other kind.
 */
function subscribeBinding(
  node: Element,
  name: string,
  source: ReadonlySignal<unknown>,
  kind: BindingKind,
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
      let previousKeys: readonly string[] = initialStyleKeys ?? [];
      const subscription = createBindingSubscription(source, whileAttached((value: unknown) => {
        previousKeys = applyStyle(node as HTMLElement, value, previousKeys);
      }));
      return { ...subscription, getStyleKeys: () => previousKeys };
    }
    case "select-value":
      return {
        ...bindSelectValue(node as HTMLSelectElement, source, whileAttached((value: unknown) => setControlledProp(node, "value", value))),
        getStyleKeys: undefined,
      };
    case "text-value":
      return {
        ...bindTextValue(node as HTMLInputElement | HTMLTextAreaElement, source, whileAttached((value: unknown) => setControlledProp(node, "value", value))),
        getStyleKeys: undefined,
      };
    case "checked":
      return { ...createBindingSubscription(source, whileAttached((value: unknown) => setControlledProp(node, name, value))), getStyleKeys: undefined };
    case "prop":
      return { ...createBindingSubscription(source, whileAttached((value: unknown) => setDomProp(node, name, value))), getStyleKeys: undefined };
  }
}

function mountBinding(node: Element, binding: Binding, binder: NodeBinder, initialStyleKeys?: readonly string[]): MountedBinding {
  const { dispose, refresh, getStyleKeys } = subscribeBinding(node, binding[0], binding[1], binding[2], initialStyleKeys, binder);
  return { binding, dispose, refresh, getStyleKeys };
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
    // Kept bindings may have skipped a write while detached.
    if (wasDetached) for (const binding of this.#mounted) binding.refresh();
    this.#sync(bindings);
    const userCleanup = applyRef(userRef, this.#node);
    return () => {
      if (typeof userCleanup === "function") userCleanup();
      else applyRef(userRef, null);
      // React detaches the old ref before attaching the new one, so a newer
      // attach can only exist here if this cleanup is stale.
      if (token !== this.#token) return;
      this.#detached = true;
      queueMicrotask(() => {
        if (this.#detached && token === this.#token) this.#dispose();
      });
    };
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
    // that set so its first write can still clear them.
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

function haveSameBindings(a: readonly Binding[], b: readonly Binding[]): boolean {
  return a.length === b.length && a.every((binding, index) => isSameBinding(binding, b[index]));
}

function getBindingRef(bindings: readonly Binding[], userRef: SupportedRef): (node: Element | null) => RefCleanup {
  // A user ref is an object or function, never one of the bound signals, so
  // the two kinds of key cannot collide in one map.
  const cacheKey: object = userRef ?? bindings[0]![1];
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
    if (isReactiveHostProp(name, value)) {
      bindings.push([name, value, resolveBindingKind(tagName, name)]);
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
  const bindings = isHtmlHost ? findHostBindings(inputProps, type) : [];

  const rawChildren = inputProps.children;
  const childrenNeedNormalization =
    "children" in inputProps && (isSignal(rawChildren) || Array.isArray(rawChildren));

  if (bindings.length === 0 && !childrenNeedNormalization) {
    return { props: inputProps, bindings };
  }

  // Something needs to change, so — and only so — a copy is made; the
  // original `inputProps` (and, transitively, whatever object the caller
  // passed as `input`) is never mutated.
  const props: HostProps = { ...inputProps };
  if (childrenNeedNormalization) {
    props.children = normalizeChild(rawChildren);
  }
  for (const [name, value, kind] of bindings) {
    // A two-way kind is only ever derived from a `value`/`checked` name (see
    // `resolveBindingKind`), so the lookup always hits; should it ever not, the
    // prop is written directly, which is the pre-substitution behaviour.
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
      props[uncontrolledName] = readInitialValue(value, kind);
    } else {
      props[name] = readInitialValue(value, kind);
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
type DirectSignalPropName = "title" | "id" | "className" | "hidden" | "disabled" | "style" | "value" | "checked";
type AriaPropName = `aria-${string}`;
type AddSignalChildren<P> = Omit<P, "children"> & {
  children?: SignalChild;
};
type SignalizeKnownHtmlProps<P> = {
  [Name in keyof P as Name extends DirectSignalPropName | AriaPropName ? Name : never]: Signalable<P[Name]>;
};
type AddHtmlSignalProps<P> = Omit<P, DirectSignalPropName | AriaPropName | "children"> & {
  [Name in keyof SignalizeKnownHtmlProps<P>]: SignalizeKnownHtmlProps<P>[Name];
} & {
  [name: `data-${string}`]: Signalable<string | number | boolean | undefined>;
} & AddSignalChildren<{}>;

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
    : AddHtmlSignalProps<React.JSX.IntrinsicElements[Tag]>;
};
