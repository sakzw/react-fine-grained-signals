/**
 * The classic `createElement` and `Fragment` that JSX compilers fall back to
 * (for example `<div {...props} key="k" />` under
 * `jsxImportSource: "react-fine-grained-signals/jsx"`). `createElement` is
 * not meant to be called directly; it carries the same signal bindings as the
 * JSX runtime.
 */
export { Fragment } from "react/jsx-runtime";
export type { JSX } from "./runtime/jsx.js";
export type { SignalChild } from "./runtime/jsx-children.js";
export { createSignalAwareElement as createElement } from "./runtime/jsx.js";
