import { effect, isSignal } from "../core/index.js";
import type { ReadonlySignal } from "../core/index.js";
import { useSignalValue } from "../react/hooks.js";
import { createElement, Fragment, useLayoutEffect, useRef } from "react";
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
 * `transformProps`, from the JSX tag string that is already on hand at
 * element-creation time — `"select"` needs `bindSelectValue`'s MutationObserver
 * workaround, `"input"`/`"textarea"` need `bindTextValue`'s IME handling, and
 * `<input checked>` is the only other two-way case — so `mountBinding` later
 * only has to dispatch on this already-known value instead of re-deriving the
 * same facts from the mounted DOM node's `tagName`. It is also half of a
 * binding's identity for `createReactiveHostBinder`'s re-render diff.
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
// signal snapshot over what the direct-binding effect just wrote.
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
const NON_HTML_HOST_ELEMENTS = new Set<string>([...SVG_ELEMENTS, ...MATHML_ELEMENTS]);

type SignalChild = React.ReactNode | ReadonlySignal<SignalChild> | readonly SignalChild[];
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
    return value.map(normalizeChild);
  }

  return value as React.ReactNode;
}

function isReactiveHostProp(name: string, value: unknown): value is ReadonlySignal<unknown> {
  if (!isSignal(value)) return false;
  return REACTIVE_PROP_NAMES.has(name) || name.startsWith("data-") || name.startsWith("aria-");
}

function readInitialValue(source: ReadonlySignal<unknown>): unknown {
  return source.peek();
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
 * the module doc: these write straight to the DOM from an `effect()` installed
 * alongside the element's ref, bypassing React's render, so the owning
 * component never re-renders). A `computed()` whose getter throws caches and
 * rethrows that error on every read (see `computed()` in src/core/base.ts) —
 * if `source` is such a computed and it starts failing after the binding is
 * already mounted, an unguarded read here would throw synchronously out of
 * `effect()`'s callback body. Nothing catches that: not `effect()`, not
 * alien-signals' `run()`, not its `flush()`. It would propagate out of
 * whatever write triggered it (an event handler, anywhere), and `flush()`'s
 * own `finally` would mark any other effect still queued in that same flush as
 * skipped for this cycle — an unrelated binding, or a `useSignals()`-tracked
 * component's commit, silently missing one update.
 *
 * Catching here keeps a failure local to this one binding: the DOM write for
 * this cycle is skipped (the DOM is left at its last successful value) and
 * the failure is reported with `console.error(message, { cause: error })` —
 * assert against `mock.calls[i][1].cause` in tests. This is the first
 * `console.*` call in this codebase, and intentionally so: a direct binding
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
 * one that isn't itself an `effect()` — the MutationObserver-triggered
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
 * The common case built on `applyBoundSignal`: subscribe to `source.value`
 * inside an `effect()` and re-run `apply` whenever it changes. Centralizes
 * the pattern that used to be hand-rolled at each binding site — declare an
 * `episode`, then `effect(() => { const read = readBoundSignal(...); if
 * (!read.ok) return; <apply the value> })` — so the read-and-skip contract
 * can't drift between sites. An `episode` may be passed in to share a
 * failure latch with a sibling read site (see `bindSelectValue`); otherwise
 * each binding gets its own.
 */
function createBindingEffect<T>(
  source: ReadonlySignal<T>,
  apply: (value: T) => void,
  episode: FailureEpisode = { hasReported: false },
): () => void {
  return effect(() => applyBoundSignal(() => source.value, apply, episode));
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
      (node as HTMLElement).hidden = Boolean(value);
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
 * write when it already holds the value being written. Effects re-run on
 * every keystroke (the signal changed because `onChange` just wrote it), so
 * without this guard every keystroke would re-set a property the DOM already
 * has, moving the caret and disrupting IME composition for no reason.
 */
function setControlledProp(node: Element, name: string, value: unknown): void {
  if (name === "value") {
    const select = node as HTMLSelectElement;
    if (select.tagName === "SELECT" && select.multiple) {
      setMultiSelectValue(select, value);
      return;
    }
    const next = value == null ? "" : String(value);
    const input = node as HTMLInputElement | HTMLTextAreaElement;
    if (input.value !== next) input.value = next;
    return;
  }
  const next = Boolean(value);
  const input = node as HTMLInputElement;
  if (input.checked !== next) input.checked = next;
}

/**
 * `<select multiple>` does not support assigning `.value` directly — the DOM
 * setter only ever selects a single option, silently corrupting the
 * selection instead of erroring. Its documented API for a multi-value select
 * is per-`<option>` `.selected`, so an array-valued signal (React's own
 * typing for a multi-select) is applied that way instead.
 */
function setMultiSelectValue(select: HTMLSelectElement, value: unknown): void {
  const values = new Set(
    Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)],
  );
  for (const option of select.options) {
    const selected = values.has(option.value);
    if (option.selected !== selected) option.selected = selected;
  }
}

/**
 * A `<select>` whose matching `<option>` does not exist yet (for example when
 * the options themselves are rendered from a signal or other state, mounted
 * after this one) silently ends up with nothing selected: the DOM neither
 * errors nor retroactively applies `.value`/`.selected` once a matching
 * `<option>` is later added. The per-value effect below only reruns when the
 * bound signal itself changes, so it cannot see that the option list changed
 * out from under it. A MutationObserver on the select's subtree re-applies
 * the signal's current value whenever its `<option>` list changes, closing
 * that gap without requiring the signal to change too.
 */
function bindSelectValue(select: HTMLSelectElement, source: ReadonlySignal<unknown>): () => void {
  // Shared by both read sites below: an effect-triggered failure and a
  // MutationObserver-triggered failure are the same underlying computed
  // erroring, so they report as one episode, not two.
  const episode: FailureEpisode = { hasReported: false };
  const apply = (value: unknown) => setControlledProp(select, "value", value);
  const stopEffect = createBindingEffect(source, apply, episode);
  const observer = new MutationObserver(() => {
    applyBoundSignal(() => source.peek(), apply, episode);
  });
  observer.observe(select, { childList: true, subtree: true });
  return () => {
    stopEffect();
    observer.disconnect();
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
function bindTextValue(node: HTMLInputElement | HTMLTextAreaElement, source: ReadonlySignal<unknown>): () => void {
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
      setControlledProp(node, "value", pending);
    }
  };

  node.addEventListener("compositionstart", onCompositionStart);
  node.addEventListener("compositionend", onCompositionEnd);

  // A failed read must bail out before this touches `pending`/`hasPending` —
  // a stale or garbage value must never latch in. `createBindingEffect`
  // already skips `apply` on a failed read, so that guard lives there once.
  const stopEffect = createBindingEffect(source, (next) => {
    if (composing) {
      hasPending = true;
      pending = next;
      return;
    }
    setControlledProp(node, "value", next);
  }, episode);

  return () => {
    stopEffect();
    node.removeEventListener("compositionstart", onCompositionStart);
    node.removeEventListener("compositionend", onCompositionEnd);
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
 * are themselves signals is out of scope (see docs/direct-binding-value-checked-style.md).
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

/** One live binding: the tuple it was mounted from, plus its teardown. */
type MountedBinding = { readonly binding: Binding; readonly dispose: () => void };

/** A binding's identity for the re-render diff: same name, source, and kind. */
function isSameBinding(a: Binding, b: Binding): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Subscribes a single binding to `node` and returns its teardown. Split out of
 * the ref callback so `createReactiveHostBinder` can rebuild one binding on
 * its own, without disturbing the siblings that did not change.
 */
function subscribeBinding(
  node: Element,
  name: string,
  source: ReadonlySignal<unknown>,
  kind: BindingKind,
): () => void {
  switch (kind) {
    case "style": {
      let previousKeys: readonly string[] = [];
      return createBindingEffect(source, (value) => {
        previousKeys = applyStyle(node as HTMLElement, value, previousKeys);
      });
    }
    case "select-value":
      return bindSelectValue(node as HTMLSelectElement, source);
    case "text-value":
      return bindTextValue(node as HTMLInputElement | HTMLTextAreaElement, source);
    case "checked":
      return createBindingEffect(source, (value) => setControlledProp(node, name, value));
    case "prop":
      return createBindingEffect(source, (value) => setDomProp(node, name, value));
  }
}

function mountBinding(node: Element, binding: Binding): MountedBinding {
  return { binding, dispose: subscribeBinding(node, binding[0], binding[1], binding[2]) };
}

type ReactiveHostBinder = {
  /** The one callback-ref identity React ever sees for this element. */
  readonly ref: (node: Element | null) => RefCleanup;
  /** Reconciles the attached node against the latest rendered inputs. */
  sync(bindings: readonly Binding[], userRef: SupportedRef): void;
};

/**
 * Owns everything one mounted `ReactiveHost` attaches to its DOM node: the
 * user's own ref, plus one live subscription per binding.
 *
 * The ref callback is created once per binder, and a binder is created once
 * per mounted `ReactiveHost`, so React only ever sees a single ref identity
 * for the lifetime of that element. That is load-bearing: React responds to a
 * *changed* callback-ref identity by detaching the old ref and attaching the
 * new one on the very same, unchanged DOM node. While the ref closure was
 * rebuilt on every render — which it was, since `transformProps` hands
 * `ReactiveHost` a freshly allocated `bindings` array each time — every
 * unrelated re-render of the owning component (any state, context, or parent
 * update anywhere above this element) silently disconnected and recreated
 * `bindSelectValue`'s `MutationObserver`, removed and re-added
 * `bindTextValue`'s composition listeners *along with the closure-local
 * `composing`/`pending` state they guard* — resetting `composing` to `false`
 * mid-composition and letting the next write stomp in-flight IME input —
 * resubscribed every binding's `effect()`, and called the user's own ref with
 * `null` and then the identical node again.
 *
 * Pinning the identity moves that reconciliation here: `sync` runs from
 * `ReactiveHost`'s layout effect after every commit and diffs the render's
 * bindings against the mounted ones by `(name, source, kind)`, tearing down
 * and rebuilding only the entries that actually changed. What is left in the
 * ref callback is exactly the part React's attach/detach protocol has to
 * drive: which node is current, and full teardown when there no longer is one.
 *
 * The split is safe because of how React orders a commit. A host element's ref
 * is attached during the layout phase *before* the layout effects of the
 * component that rendered it, so `sync` always finds the node already
 * attached; and a ref is only ever (re)attached on a fiber React re-rendered,
 * which is also the only way `ReactiveHost`'s dependency-less layout effect
 * can fail to re-run — so no attach can slip past a `sync`.
 */
function createReactiveHostBinder(): ReactiveHostBinder {
  let node: Element | null = null;
  let mounted: MountedBinding[] = [];
  let attachedUserRef: SupportedRef;
  let userCleanup: RefCleanup;
  let activeCleanup: (() => void) | undefined;

  const attachUserRef = (target: Element, userRef: SupportedRef): void => {
    attachedUserRef = userRef;
    userCleanup = applyRef(userRef, target);
  };

  // React 19 callback refs may return a cleanup function; a user ref that did
  // is torn down through it instead of through the `null` call React 18 used.
  const detachUserRef = (): void => {
    const cleanup = userCleanup;
    const detached = attachedUserRef;
    userCleanup = undefined;
    attachedUserRef = undefined;
    if (typeof cleanup === "function") cleanup();
    else applyRef(detached, null);
  };

  const disposeActive = (): void => {
    const cleanup = activeCleanup;
    activeCleanup = undefined;
    cleanup?.();
  };

  const ref = (target: Element | null): RefCleanup => {
    // React 18 clears callback refs with `null`, while React 19 can invoke the
    // returned cleanup.  A node replacement can use either order, so every
    // entry point first disposes whichever node is currently attached.
    disposeActive();

    if (target == null) {
      return;
    }

    node = target;

    let isDisposed = false;
    const cleanup = () => {
      if (isDisposed) return;
      isDisposed = true;
      if (activeCleanup === cleanup) activeCleanup = undefined;
      for (const binding of mounted) binding.dispose();
      mounted = [];
      detachUserRef();
      node = null;
    };

    activeCleanup = cleanup;
    return cleanup;
  };

  const syncBindings = (target: Element, bindings: readonly Binding[]): void => {
    // The overwhelmingly common case — a re-render that changed nothing about
    // the bindings — costs one walk and allocates nothing.
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

    // Everything stale is disposed before anything replacing it is mounted, so
    // a rebuilt binding never briefly holds two live subscriptions on one node.
    for (const stale of reusable.values()) stale.dispose();
    mounted = bindings.map((binding, index) => reused[index] ?? mountBinding(target, binding));
  };

  return {
    ref,
    sync(bindings, userRef) {
      const target = node;
      if (target == null) return;
      if (userRef !== attachedUserRef) {
        detachUserRef();
        attachUserRef(target, userRef);
      }
      syncBindings(target, bindings);
    },
  };
}

/**
 * Hands `ReactiveHost` its one stable ref callback and drives the binder's
 * post-commit reconciliation.
 *
 * The layout effect deliberately declares no dependency array and returns no
 * cleanup: it must run after every commit (that is what makes it impossible
 * for a ref attach to happen without a following `sync`), and its teardown
 * belongs to the ref callback, which React already invokes on unmount, on
 * node replacement, and on StrictMode's ref replay. Giving it a cleanup here
 * would tear the whole element down again on every re-render — precisely the
 * churn this exists to remove.
 */
function useReactiveHostBinder(
  bindings: readonly Binding[],
  userRef: SupportedRef,
): (node: Element | null) => RefCleanup {
  const binderRef = useRef<ReactiveHostBinder | undefined>(undefined);
  if (binderRef.current === undefined) {
    binderRef.current = createReactiveHostBinder();
  }
  const binder = binderRef.current;
  useLayoutEffect(() => {
    binder.sync(bindings, userRef);
  });
  return binder.ref;
}

/**
 * A host element with DOM-only signal subscriptions attached via its ref.
 *
 * The subscriptions themselves are owned by a per-instance binder
 * (`useReactiveHostBinder`) rather than rebuilt inline here, so this
 * component's ref prop keeps one identity for the element's whole lifetime
 * and an unrelated re-render costs nothing — see `createReactiveHostBinder`.
 *
 * `children` arrives as ReactiveHost's own top-level prop (see
 * `createJsxWrapper` below) rather than folded into `props`/`hostProps`,
 * purely so the *outer* `factory(ReactiveHost, { ..., children }, key)` call
 * that constructs this element — the very same real `jsx`/`jsxs`/`jsxDEV`
 * that would have validated the original host element's children had this
 * wrapper not intercepted it — runs React's dev-mode key validation on it.
 * That validation is a flag React stamps onto each child element itself
 * (`element._store.validated`), not onto the array or onto whichever
 * component currently holds it, so it survives being read back out of props
 * here and re-embedded via `createElement` below. Skip this indirection —
 * i.e. leave `children` folded into `hostProps` before any real jsx/jsxs call
 * ever sees it — and a signal-bound host element with 2+ static, unkeyed JSX
 * children spuriously trips React's "missing key" warning: `createElement`'s
 * children-as-prop path never validates children (only its children-as-rest-
 * args path does), and neither did the `factory(ReactiveHost, ...)` call
 * itself, since `children` wasn't its own prop at that call site.
 */
export function ReactiveHost({
  elementType,
  props,
  bindings,
  children,
}: {
  elementType: string;
  props: HostProps;
  bindings: readonly Binding[];
  children?: React.ReactNode;
}): React.ReactElement {
  const { ref: userRef, ...hostProps } = props;
  const ref = useReactiveHostBinder(bindings, userRef as SupportedRef);
  return createElement(elementType, {
    ...hostProps,
    // `elementType` is a runtime string, so this can't be written as JSX; the
    // lint rule assumes a literal `<Foo children={x}/>` authoring mistake,
    // which doesn't apply to a dynamic-host-element createElement call.
    // oxlint-disable-next-line react/no-children-prop
    children,
    ref,
  });
}

type CreateElement = (type: React.ElementType, props: unknown, key?: React.Key) => React.ReactElement;

function transformProps(type: React.ElementType, input: unknown): { props: HostProps; bindings: Binding[] } {
  const props: HostProps = { ...(input as HostProps | null) };
  const isHtmlHost = typeof type === "string" && !NON_HTML_HOST_ELEMENTS.has(type);
  const isFragment = type === Fragment;
  // User components receive all props, including `children`, exactly as their
  // caller passed them. Native host elements (including SVG) and fragments opt
  // into signal-child normalization, while direct prop bindings remain HTML-only.
  if ((typeof type === "string" || isFragment) && "children" in props) {
    props.children = normalizeChild(props.children);
  }

  const bindings: Binding[] = [];
  if (isHtmlHost) {
    for (const [name, value] of Object.entries(props)) {
      if (isReactiveHostProp(name, value)) {
        const kind = resolveBindingKind(type as string, name);
        bindings.push([name, value, kind]);
        if (isTwoWayBindingKind(kind)) {
          // Leaving the controlled prop in place would keep the element
          // React-controlled, so an unrelated re-render of the owner would
          // re-diff and potentially re-write this prop — work relying on an
          // internal React guard (skipping a same-value write) rather than a
          // documented one. Substituting the uncontrolled prop instead means
          // React only ever reads it once, at mount, and never touches this
          // property again — see docs/direct-binding-value-checked-style.md.
          delete props[name];
          props[UNCONTROLLED_PROP_NAMES[name]] = readInitialValue(value);
        } else {
          props[name] = readInitialValue(value);
        }
      }
    }
  }

  return { props, bindings };
}

/** Creates a JSX wrapper while letting each module supply React's JSX factory. */
export function createJsxWrapper(factory: CreateElement): CreateElement {
  return (type, input, key) => {
    const { props, bindings } = transformProps(type, input);
    if (typeof type === "string" && bindings.length > 0) {
      // `children` is lifted out to be `factory`'s own top-level prop (see
      // the comment on ReactiveHost) instead of staying nested inside
      // `props`, so `factory` — the real jsx/jsxs/jsxDEV already correctly
      // wired to know whether this call site's children are a static JSX
      // list — validates them exactly as it would have for the
      // un-intercepted host element.
      const { children, ...hostProps } = props;
      return factory(ReactiveHost, { elementType: type, props: hostProps, bindings, children }, key);
    }
    return factory(type, props, key);
  };
}

type Signalable<T> = T | ReadonlySignal<T>;
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
  export type IntrinsicElements = {
    [Tag in keyof React.JSX.IntrinsicElements]: Tag extends NonHtmlHostElement
      ? AddSignalChildren<React.JSX.IntrinsicElements[Tag]>
      : AddHtmlSignalProps<React.JSX.IntrinsicElements[Tag]>;
  };
}
