import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { createJsxFactory } from "../runtime/jsx-shared.js";
import { transformJsxProps } from "../runtime/jsx.js";

export { Fragment };
export type { JSX } from "../runtime/jsx.js";

/** JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx"`. */
export const jsx = createJsxFactory(reactJsx, transformJsxProps);

/** Static-children JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx"`. */
export const jsxs = createJsxFactory(reactJsxs, transformJsxProps);
