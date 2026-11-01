import { Fragment } from "react/jsx-dev-runtime";
import { createJsxDEV } from "../../runtime/jsx-dev.js";
import { transformLiteJsxProps } from "../../runtime/lite-jsx.js";

export { Fragment };
export type { JSX } from "./jsx-runtime.js";

/** Development JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx/lite"`. */
export const jsxDEV = createJsxDEV(transformLiteJsxProps);
