import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { createJsxFactory } from "../../runtime/jsx-shared.js";
import { transformLiteJsxProps } from "../../runtime/lite-jsx.js";
import type { AddSignalChildren, SignalChild } from "../../runtime/jsx-children.js";
import type * as React from "react";

export { Fragment };
export type { SignalChild };

/** JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx/lite"`. */
export const jsx = createJsxFactory(reactJsx, transformLiteJsxProps);

/** Static-children JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx/lite"`. */
export const jsxs = createJsxFactory(reactJsxs, transformLiteJsxProps);

type LiteIntrinsicElements = {
  [Tag in keyof React.JSX.IntrinsicElements]: AddSignalChildren<React.JSX.IntrinsicElements[Tag]>;
};

/** JSX types for the opt-in Signal-children-only runtime. */
export namespace JSX {
  export type ElementType = React.JSX.ElementType;
  export interface Element extends React.JSX.Element {}
  export interface ElementClass extends React.JSX.ElementClass {}
  export interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  export interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
  export type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  export interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  export interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  export interface IntrinsicElements extends LiteIntrinsicElements {}
}
