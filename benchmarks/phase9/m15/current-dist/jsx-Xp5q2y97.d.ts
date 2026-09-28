import { t as ReadonlySignal } from "./base-Bx5ahfW2.js";
import * as React from "react";
//#region src/runtime/jsx.d.ts
declare const SVG_ELEMENTS: readonly ["svg", "animate", "animateMotion", "animateTransform", "circle", "clipPath", "defs", "desc", "ellipse", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "filter", "foreignObject", "g", "image", "line", "linearGradient", "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon", "polyline", "radialGradient", "rect", "set", "stop", "switch", "symbol", "text", "textPath", "tspan", "use", "view"];
type SvgElement = (typeof SVG_ELEMENTS)[number];
declare const MATHML_ELEMENTS: readonly ["annotation", "annotation-xml", "maction", "math", "merror", "mfrac", "mi", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom", "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "semantics"];
type MathMlElement = (typeof MATHML_ELEMENTS)[number];
type NonHtmlHostElement = SvgElement | MathMlElement;
type SignalChild = React.ReactNode | ReadonlySignal<SignalChild> | readonly SignalChild[];
type Signalable<T> = T | ReadonlySignal<T>;
type DirectSignalPropName = "title" | "id" | "className" | "hidden" | "disabled" | "style" | "value" | "checked";
type AriaPropName = `aria-${string}`;
type AddSignalChildren<P> = Omit<P, "children"> & {
  children?: SignalChild;
};
type SignalizeKnownHtmlProps<P> = { [Name in keyof P as Name extends DirectSignalPropName | AriaPropName ? Name : never]: Signalable<P[Name]>; };
type AddHtmlSignalProps<P> = Omit<P, DirectSignalPropName | AriaPropName | "children"> & { [Name in keyof SignalizeKnownHtmlProps<P>]: SignalizeKnownHtmlProps<P>[Name]; } & {
  [name: `data-${string}`]: Signalable<string | number | boolean | undefined>;
} & AddSignalChildren<{}>;
/** Types exposed by `jsxImportSource: "react-fine-grained-signals"`. */
declare namespace JSX {
  type ElementType = React.JSX.ElementType;
  interface Element extends React.JSX.Element {}
  interface ElementClass extends React.JSX.ElementClass {}
  interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  type IntrinsicElements = { [Tag in keyof React.JSX.IntrinsicElements]: Tag extends NonHtmlHostElement ? AddSignalChildren<React.JSX.IntrinsicElements[Tag]> : AddHtmlSignalProps<React.JSX.IntrinsicElements[Tag]>; };
}
//#endregion
export { JSX as t };
