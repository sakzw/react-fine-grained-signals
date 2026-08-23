import { effect, isSignal } from "../core/index.js";
import type { ReadonlySignal } from "../core/index.js";
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
  "tabSize", "widows", "zIndex", "zoom",
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
type Binding = readonly [name: string, source: ReadonlySignal<unknown>];
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
  const stopEffect = effect(() => {
    setControlledProp(select, "value", source.value);
  });
  const observer = new MutationObserver(() => {
    setControlledProp(select, "value", source.peek());
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

  const stopEffect = effect(() => {
    const next = source.value;
    if (composing) {
      hasPending = true;
      pending = next;
      return;
    }
    setControlledProp(node, "value", next);
  });

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

/**
 * React 19 callback refs may return a cleanup function.  The wrapper preserves
 * that contract and also tears down all signal subscriptions during StrictMode
 * ref replay and ordinary unmount.
 */
function createReactiveRef(bindings: readonly Binding[], userRef: SupportedRef) {
  let activeCleanup: (() => void) | undefined;

  const disposeActive = () => {
    const cleanup = activeCleanup;
    activeCleanup = undefined;
    cleanup?.();
  };

  return (node: Element | null): RefCleanup => {
    // React 18 clears callback refs with `null`, while React 19 can invoke the
    // returned cleanup.  A node replacement can use either order, so every
    // entry point first disposes whichever subscription is currently active.
    disposeActive();

    if (node == null) {
      return;
    }

    const userCleanup = applyRef(userRef, node);
    const stop = bindings.map(([name, source]) => {
      if (name === "style") {
        let previousKeys: readonly string[] = [];
        return effect(() => {
          previousKeys = applyStyle(node as HTMLElement, source.value, previousKeys);
        });
      }
      if (isControlledTwoWayProp(node.tagName.toLowerCase(), name)) {
        if (name === "value") {
          if (node.tagName === "SELECT") {
            return bindSelectValue(node as HTMLSelectElement, source);
          }
          return bindTextValue(node as HTMLInputElement | HTMLTextAreaElement, source);
        }
        return effect(() => {
          setControlledProp(node, name, source.value);
        });
      }
      return effect(() => {
        setDomProp(node, name, source.value);
      });
    });

    let isDisposed = false;
    const cleanup = () => {
      if (isDisposed) return;
      isDisposed = true;
      if (activeCleanup === cleanup) activeCleanup = undefined;
      for (const dispose of stop) dispose();
      if (typeof userCleanup === "function") userCleanup();
      else applyRef(userRef, null);
    };

    activeCleanup = cleanup;
    return cleanup;
  };
}

/** A host element with DOM-only signal subscriptions attached via its ref. */
export function ReactiveHost({
  elementType,
  props,
  bindings,
}: {
  elementType: string;
  props: HostProps;
  bindings: readonly Binding[];
}): React.ReactElement {
  const { ref: userRef, ...hostProps } = props;
  return createElement(elementType, {
    ...hostProps,
    ref: createReactiveRef(bindings, userRef as SupportedRef),
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
        bindings.push([name, value]);
        if (isControlledTwoWayProp(type as string, name)) {
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
      return factory(ReactiveHost, { elementType: type, props, bindings }, key);
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

/** Types exposed by `jsxImportSource: "react-alien-signals"`. */
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
