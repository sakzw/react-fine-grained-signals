/** Classic JSX fallback for `jsxImportSource: "react-fine-grained-signals/jsx/lite"`. */
export { Fragment } from "react/jsx-runtime";
export type { JSX, SignalChild } from "./lite/jsx-runtime.js";
export { createLiteSignalAwareElement as createElement } from "../runtime/lite-jsx.js";
