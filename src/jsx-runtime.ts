import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { createJsxWrapper } from "./runtime/jsx.js";

export { Fragment };
export type { JSX } from "./runtime/jsx.js";

/** JSX factory for `jsxImportSource: "react-alien-signals"`. */
export const jsx = createJsxWrapper(reactJsx);

/** Static-children JSX factory for `jsxImportSource: "react-alien-signals"`. */
export const jsxs = createJsxWrapper(reactJsxs);
