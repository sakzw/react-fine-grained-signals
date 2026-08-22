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
    const stop = bindings.map(([name, source]) => effect(() => {
      setDomProp(node, name, source.value);
    }));

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
        props[name] = readInitialValue(value);
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
type DirectSignalPropName = "title" | "id" | "className" | "hidden" | "disabled";
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
