import { Fragment } from "react/jsx-dev-runtime";
import { createJsxDEV } from "../runtime/jsx-dev.js";
import { transformJsxProps } from "../runtime/jsx.js";

export { Fragment };
export type { JSX } from "../runtime/jsx.js";

/** Development JSX factory for `jsxImportSource: "react-fine-grained-signals/jsx"`. */
export const jsxDEV = createJsxDEV(transformJsxProps);
